/**
 * OpenCode V2 Plugin for `peer` (Agent-Agnostic Rust PR Ground-Truth & Verification Engine).
 *
 * Compatible with OpenCode v2.0.4+ / v2.4.0+ (`{ id, setup }` contract via `ctx.tool.transform`).
 * Zero external npm dependencies required.
 */

interface ToolEditor {
  add(tool: {
    name: string;
    description: string;
    input: Record<string, unknown>;
    execute: (
      input: Record<string, unknown>,
      context?: unknown,
    ) => Promise<{ content: string }>;
  }): void;
}

interface OpenCodeV2Context {
  readonly location?: {
    readonly directory?: string;
  };
  readonly tool?: {
    transform(fn: (editor: ToolEditor) => void): Promise<unknown>;
  };
}

async function runPeer(
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const peerBin = process.env.PEER_BIN || "peer";
  const proc = Bun.spawn([peerBin, ...args], {
    cwd: cwd || process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

export default {
  id: "peer",
  async setup(ctx: OpenCodeV2Context) {
    if (!ctx?.tool || typeof ctx.tool.transform !== "function") {
      return;
    }
    const directory = ctx.location?.directory || process.cwd();

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "peer_doctor",
        description:
          "Check local Rust toolchain and analyzer readiness (clippy, audit, deny, geiger, semver, llvm-cov, miri). Returns structured JSON.",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        async execute() {
          const res = await runPeer(["doctor", "--json"], directory);
          return { content: res.stdout.trim() || res.stderr.trim() };
        },
      });

      editor.add({
        name: "peer_next",
        description:
          "Inspect saved .peer/<pr>/<sha>/ artifacts, check whether git HEAD has changed, and return structured JSON with the current stage, counts, artifact paths, and recommended next command.",
        input: {
          type: "object",
          properties: {
            pr: {
              type: "string",
              description: "Optional PR number",
            },
          },
          additionalProperties: false,
        },
        async execute(args) {
          const cliArgs = ["next", "--json"];
          if (typeof args.pr === "string" && args.pr) cliArgs.push(args.pr);
          const res = await runPeer(cliArgs, directory);
          return { content: res.stdout.trim() || res.stderr.trim() };
        },
      });

      editor.add({
        name: "peer_prompt",
        description:
          "Retrieve a built-in Rust review lens prompt directly from the peer binary (single source of truth).",
        input: {
          type: "object",
          properties: {
            name: {
              type: "string",
              enum: ["walkthrough", "soundness", "idioms", "skeptic", "format", "list"],
              description: "Lens prompt name",
            },
          },
          required: ["name"],
          additionalProperties: false,
        },
        async execute(args) {
          const name = typeof args.name === "string" ? args.name : "list";
          const res = await runPeer(["prompt", name], directory);
          if (res.exitCode !== 0) {
            throw new Error(res.stderr.trim() || `peer prompt exited ${res.exitCode}`);
          }
          return { content: res.stdout.trim() };
        },
      });

      editor.add({
        name: "peer_check",
        description:
          "Run peer's local deterministic Rust gate (0 GitHub token, 0 LLM): clippy, cargo-audit delta, AST unsafe/panic detectors, sensitive-file checks, baseline ratchet, and optional SARIF.",
        input: {
          type: "object",
          properties: {
            base: {
              type: "string",
              description: "Base git ref (default: main -> master -> HEAD~1)",
            },
            tools: {
              type: "string",
              description: "Optional Cargo analyzers: deny,geiger,semver,coverage,miri or all",
            },
            strict: {
              type: "boolean",
              description: "Fail on Minor/Info findings too",
            },
            allFiles: {
              type: "boolean",
              description: "Scan entire repository (diff against empty tree)",
            },
            staged: {
              type: "boolean",
              description: "Scan staged changes only (pre-commit mode)",
            },
          },
          additionalProperties: false,
        },
        async execute(args) {
          const cliArgs = ["check", "--json"];
          if (typeof args.base === "string" && args.base) cliArgs.push("--base", args.base);
          if (typeof args.tools === "string" && args.tools) cliArgs.push("--tools", args.tools);
          if (args.strict === true) cliArgs.push("--strict");
          if (args.allFiles === true) cliArgs.push("--all-files");
          if (args.staged === true) cliArgs.push("--staged");
          const res = await runPeer(cliArgs, directory);
          if (res.exitCode >= 2) {
            throw new Error(
              res.stderr.trim() || res.stdout.trim() || `peer check failed (exit ${res.exitCode})`,
            );
          }
          return { content: res.stdout.trim() || res.stderr.trim() };
        },
      });

      editor.add({
        name: "peer_analyze",
        description:
          "Run Stage 1 deterministic Rust PR analysis (git diff, clippy, cargo-audit CVE delta, Cargo.lock diff, Tree-sitter AST symbol/unsafe/panic graph, and optional tools). Writes .peer/<pr>/<sha>/01-analyze/prompt-context.md and cohorts/ and returns structured JSON.",
        input: {
          type: "object",
          properties: {
            pr: {
              type: "string",
              description: "PR number or full GitHub PR URL",
            },
            tools: {
              type: "string",
              description: "Optional Cargo analyzers: deny,geiger,semver,coverage,miri or all",
            },
            profile: {
              type: "string",
              enum: ["quiet", "chill", "assertive"],
              description: "Strictness profile (default: assertive)",
            },
            fresh: {
              type: "boolean",
              description: "Force re-run ignoring cached stage",
            },
          },
          required: ["pr"],
          additionalProperties: false,
        },
        async execute(args) {
          const cliArgs = ["analyze", String(args.pr), "--json"];
          if (typeof args.tools === "string" && args.tools) cliArgs.push("--tools", args.tools);
          if (typeof args.profile === "string" && args.profile)
            cliArgs.push("--profile", args.profile);
          if (args.fresh === true) cliArgs.push("--fresh");
          const res = await runPeer(cliArgs, directory);
          if (res.exitCode !== 0) {
            throw new Error(
              res.stderr.trim() || res.stdout.trim() || `peer analyze exited ${res.exitCode}`,
            );
          }
          return { content: res.stdout.trim() };
        },
      });

      editor.add({
        name: "peer_finalize",
        description:
          "Run Judge merge + crate-scoped `cargo check` suggestion verification on an agent review file or directory (--from), or apply deterministic skeptic verdicts (--verdicts). Returns structured JSON with counts, cohortCoverage/reconciliation, and artifact paths.",
        input: {
          type: "object",
          properties: {
            pr: {
              type: "string",
              description: "PR number or full GitHub PR URL",
            },
            from: {
              type: "string",
              description: "Path to agent review Markdown/JSON file or directory of cohort .md files",
            },
            verdicts: {
              type: "string",
              description: "Path to skeptic KEEP/DROP verdicts file",
            },
            stage: {
              type: "string",
              enum: ["review", "verify"],
              description: "Target stage folder (default: review)",
            },
            strict: {
              type: "boolean",
              description: "Fail if any finding blocks are malformed or expected cohort files are missing",
            },
            profile: {
              type: "string",
              enum: ["quiet", "chill", "assertive"],
            },
            excludeTools: {
              type: "string",
              description:
                "Comma-separated tool findings to exclude from the finalized bundle/todo (e.g. 'coverage,semver' or 'all')",
            },
            minSeverity: {
              type: "string",
              enum: ["Critical", "Major", "Minor", "Trivial", "Info"],
              description: "Minimum severity threshold to keep in finalized bundle/todo",
            },
          },
          required: ["pr"],
          additionalProperties: false,
        },
        async execute(args) {
          const cliArgs = ["finalize", String(args.pr), "--json"];
          if (typeof args.from === "string" && args.from) cliArgs.push("--from", args.from);
          if (typeof args.verdicts === "string" && args.verdicts)
            cliArgs.push("--verdicts", args.verdicts);
          if (typeof args.stage === "string" && args.stage) cliArgs.push("--stage", args.stage);
          if (args.strict === true) cliArgs.push("--strict");
          if (typeof args.profile === "string" && args.profile)
            cliArgs.push("--profile", args.profile);
          if (typeof args.excludeTools === "string" && args.excludeTools)
            cliArgs.push("--exclude-tools", args.excludeTools);
          if (typeof args.minSeverity === "string" && args.minSeverity)
            cliArgs.push("--min-severity", args.minSeverity);
          const res = await runPeer(cliArgs, directory);
          if (res.exitCode !== 0) {
            throw new Error(
              res.stderr.trim() || res.stdout.trim() || `peer finalize exited ${res.exitCode}`,
            );
          }
          return { content: res.stdout.trim() };
        },
      });

      editor.add({
        name: "peer_publish",
        description:
          "Upload the latest saved local review stage (01-analyze, 02-review, or 03-verify) to the GitHub PR as a PENDING draft (or submitted COMMENT with submit=true). Returns structured JSON.",
        input: {
          type: "object",
          properties: {
            pr: {
              type: "string",
              description: "PR number or full GitHub PR URL",
            },
            submit: {
              type: "boolean",
              description: "Submit immediately as COMMENT instead of PENDING draft",
            },
          },
          required: ["pr"],
          additionalProperties: false,
        },
        async execute(args) {
          const cliArgs = ["publish", String(args.pr), "--json"];
          if (args.submit === true) cliArgs.push("--submit");
          const res = await runPeer(cliArgs, directory);
          if (res.exitCode !== 0) {
            throw new Error(
              res.stderr.trim() || res.stdout.trim() || `peer publish exited ${res.exitCode}`,
            );
          }
          return { content: res.stdout.trim() };
        },
      });
    });
  },
};
