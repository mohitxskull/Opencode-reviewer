import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
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
}

export function buildReviewContextPrompt(context: ReviewContext): string {
  const sections: string[] = [];

  sections.push(
    `# Pull Request Context\n` +
      `- Repository: ${context.pr.owner}/${context.pr.repo}\n` +
      `- PR #${context.pr.number}: ${context.pr.title}\n` +
      `- Author: ${context.pr.author}\n` +
      `- Range: ${context.diffBaseSha.slice(0, 7)}..${context.headSha.slice(0, 7)} (${context.isIncremental ? "incremental delta" : "full PR diff"})\n\n` +
      `## PR Description\n${context.pr.body.trim() || "(no description)"}`,
  );

  const orderedFiles = Object.keys(context.diffMap)
    .map((filePath) => {
      const layerInfo = resolveFileArchitecturalLayer(context.crateGraph, filePath);
      return {
        filePath,
        crateName: layerInfo.crateName,
        layer: layerInfo.layer,
      };
    })
    .sort((a, b) => a.layer - b.layer || a.filePath.localeCompare(b.filePath));

  const fileListLines = orderedFiles.map(
    (f) => `- [Layer ${f.layer} | crate: ${f.crateName}] \`${f.filePath}\``,
  );
  sections.push(
    `## Modified Files (Ordered by Cargo Crate Dependency Layer)\n${fileListLines.join("\n") || "(none)"}`,
  );

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

  const diffBlocks: string[] = [];
  for (const fileEntry of orderedFiles) {
    const fileMap = context.diffMap[fileEntry.filePath];
    if (!fileMap) {
      continue;
    }
    const hunkTexts = fileMap.hunks.map(
      (hunk) =>
        `${hunk.header} (right-side valid range: ${hunk.newStart}..${hunk.newEnd})\n` +
        hunk.annotatedLines.join("\n"),
    );
    diffBlocks.push(
      `### File: \`${fileMap.filePath}\` (Layer ${fileEntry.layer}, crate \`${fileEntry.crateName}\`)\n` +
        `\`\`\`diff\n${hunkTexts.join("\n\n")}\n\`\`\``,
    );
  }

  sections.push(`## Annotated Right-Side Unified Diff Hunks\n${diffBlocks.join("\n\n")}`);
  return sections.join("\n\n");
}

export const WALKTHROUGH_LENS_PROMPT = `LENS: WALKTHROUGH_ARCHITECTURE
You are the Walkthrough & Architecture Review Lens for a complex Rust repository.
You have read-only access to the workspace (read, grep, glob). Do not attempt to edit files or run shell commands.

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
You have read-only access to the workspace (read, grep, glob). Inspect surrounding callers, struct invariants, and trait bounds when needed.

Focus strictly on:
1. \`unsafe\` blocks/fns: missing or falsified \`// SAFETY:\` invariants, pointer aliasing/provenance, uninitialized memory, FFI unwind/drop safety, unsound \`Send\`/\`Sync\` impls.
2. Async & Concurrency: synchronous locks (\`std::sync::Mutex\`, \`RwLock\`, \`parking_lot\`) held across \`.await\` points, lock-order inversions/deadlocks, \`tokio::select!\` branch cancellation safety, unbounded channels lacking backpressure.
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
You have read-only access to the workspace (read, grep, glob).

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
  return OpenCode.make({
    baseUrl: endpoint.url,
    headers: Service.headers(endpoint),
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
