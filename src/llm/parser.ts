import {
  type ConsideredAndRejectedItem,
  type DeletionProposedItem,
  type EpistemicState,
  type EvidenceMechanism,
  type FindingType,
  type LensFindingsOutput,
  LensFindingsOutputSchema,
  type MergeRisk,
  type OpenQuestionItem,
  type Severity,
  type WalkthroughChangeEntry,
  type WalkthroughReport,
  WalkthroughReportSchema,
} from "../domain/models.ts";

export class LensOutputParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LensOutputParseError";
  }
}

export function extractJsonObject(rawText: string): unknown {
  const trimmed = rawText.trim();

  // 1. Try direct JSON parse first
  try {
    const direct: unknown = JSON.parse(trimmed);
    if (typeof direct === "object" && direct !== null) {
      return direct;
    }
  } catch {
    // Continue to fenced block extraction
  }

  // 2. Try ```json ... ``` or ``` ... ``` fenced code block
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of trimmed.matchAll(fenceRegex)) {
    const candidate = match[1]?.trim();
    if (!candidate) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === "object" && parsed !== null) {
        return parsed;
      }
    } catch {
      // Continue searching
    }
  }

  // 3. Try outermost { ... } substring
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const slice = trimmed.slice(firstBrace, lastBrace + 1);
    try {
      const parsed: unknown = JSON.parse(slice);
      if (typeof parsed === "object" && parsed !== null) {
        return parsed;
      }
    } catch {
      // Fall through
    }
  }

  throw new LensOutputParseError(
    `Failed to extract valid JSON object from lens response: ${trimmed.slice(0, 200)}`,
  );
}

function tryExtractJsonObject(rawText: string): unknown | null {
  try {
    return extractJsonObject(rawText);
  } catch {
    return null;
  }
}

function stripBackticksAndQuotes(val: string): string {
  return val
    .trim()
    .replace(/^`+|`+$/g, "")
    .replace(/^"+|"+$/g, "")
    .trim();
}

function normalizeSeverity(raw: string | undefined): Severity {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "critical" || v === "blocker" || v === "p0") return "Critical";
  if (v === "major" || v === "high" || v === "error" || v === "p1") return "Major";
  if (v === "minor" || v === "medium" || v === "warning" || v === "warn" || v === "p2") {
    return "Minor";
  }
  if (v === "trivial" || v === "low" || v === "nit" || v === "nitpick" || v === "p3") {
    return "Trivial";
  }
  if (v === "info" || v === "note") return "Info";
  if (v === "none") return "None";
  return "Minor";
}

function normalizeFindingType(raw: string | undefined): FindingType {
  const v = (raw ?? "").trim().toLowerCase();
  if (v.includes("sound") || v.includes("unsafe") || v.includes("memory")) return "Soundness";
  if (v.includes("concur") || v.includes("async") || v.includes("race") || v.includes("deadlock")) {
    return "Concurrency";
  }
  if (v.includes("sec") || v.includes("vuln") || v.includes("auth")) return "Security";
  if (v.includes("perf") || v.includes("alloc") || v.includes("latency")) return "Performance";
  if (v.includes("idiom") || v.includes("style") || v.includes("lint")) return "Idioms";
  if (v.includes("refactor") || v.includes("arch") || v.includes("design") || v.includes("clean")) {
    return "Refactor";
  }
  return "Bug";
}

function normalizeEpistemicState(raw: string | undefined): EpistemicState {
  const v = (raw ?? "")
    .trim()
    .toUpperCase()
    .replace(/[_\s]+/g, "-");
  if (v === "NEEDS-RUNTIME-VERIFICATION") return "NEEDS-RUNTIME-VERIFICATION";
  if (v === "DESIGN-CONCERN") return "DESIGN-CONCERN";
  if (v === "SYMPTOM-PATCH") return "SYMPTOM-PATCH";
  return "VERIFIED-DEFECT";
}

function normalizeEvidenceMechanism(raw: string | undefined): EvidenceMechanism {
  const v = (raw ?? "").trim().toLowerCase();
  if (v.includes("concur")) return "Concurrency";
  if (v.includes("sec")) return "Security";
  if (v.includes("perf")) return "Performance";
  if (v.includes("design") || v.includes("arch")) return "Design";
  return "Correctness";
}

function normalizeMergeRisk(raw: string | undefined): MergeRisk {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "minimal") return "Minimal";
  if (v === "low") return "Low";
  if (v === "high") return "High";
  if (v === "critical") return "Critical";
  return "Medium";
}

function splitTopLevelSections(markdown: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let currentKey: string | null = null;
  let buffer: string[] = [];
  let inFence = false;

  const flush = () => {
    if (currentKey !== null) {
      const prev = sections.get(currentKey);
      const next = buffer.join("\n").trim();
      sections.set(currentKey, prev ? `${prev}\n\n${next}` : next);
    }
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      buffer.push(line);
      continue;
    }
    if (!inFence) {
      const headingMatch = /^#{1,2}\s+(?:\d+\.\s*)?([A-Za-z0-9 _&/-]+?)\s*$/.exec(line);
      if (headingMatch?.[1]) {
        const normalizedKey = headingMatch[1]
          .trim()
          .toUpperCase()
          .replace(/[\s&-]+/g, "_");
        flush();
        currentKey = normalizedKey;
        buffer = [];
        continue;
      }
    }
    buffer.push(line);
  }
  flush();
  return sections;
}

function parseKeyValueLines(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match =
      /^\s*(?:[-*]\s+)?(?:\*\*)?([a-zA-Z0-9_ -]+?)(?::\*\*|\*\*\s*:|\s*:)\s*(.+?)\s*$/.exec(line);
    if (match?.[1] && match[2] !== undefined) {
      const key = match[1]
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, "_");
      fields.set(key, match[2].trim());
    }
  }
  return fields;
}

function extractFirstCodeFenceVerbatim(text: string): string | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i] ?? "")) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) {
    return null;
  }
  const codeLines: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*```\s*$/.test(line)) {
      const joined = codeLines.join("\n");
      return joined.trim().length > 0 ? joined : null;
    }
    codeLines.push(line);
  }
  return null;
}

function parseLineRange(
  rawLines: string | undefined,
  rawStart: string | undefined,
  rawEnd: string | undefined,
): { startLine: number; endLine: number } | null {
  if (rawLines) {
    const rangeMatch = /L?(\d+)\s*(?:-|\.\.|to)\s*L?(\d+)/i.exec(rawLines);
    if (rangeMatch?.[1] && rangeMatch[2]) {
      const a = Number.parseInt(rangeMatch[1], 10);
      const b = Number.parseInt(rangeMatch[2], 10);
      if (Number.isInteger(a) && Number.isInteger(b) && a >= 1 && b >= 1) {
        return { startLine: Math.min(a, b), endLine: Math.max(a, b) };
      }
    }
    const singleMatch = /L?(\d+)/i.exec(rawLines);
    if (singleMatch?.[1]) {
      const a = Number.parseInt(singleMatch[1], 10);
      if (Number.isInteger(a) && a >= 1) {
        return { startLine: a, endLine: a };
      }
    }
  }
  if (rawStart) {
    const a = Number.parseInt(rawStart.replace(/^L/i, ""), 10);
    const b = rawEnd ? Number.parseInt(rawEnd.replace(/^L/i, ""), 10) : a;
    if (Number.isInteger(a) && Number.isInteger(b) && a >= 1 && b >= 1) {
      return { startLine: Math.min(a, b), endLine: Math.max(a, b) };
    }
  }
  return null;
}

function parsePipeBulletTriples(sectionText: string | undefined): Array<[string, string, string]> {
  if (!sectionText) {
    return [];
  }
  const results: Array<[string, string, string]> = [];
  for (const rawLine of sectionText.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed || /^(?:none|n\/a|-?\s*none\.?)$/i.test(trimmed)) {
      continue;
    }
    const withoutBullet = trimmed.replace(/^[-*]\s+/, "").replace(/^\|\s*|\s*\|$/g, "");
    // Skip markdown table header separator rows
    if (/^[:\-\s|]+$/.test(withoutBullet)) {
      continue;
    }
    const parts = withoutBullet.split("|").map((p) => stripBackticksAndQuotes(p));
    if (parts.length >= 3 && parts[0] && parts[1] && parts[2]) {
      if (
        parts[0].toLowerCase() === "location" ||
        parts[0].toLowerCase().includes("symbol / path")
      ) {
        continue;
      }
      results.push([parts[0], parts[1], parts.slice(2).join(" | ")]);
    }
  }
  return results;
}

function parseSingleFindingBlock(blockText: string): LensFindingsOutput["findings"][number] | null {
  // Split block into header metadata and #### sub-sections (respecting code fences)
  const lines = blockText.replace(/\r\n/g, "\n").split("\n");
  const subSections = new Map<string, string>();
  let currentSub = "__HEADER__";
  let buf: string[] = [];
  let inFence = false;

  const flush = () => {
    subSections.set(currentSub, buf.join("\n"));
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      buf.push(line);
      continue;
    }
    if (!inFence) {
      const subMatch = /^####\s+([A-Za-z0-9 _-]+?)\s*$/.exec(line);
      if (subMatch?.[1]) {
        flush();
        currentSub = subMatch[1]
          .trim()
          .toUpperCase()
          .replace(/[\s-]+/g, "_");
        buf = [];
        continue;
      }
    }
    buf.push(line);
  }
  flush();

  const meta = parseKeyValueLines(subSections.get("__HEADER__") ?? "");
  const rawLocation = meta.get("location");
  let rawFile = meta.get("file") ?? meta.get("filepath") ?? meta.get("file_path");
  let rawLines = meta.get("lines") ?? meta.get("line");
  if (!rawFile && rawLocation) {
    const locClean = stripBackticksAndQuotes(rawLocation);
    const locMatch = /^(.+?):L?(\d+(?:\s*(?:-|\.\.)\s*L?\d+)?)$/.exec(locClean);
    if (locMatch?.[1] && locMatch[2]) {
      rawFile = locMatch[1];
      rawLines = rawLines ?? locMatch[2];
    }
  }
  if (!rawFile) {
    return null;
  }
  const filePath = stripBackticksAndQuotes(rawFile)
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/:\d+(?:-\d+)?$/, "");
  if (!filePath) {
    return null;
  }

  const lineRange = parseLineRange(
    rawLines,
    meta.get("start_line") ?? meta.get("startline"),
    meta.get("end_line") ?? meta.get("endline"),
  );
  if (!lineRange) {
    return null;
  }

  const title = stripBackticksAndQuotes(meta.get("title") ?? "");
  const explanation = (
    subSections.get("EXPLANATION") ??
    subSections.get("BODY") ??
    subSections.get("DETAILS") ??
    meta.get("body") ??
    ""
  ).trim();

  if (!title && !explanation) {
    return null;
  }

  const suggestionSection = subSections.get("SUGGESTION") ?? "";
  const suggestion = extractFirstCodeFenceVerbatim(suggestionSection);

  const agentPromptSection = (
    subSections.get("AGENT_PROMPT") ??
    subSections.get("PROMPT_FOR_CODING_AGENTS") ??
    ""
  ).trim();
  const agentPrompt =
    agentPromptSection ||
    `Fix ${title || "this issue"} in \`${filePath}\` lines ${lineRange.startLine}-${lineRange.endLine}: ${explanation.slice(0, 240)}`;

  const rawConf = Number.parseFloat(meta.get("confidence") ?? "0.9");
  const confidence = Number.isFinite(rawConf) ? Math.max(0, Math.min(1, rawConf)) : 0.9;

  const rawDepends = meta.get("depends_on") ?? meta.get("dependson") ?? "";
  const dependsOn =
    !rawDepends || /^(?:none|null|n\/a|-|—)$/i.test(rawDepends)
      ? null
      : stripBackticksAndQuotes(rawDepends);

  const rawRev = (meta.get("reversible") ?? "true").toLowerCase();
  const reversible = rawRev !== "false" && rawRev !== "no";

  return {
    filePath,
    startLine: lineRange.startLine,
    endLine: lineRange.endLine,
    severity: normalizeSeverity(meta.get("severity")),
    type: normalizeFindingType(meta.get("type")),
    epistemicState: normalizeEpistemicState(meta.get("state") ?? meta.get("epistemic_state")),
    evidenceMechanism: normalizeEvidenceMechanism(
      meta.get("mechanism") ?? meta.get("evidence_mechanism"),
    ),
    title: title || explanation.split("\n")[0]?.slice(0, 100) || "Rust review finding",
    body: explanation || title,
    rootCause: stripBackticksAndQuotes(meta.get("root_cause") ?? meta.get("rootcause") ?? title),
    blastRadius: stripBackticksAndQuotes(
      meta.get("blast_radius") ?? meta.get("blastradius") ?? "Local module",
    ),
    reversible,
    dependsOn,
    verificationCommand: stripBackticksAndQuotes(
      meta.get("verification") ??
        meta.get("verification_command") ??
        "cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings",
    ),
    traceability: stripBackticksAndQuotes(meta.get("traceability") ?? ""),
    suggestion,
    agentPrompt,
    confidence,
  };
}

// Why: Forcing LLMs to emit raw JSON for Rust code reviews causes syntax failures
// when escaping quotes/backslashes inside `suggestion` patches and degrades reasoning.
// We instruct lenses to emit Structured Markdown (with verbatim ```rust fences) and
// parse deterministically into Zod-validated models, while keeping a seamless JSON
// fallback for any model or test fixture that returns JSON.
export function parseLensFindingsOutput(rawText: string): LensFindingsOutput {
  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new LensOutputParseError("Empty response from findings lens.");
  }

  // 1. Seamless JSON fallback
  const jsonObj = tryExtractJsonObject(trimmed);
  if (jsonObj !== null) {
    const validated = LensFindingsOutputSchema.safeParse(jsonObj);
    if (validated.success) {
      return validated.data;
    }
  }

  // 2. Structured Markdown parser
  const sections = splitTopLevelSections(trimmed);
  const hasKnownSection =
    sections.has("FINDINGS") ||
    sections.has("CONSIDERED_AND_REJECTED") ||
    sections.has("CONSIDERED_REJECTED") ||
    sections.has("DELETIONS_PROPOSED") ||
    sections.has("OPEN_QUESTIONS") ||
    /^###\s+FINDING\b/im.test(trimmed);

  if (!hasKnownSection) {
    throw new LensOutputParseError(
      `Failed to parse structured Markdown or JSON from lens response: ${trimmed.slice(0, 200)}`,
    );
  }

  const findingsSection = sections.get("FINDINGS") ?? trimmed;
  const findingBlocks: string[] = [];
  const lines = findingsSection.replace(/\r\n/g, "\n").split("\n");
  let currentBlock: string[] | null = null;
  let inFence = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      currentBlock?.push(line);
      continue;
    }
    if (!inFence && /^###\s+FINDING\b/i.test(line)) {
      if (currentBlock !== null) {
        findingBlocks.push(currentBlock.join("\n"));
      }
      currentBlock = [];
      continue;
    }
    if (currentBlock !== null) {
      currentBlock.push(line);
    }
  }
  if (currentBlock !== null) {
    findingBlocks.push(currentBlock.join("\n"));
  }

  const findings: LensFindingsOutput["findings"] = [];
  for (const block of findingBlocks) {
    const parsedFinding = parseSingleFindingBlock(block);
    if (parsedFinding !== null) {
      findings.push(parsedFinding);
    }
  }

  // Why: If the LLM emitted one or more `### FINDING` blocks and EVERY single one
  // failed to parse (e.g. truncated output or unrecognized format), throwing
  // LensOutputParseError triggers a retry instead of silently returning 0 findings.
  if (findingBlocks.length > 0 && findings.length === 0) {
    throw new LensOutputParseError(
      `Found ${findingBlocks.length} FINDING block(s) in lens output, but none could be parsed.`,
    );
  }

  const consideredAndRejected: ConsideredAndRejectedItem[] = parsePipeBulletTriples(
    sections.get("CONSIDERED_AND_REJECTED") ?? sections.get("CONSIDERED_REJECTED"),
  ).map(([location, hypothesis, reasonDismissed]) => ({
    location,
    hypothesis,
    reasonDismissed,
  }));

  const deletionsProposed: DeletionProposedItem[] = parsePipeBulletTriples(
    sections.get("DELETIONS_PROPOSED") ?? sections.get("DELETIONS"),
  ).map(([pathOrSymbol, reachabilityEvidence, replacement]) => ({
    pathOrSymbol,
    reachabilityEvidence,
    replacement,
  }));

  const openQuestions: OpenQuestionItem[] = parsePipeBulletTriples(
    sections.get("OPEN_QUESTIONS"),
  ).map(([location, question, impact]) => ({
    location,
    question,
    impact,
  }));

  return LensFindingsOutputSchema.parse({
    findings,
    consideredAndRejected,
    deletionsProposed,
    openQuestions,
  });
}

export function parseWalkthroughOutput(rawText: string): WalkthroughReport {
  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new LensOutputParseError("Empty response from walkthrough lens.");
  }

  // 1. Seamless JSON fallback
  const jsonObj = tryExtractJsonObject(trimmed);
  if (jsonObj !== null) {
    const validated = WalkthroughReportSchema.safeParse(jsonObj);
    if (validated.success) {
      return validated.data;
    }
  }

  // 2. Structured Markdown parser
  const sections = splitTopLevelSections(trimmed);
  const summary = (sections.get("SUMMARY") ?? sections.get("EXECUTIVE_SUMMARY") ?? "").trim();
  if (!summary) {
    throw new LensOutputParseError(
      `Failed to parse structured Markdown or JSON walkthrough from response: ${trimmed.slice(0, 200)}`,
    );
  }

  const triageFields = parseKeyValueLines(sections.get("TRIAGE") ?? "");
  const rawEffort = Number.parseInt(
    triageFields.get("review_effort") ?? triageFields.get("effort") ?? "2",
    10,
  );
  const reviewEffort = Number.isInteger(rawEffort) ? Math.max(1, Math.min(5, rawEffort)) : 2;
  const mergeRisk = normalizeMergeRisk(
    triageFields.get("merge_risk") ?? triageFields.get("risk") ?? "Medium",
  );
  const rationale =
    stripBackticksAndQuotes(triageFields.get("rationale") ?? "") ||
    summary.split("\n")[0] ||
    "Automated architectural triage.";

  const changes: WalkthroughChangeEntry[] = [];
  const changesSection = sections.get("CHANGES") ?? sections.get("ARCHITECTURAL_CHANGES") ?? "";
  for (const rawLine of changesSection.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    // Format: - [L0 | crate_name] `path/to/file.rs`: summary
    const bracketMatch =
      /^[-*]\s*\[L?(\d+)\s*\|\s*([^\]]+)\]\s*`?([^:`\s]+)`?\s*[:—-]\s*(.+)$/.exec(line);
    if (bracketMatch?.[1] && bracketMatch[2] && bracketMatch[3] && bracketMatch[4]) {
      changes.push({
        layer: Math.max(0, Number.parseInt(bracketMatch[1], 10)),
        crateName: stripBackticksAndQuotes(bracketMatch[2]),
        filePath: stripBackticksAndQuotes(bracketMatch[3]).replace(/\\/g, "/").replace(/^\.\//, ""),
        summary: bracketMatch[4].trim(),
      });
      continue;
    }
    // Fallback pipe format: | L0 | crate | path.rs | summary |
    const stripped = line.replace(/^[-*]\s+/, "").replace(/^\|\s*|\s*\|$/g, "");
    if (/^[:\-\s|]+$/.test(stripped)) {
      continue;
    }
    const cols = stripped.split("|").map((c) => stripBackticksAndQuotes(c));
    if (cols.length >= 4 && cols[0] && cols[1] && cols[2] && cols[3] && /^L?\d+$/i.test(cols[0])) {
      changes.push({
        layer: Math.max(0, Number.parseInt(cols[0].replace(/^L/i, ""), 10)),
        crateName: cols[1],
        filePath: cols[2].replace(/\\/g, "/").replace(/^\.\//, ""),
        summary: cols.slice(3).join(" | "),
      });
    }
  }

  const diagramSection = sections.get("SEQUENCE_DIAGRAM") ?? "";
  const diagramFence = extractFirstCodeFenceVerbatim(diagramSection);
  const sequenceDiagram =
    diagramFence && !/^(?:none|null)$/i.test(diagramFence.trim()) ? diagramFence.trim() : null;

  return WalkthroughReportSchema.parse({
    summary,
    changes,
    sequenceDiagram,
    triage: {
      reviewEffort,
      mergeRisk,
      rationale,
    },
  });
}

export interface SkepticVerdict {
  readonly keep: boolean;
  readonly reason: string;
}

export function parseSkepticVerdicts(rawText: string): Map<string, SkepticVerdict> {
  const verdicts = new Map<string, SkepticVerdict>();
  const sections = splitTopLevelSections(rawText);
  const verdictSection = sections.get("VERDICTS") ?? rawText;

  for (const [id, decision, reason] of parsePipeBulletTriples(verdictSection)) {
    const norm = decision.trim().toUpperCase();
    if (norm === "KEEP" || norm === "CONFIRM" || norm === "DROP" || norm === "REFUTE") {
      verdicts.set(id, {
        keep: norm === "KEEP" || norm === "CONFIRM",
        reason: reason.trim(),
      });
    }
  }

  return verdicts;
}
