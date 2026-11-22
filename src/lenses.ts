import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import {
  extractSymbolsFromFileMap,
  formatSymbolGraphSummary,
  type RustSymbolGraph,
} from "./graph.ts";
import { formatLearningsPromptSection, type RepoLearning } from "./learnings.ts";
import type {
  ClippyDiagnostic,
  CrateGraph,
  DiffFileMap,
  Finding,
  FindingSource,
  PullRequestMetadata,
  WalkthroughReport,
} from "./models.ts";
import { FindingSchema, LensFindingsOutputSchema, WalkthroughReportSchema } from "./models.ts";
import { resolveFileArchitecturalLayer } from "./rust.ts";

export interface ModelSpec {
  readonly providerID: string;
  readonly id: string;
}

export interface SessionPermissionRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: "allow" | "deny" | "ask";
}

// Why: In @opencode/schema (session.d.ts), `SessionCreateInput.permissions` is
// evaluated after the agent's default rules (`* -> allow`) and the last matching
// rule wins. Starting with `{ action: "*", resource: "*", effect: "deny" }`
// revokes write, edit, shell, browser, and interactive question tools; allowing
// `read`, `grep`, and `glob` enables repository navigation; and trailing `deny`
// rules on `*.env` / `*.env.*` prevent secret reads without triggering an
// interactive `"ask"` prompt that would hang a non-interactive CLI session.
export const READONLY_SESSION_PERMISSIONS: readonly SessionPermissionRule[] = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "deny" },
  { action: "read", resource: "*.env.*", effect: "deny" },
  { action: "read", resource: "*.env.example", effect: "allow" },
];

function globToRegExp(pattern: string): RegExp {
  if (pattern === "*") {
    return /^.*$/;
  }
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

export function evaluatePermissionRule(
  rules: readonly SessionPermissionRule[],
  action: string,
  resource: string,
): "allow" | "deny" | "ask" {
  let effect: "allow" | "deny" | "ask" = "allow";
  for (const rule of rules) {
    const actionMatches = rule.action === "*" || rule.action === action;
    const resourceMatches = globToRegExp(rule.resource).test(resource);
    if (actionMatches && resourceMatches) {
      effect = rule.effect;
    }
  }
  return effect;
}

export function parseModelSpec(
  explicitSpec?: string,
  env: Record<string, string | undefined> = process.env,
): ModelSpec {
  const raw = (explicitSpec ?? env.PEER_MODEL ?? env.MODEL ?? "hy4-flash-free").trim();
  const slashIdx = raw.indexOf("/");
  if (slashIdx > 0 && slashIdx < raw.length - 1) {
    return {
      providerID: raw.slice(0, slashIdx),
      id: raw.slice(slashIdx + 1),
    };
  }
  return {
    providerID: "opencode",
    id: raw.length > 0 ? raw : "hy4-flash-free",
  };
}

export interface ReviewContext {
  readonly repoRoot: string;
  readonly pr: PullRequestMetadata;
  readonly diffBaseSha: string;
  readonly headSha: string;
  readonly isIncremental: boolean;
  readonly crateGraph: CrateGraph;
  readonly diffMap: Readonly<Record<string, DiffFileMap>>;
  readonly clippyDiagnostics: readonly ClippyDiagnostic[];
  readonly symbolGraph?: RustSymbolGraph;
  readonly learnings?: readonly RepoLearning[];
}

// Why: Large PRs (e.g. 50-150 files, >1 MB raw diff) exceed an LLM's effective
// reasoning window and inflate token usage by 10x if every file is dumped inline.
// We use Progressive Context Disclosure:
// - Tier 1 (Primary High-Risk Production Rust files): scored by risk signals
//   (`unsafe`, `.await`, locks, `select!`, `unwrap`/`panic!`, Clippy hits, non-test
//   layer) and included with compact annotated diff hunks (up to 6 files / 18k chars).
// - Tier 2 (Secondary / Test / Mechanical files): ONLY the file path, crate layer,
//   valid right-side hunk line ranges, and modified symbol names are listed so the
//   agent can request a specific file via `read` only if needed.
export const DEFAULT_MAX_INLINE_DIFF_CHARS = 18_000;
export const DEFAULT_MAX_TIER1_FILES = 6;
export const MAX_HUNK_LINES_BEFORE_COMPACT = 40;

const HIGH_RISK_RUST_TOKEN_REGEX =
  /\b(?:unsafe|await|Mutex|RwLock|parking_lot|select!|unwrap|expect|panic!|transmute|from_raw|into_raw|Send|Sync)\b/;

export function scoreFileReviewPriority(
  fileMap: DiffFileMap,
  layer: number,
  testLayer: number,
  clippyFiles: ReadonlySet<string>,
): { score: number; isTestOrBench: boolean; addedLinesCount: number; riskSignals: string[] } {
  const isTestOrBench =
    layer >= testLayer ||
    fileMap.filePath.includes("/tests/") ||
    fileMap.filePath.startsWith("tests/") ||
    fileMap.filePath.includes("/benches/") ||
    fileMap.filePath.endsWith("_test.rs");

  let score = isTestOrBench ? 0 : 100 - Math.min(layer * 5, 30);
  if (fileMap.filePath.endsWith("Cargo.toml")) {
    score -= 40;
  }
  if (clippyFiles.has(fileMap.filePath)) {
    score += 50;
  }

  let addedLinesCount = 0;
  const riskSignalsSet = new Set<string>();

  for (const hunk of fileMap.hunks) {
    for (const line of hunk.annotatedLines) {
      if (line.includes("(+):")) {
        addedLinesCount += 1;
        const match = HIGH_RISK_RUST_TOKEN_REGEX.exec(line);
        if (match?.[0]) {
          riskSignalsSet.add(match[0]);
        }
      }
    }
  }

  score += riskSignalsSet.size * 25;
  score += Math.min(addedLinesCount, 80) * 0.25;

  return {
    score,
    isTestOrBench,
    addedLinesCount,
    riskSignals: Array.from(riskSignalsSet),
  };
}

function compactAnnotatedLines(lines: readonly string[]): string[] {
  if (lines.length <= MAX_HUNK_LINES_BEFORE_COMPACT) {
    return [...lines];
  }
  // Keep added lines (`(+):`) plus first/last 2 context lines of the hunk
  const selected: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) {
      continue;
    }
    const isAdded = line.includes("(+):");
    const isNeighborAdded =
      (i > 0 && (lines[i - 1]?.includes("(+):") ?? false)) ||
      (i + 1 < lines.length && (lines[i + 1]?.includes("(+):") ?? false));
    if (isAdded || isNeighborAdded || i < 2 || i >= lines.length - 2) {
      selected.push(line);
    }
  }
  return selected.slice(0, MAX_HUNK_LINES_BEFORE_COMPACT);
}

export function buildReviewContextPrompt(
  context: ReviewContext,
  maxInlineDiffChars = DEFAULT_MAX_INLINE_DIFF_CHARS,
  maxTier1Files = DEFAULT_MAX_TIER1_FILES,
): string {
  const sections: string[] = [];

  sections.push(
    `# Pull Request Context\n` +
      `- Repository: ${context.pr.owner}/${context.pr.repo}\n` +
      `- PR #${context.pr.number}: ${context.pr.title}\n` +
      `- Author: ${context.pr.author}\n` +
      `- Range: ${context.diffBaseSha.slice(0, 7)}..${context.headSha.slice(0, 7)} (${context.isIncremental ? "incremental delta" : "full PR diff"})\n\n` +
      `## PR Description\n${(context.pr.body.trim() || "(no description)").slice(0, 2000)}`,
  );

  if (context.learnings && context.learnings.length > 0) {
    sections.push(formatLearningsPromptSection(context.learnings));
  }

  const clippyFiles = new Set(context.clippyDiagnostics.map((d) => d.filePath));

  const enrichedFiles = Object.keys(context.diffMap)
    .map((filePath) => {
      const fileMap = context.diffMap[filePath];
      const layerInfo = resolveFileArchitecturalLayer(context.crateGraph, filePath);
      const priority = fileMap
        ? scoreFileReviewPriority(
            fileMap,
            layerInfo.layer,
            context.crateGraph.testLayer,
            clippyFiles,
          )
        : { score: 0, isTestOrBench: true, addedLinesCount: 0, riskSignals: [] };
      const symbols = fileMap
        ? extractSymbolsFromFileMap(fileMap).map((s) => `${s.kind} ${s.name}`)
        : [];
      return {
        filePath,
        fileMap,
        crateName: layerInfo.crateName,
        layer: layerInfo.layer,
        ...priority,
        symbols,
      };
    })
    .sort((a, b) => a.layer - b.layer || a.filePath.localeCompare(b.filePath));

  const fileListLines = enrichedFiles.map((f) => {
    const ranges = f.fileMap
      ? f.fileMap.hunks.map((h) => `${h.newStart}..${h.newEnd}`).join(", ")
      : "";
    const symSuffix = f.symbols.length > 0 ? ` | symbols: ${f.symbols.slice(0, 5).join(", ")}` : "";
    return `- [Layer ${f.layer} | crate: ${f.crateName}] \`${f.filePath}\` (hunks: ${ranges}${symSuffix})`;
  });
  sections.push(
    `## Modified Rust Code Files (Ordered by Cargo Crate Dependency Layer)\n${fileListLines.join("\n") || "(none)"}`,
  );

  if (context.symbolGraph && context.symbolGraph.nodes.length > 0) {
    sections.push(
      `## Rust Symbol & Cross-Workspace Call-Site Graph\n${formatSymbolGraphSummary(context.symbolGraph)}`,
    );
  }

  if (context.clippyDiagnostics.length > 0) {
    const clippyLines = context.clippyDiagnostics.map(
      (d) =>
        `- [${d.level.toUpperCase()}] \`${d.filePath}:${d.startLine}-${d.endLine}\` (${d.code ?? "rustc"}): ${d.message}` +
        (d.suggestedReplacement ? ` | suggestion: \`${d.suggestedReplacement.trim()}\`` : ""),
    );
    sections.push(`## Local Cargo Clippy / Compiler Diagnostics\n${clippyLines.join("\n")}`);
  } else {
    sections.push(`## Local Cargo Clippy / Compiler Diagnostics\nZero warnings or errors.`);
  }

  // Partition into Tier 1 (highest-priority production Rust files for inline diff)
  // and Tier 2 (paths + hunk intervals + symbols only, available on demand via `read`)
  const rankedByScore = [...enrichedFiles].sort(
    (a, b) => b.score - a.score || a.layer - b.layer || a.filePath.localeCompare(b.filePath),
  );

  const tier1Paths = new Set<string>();
  const tier1Blocks: string[] = [];
  let usedChars = 0;

  for (const entry of rankedByScore) {
    if (!entry.fileMap) {
      continue;
    }
    if (tier1Blocks.length >= maxTier1Files) {
      break;
    }
    // Always keep non-test files prioritized; if a PR only modifies test files, allow the top test files
    if (entry.isTestOrBench && tier1Blocks.length > 0) {
      continue;
    }

    const hunkTexts = entry.fileMap.hunks.map((hunk) => {
      const lines = compactAnnotatedLines(hunk.annotatedLines);
      return (
        `${hunk.header} (right-side valid range: ${hunk.newStart}..${hunk.newEnd})\n` +
        lines.join("\n")
      );
    });
    const block =
      `### File: \`${entry.filePath}\` (Layer ${entry.layer}, crate \`${entry.crateName}\`)\n` +
      `\`\`\`diff\n${hunkTexts.join("\n\n")}\n\`\`\``;

    if (usedChars + block.length > maxInlineDiffChars && tier1Blocks.length > 0) {
      continue;
    }

    tier1Paths.add(entry.filePath);
    tier1Blocks.push(block);
    usedChars += block.length;
  }

  const tier2Lines: string[] = [];
  for (const entry of enrichedFiles) {
    if (tier1Paths.has(entry.filePath) || !entry.fileMap) {
      continue;
    }
    const ranges = entry.fileMap.hunks.map((h) => `${h.newStart}..${h.newEnd}`).join(", ");
    const symLabel =
      entry.symbols.length > 0
        ? ` | modified symbols: ${entry.symbols.slice(0, 6).join(", ")}`
        : "";
    tier2Lines.push(
      `- \`${entry.filePath}\` (Layer ${entry.layer}, crate \`${entry.crateName}\`, +${entry.addedLinesCount} lines, valid hunks: ${ranges}${symLabel})`,
    );
  }

  sections.push(
    `## Tier 1: Primary High-Risk Rust Diff Hunks (Inline)\n${tier1Blocks.join("\n\n") || "(none)"}`,
  );

  if (tier2Lines.length > 0) {
    sections.push(
      `## Tier 2: Secondary & Test Files (Paths Only — Request via \`read\` Tool Only If Needed)\n` +
        tier2Lines.join("\n"),
    );
  }

  return sections.join("\n\n");
}

export const WALKTHROUGH_LENS_PROMPT = `LENS: WALKTHROUGH_ARCHITECTURE
You are the Walkthrough & Architecture Review Lens for a complex Rust repository.
TOKEN EFFICIENCY RULE: All changed files, crate layers, and diff hunks are already provided below. Do NOT call any tools (\`read\`, \`grep\`, \`glob\`) for the walkthrough — respond immediately in a single turn with the JSON object.

Analyze the PR context, architectural crate-graph layers, and annotated diff hunks.
Return ONLY a single JSON object matching this exact schema (no extra commentary outside JSON):
{
  "summary": "Concise architectural walkthrough of what changed and why",
  "changes": [
    {
      "layer": 0,
      "crateName": "crate_name",
      "filePath": "relative/path.rs",
      "summary": "Concise summary of changes in this file/layer"
    }
  ],
  "sequenceDiagram": "sequenceDiagram\\n  participant A as \\"Caller\\"\\n  participant B as \\"Callee\\"\\n  A->>B: call()",
  "triage": {
    "reviewEffort": 3,
    "mergeRisk": "Low" | "Minimal" | "Medium" | "High" | "Critical",
    "rationale": "Why this effort (1-5) and merge risk apply"
  }
}
Rules:
1. Order "changes" by architectural layer ascending (0 = core/leaf crates first, verification/tests last).
2. If the PR modifies cross-component control flow, async workflows, or state transitions, include a valid Mermaid "sequenceDiagram" string (quote any labels containing parentheses or special characters; never use HTML tags). Otherwise set "sequenceDiagram" to null.`;

export const SOUNDNESS_CONCURRENCY_LENS_PROMPT = `LENS: SOUNDNESS_CONCURRENCY
You are the Rust Soundness, \`unsafe\`, and Async/Concurrency Review Lens.
TOKEN EFFICIENCY RULE: The annotated diff hunks and line numbers are already provided below. To keep token usage low, make AT MOST 2 tool calls (\`read\`/\`grep\`) ONLY if strictly required to verify a critical invariant, then immediately return your JSON response. Prefer analyzing the provided diff directly in 0 tool calls.

Focus strictly on:
1. \`unsafe\` blocks/fns: missing or falsified \`// SAFETY:\` invariants, pointer aliasing/provenance, uninitialized memory, FFI unwind/drop safety, unsound \`Send\`/\`Sync\` impls.
2. Async & Concurrency: synchronous locks (\`std::sync::Mutex\`, \`RwLock\`, \`parking_lot\`) held across \`.await\` points, lock-order inversions/deadlocks, \`tokio::select!\` branch cancellation safety, unbounded channels/maps lacking backpressure or eviction.
3. Panic & Crash Paths: \`unwrap()\`, \`expect()\`, \`panic!()\`, indexing \`slice[i]\`, or unchecked integer arithmetic on untrusted/production inputs.

Return ONLY a single JSON object matching this exact schema:
{
  "findings": [
    {
      "filePath": "relative/path.rs",
      "startLine": 10,
      "endLine": 12,
      "severity": "Critical" | "Major" | "Minor" | "Trivial" | "Info",
      "type": "Soundness" | "Concurrency" | "Security" | "Bug",
      "title": "Short specific defect title",
      "body": "Concrete explanation of the root cause, mechanism of failure, and fix",
      "suggestion": "Exact drop-in replacement lines for startLine..endLine (or null if multi-hunk)",
      "agentPrompt": "Actionable instructions for a coding agent to fix and test this defect",
      "confidence": 0.92
    }
  ]
}
Rules:
- Use the explicit right-side line numbers (\`L0042\`) from the annotated diff hunks. \`startLine\` and \`endLine\` MUST fall inside a single right-side diff hunk.
- If a proposed \`suggestion\` replaces lines \`startLine..endLine\`, preserve exact indentation so \`cargo check\` succeeds when those lines are replaced. Set \`suggestion\` to \`null\` if the fix requires edits outside \`startLine..endLine\`.`;

export const IDIOMS_LOGIC_LENS_PROMPT = `LENS: IDIOMS_PERFORMANCE_LOGIC
You are the Rust Idioms, Performance, and Domain Logic Review Lens, applying the PingCAP/TiKV Rust Style Guide (\`rust-conventions\`).
TOKEN EFFICIENCY RULE: The annotated diff hunks and line numbers are already provided below. To keep token usage low, make AT MOST 2 tool calls (\`read\`/\`grep\`) ONLY if strictly required, then immediately return your JSON response. Prefer analyzing the provided diff directly in 0 tool calls.

Focus strictly on:
1. Domain Logic & Edge Cases: off-by-one errors, wrong boolean conditions, partial state updates before fallible \`?\` returns, swallowed errors.
2. Performance & Allocations: unnecessary \`.clone()\` or \`to_owned()\` in hot loops, missing \`Vec::with_capacity\`, taking owned \`String\`/\`Vec<T>\` where \`&str\`/\`&[T]\` suffices, large stack frames across \`.await\`.
3. PingCAP/TiKV Rust Conventions: \`crate::\` module imports, \`as_\` (free) / \`to_\` (allocating) / \`into_\` (consuming) conversion naming, custom error types vs stringly-typed errors, visibility minimalism.

Return ONLY a single JSON object matching this exact schema:
{
  "findings": [
    {
      "filePath": "relative/path.rs",
      "startLine": 10,
      "endLine": 12,
      "severity": "Critical" | "Major" | "Minor" | "Trivial" | "Info",
      "type": "Bug" | "Performance" | "Idioms" | "Refactor",
      "title": "Short specific defect title",
      "body": "Concrete explanation of the defect or performance/style issue",
      "suggestion": "Exact drop-in replacement lines for startLine..endLine (or null if multi-hunk)",
      "agentPrompt": "Actionable instructions for a coding agent to fix this issue",
      "confidence": 0.88
    }
  ]
}
Rules:
- Grade real logic bugs and severe hot-path regressions as \`Critical\` or \`Major\`; grade stylistic/idiom improvements as \`Minor\` or \`Trivial\`.
- \`startLine\` and \`endLine\` MUST fall inside a single right-side diff hunk (\`L<num>\`).`;

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

export interface OpenCodeAssistantMessagePart {
  readonly type: string;
  readonly text?: string;
}

export interface OpenCodeSessionMessage {
  readonly type: string;
  readonly content?: readonly OpenCodeAssistantMessagePart[];
}

export interface OpenCodeClientLike {
  readonly session: {
    create(input: {
      location?: { directory: string };
      model?: { providerID: string; id: string };
      title?: string;
      permissions?: readonly SessionPermissionRule[];
    }): Promise<{ id: string }>;
    prompt(input: { sessionID: string; text: string }): Promise<unknown>;
    remove(input: { sessionID: string }): Promise<unknown>;
  };
  readonly experimental: {
    readonly session: {
      wait(input: { sessionID: string }): Promise<unknown>;
    };
  };
  readonly message: {
    list(input: {
      sessionID: string;
      type?: "assistant";
    }): Promise<{ data: readonly OpenCodeSessionMessage[] }>;
  };
}

export async function createDefaultOpenCodeClient(): Promise<OpenCodeClientLike> {
  const endpoint = await Service.ensure();
  const noIdleTimeoutFetch = ((input: string | URL | Request, init?: RequestInit) =>
    globalThis.fetch(input, {
      ...init,
      // Disable Bun's 300s default socket idle timeout on long-polling session.wait requests
      timeout: false,
    } as RequestInit)) as typeof globalThis.fetch;

  return OpenCode.make({
    baseUrl: endpoint.url,
    headers: Service.headers(endpoint),
    fetch: noIdleTimeoutFetch,
  }) as unknown as OpenCodeClientLike;
}

export interface MultiLensOrchestratorOptions {
  readonly model?: ModelSpec;
  readonly clientFactory?: () => Promise<OpenCodeClientLike>;
}

export class OpenCodeMultiLensOrchestrator {
  private readonly model: ModelSpec;
  private readonly clientFactory: () => Promise<OpenCodeClientLike>;

  constructor(options: MultiLensOrchestratorOptions = {}) {
    this.model = options.model ?? parseModelSpec();
    this.clientFactory = options.clientFactory ?? createDefaultOpenCodeClient;
  }

  public async runAllLenses(
    context: ReviewContext,
  ): Promise<{ walkthrough: WalkthroughReport; findings: Finding[] }> {
    const client = await this.clientFactory();
    const contextPrompt = buildReviewContextPrompt(context);

    const [walkthrough, soundnessFindings, idiomsFindings] = await Promise.all([
      this.runWalkthroughLens(client, context.repoRoot, contextPrompt),
      this.runFindingsLens(
        client,
        context.repoRoot,
        "peer-lens-soundness",
        SOUNDNESS_CONCURRENCY_LENS_PROMPT,
        contextPrompt,
        "soundness",
      ),
      this.runFindingsLens(
        client,
        context.repoRoot,
        "peer-lens-idioms",
        IDIOMS_LOGIC_LENS_PROMPT,
        contextPrompt,
        "idioms",
      ),
    ]);

    return {
      walkthrough,
      findings: [...soundnessFindings, ...idiomsFindings],
    };
  }

  private async executeReadOnlyPrompt(
    client: OpenCodeClientLike,
    repoRoot: string,
    title: string,
    promptText: string,
  ): Promise<string> {
    const session = await client.session.create({
      location: { directory: repoRoot },
      model: this.model,
      title,
      permissions: READONLY_SESSION_PERMISSIONS,
    });

    try {
      await client.session.prompt({
        sessionID: session.id,
        text: promptText,
      });

      await client.experimental.session.wait({
        sessionID: session.id,
      });

      const messages = await client.message.list({
        sessionID: session.id,
        type: "assistant",
      });

      return messages.data
        .flatMap((msg) => (msg.type === "assistant" && msg.content ? msg.content : []))
        .filter(
          (part): part is { type: "text"; text: string } =>
            part.type === "text" && typeof part.text === "string",
        )
        .map((part) => part.text)
        .join("\n");
    } finally {
      try {
        await client.session.remove({ sessionID: session.id });
      } catch {
        // Ignore session removal cleanup errors
      }
    }
  }

  private async runWalkthroughLens(
    client: OpenCodeClientLike,
    repoRoot: string,
    contextPrompt: string,
  ): Promise<WalkthroughReport> {
    const fullPrompt = `${WALKTHROUGH_LENS_PROMPT}\n\n${contextPrompt}`;
    const reply = await this.executeReadOnlyPrompt(
      client,
      repoRoot,
      "peer-lens-walkthrough",
      fullPrompt,
    );
    const jsonObj = extractJsonObject(reply);
    return WalkthroughReportSchema.parse(jsonObj);
  }

  private async runFindingsLens(
    client: OpenCodeClientLike,
    repoRoot: string,
    title: string,
    lensPrompt: string,
    contextPrompt: string,
    source: FindingSource,
  ): Promise<Finding[]> {
    const fullPrompt = `${lensPrompt}\n\n${contextPrompt}`;
    const reply = await this.executeReadOnlyPrompt(client, repoRoot, title, fullPrompt);
    const jsonObj = extractJsonObject(reply);
    const parsed = LensFindingsOutputSchema.parse(jsonObj);

    const results: Finding[] = [];
    for (let i = 0; i < parsed.findings.length; i++) {
      const item = parsed.findings[i];
      if (!item) {
        continue;
      }
      const startLine = Math.min(item.startLine, item.endLine);
      const endLine = Math.max(item.startLine, item.endLine);
      results.push(
        FindingSchema.parse({
          id: `${source}-${i + 1}`,
          filePath: item.filePath.replace(/\\/g, "/").replace(/^\.\//, ""),
          startLine,
          endLine,
          severity: item.severity,
          type: item.type,
          title: item.title,
          body: item.body,
          suggestion: item.suggestion,
          suggestionVerified: false,
          agentPrompt: item.agentPrompt,
          confidence: item.confidence,
          source,
        }),
      );
    }
    return results;
  }
}
