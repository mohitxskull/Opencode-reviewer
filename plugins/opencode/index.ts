import { type Plugin, tool } from "@opencode-ai/plugin";

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

export const PeerRustReviewerPlugin: Plugin = async ({ directory }) => ({
  tool: {
    peer_doctor: tool({
      description: "Check local Rust toolchain and analyzer readiness (clippy, audit, deny, geiger, semver, llvm-cov, miri).",
      args: {},
      async execute() {
        const res = await runPeer(["doctor"], directory);
        return res.stdout.trim() || res.stderr.trim();
      },
    }),

    peer_prompt: tool({
      description: "Retrieve a built-in Rust review lens prompt directly from the peer binary (single source of truth).",
      args: {
        name: tool.schema
          .enum(["walkthrough", "soundness", "idioms", "skeptic", "format", "list"])
          .describe("Lens prompt name"),
      },
      async execute(args) {
        const res = await runPeer(["prompt", args.name], directory);
        if (res.exitCode !== 0) {
          throw new Error(res.stderr.trim() || `peer prompt exited ${res.exitCode}`);
        }
        return res.stdout.trim();
      },
    }),

    peer_check: tool({
      description:
        "Run peer's local deterministic Rust gate (0 GitHub token, 0 LLM): clippy, cargo-audit delta, AST unsafe/panic detectors, sensitive-file checks, baseline ratchet, and optional SARIF.",
      args: {
        base: tool.schema.string().optional().describe("Base git ref (default: main -> master -> HEAD~1)"),
        tools: tool.schema.string().optional().describe("Optional Cargo analyzers: deny,geiger,semver,coverage,miri or all"),
        strict: tool.schema.boolean().optional().describe("Fail on Minor/Info findings too"),
      },
      async execute(args) {
        const cliArgs = ["check"];
        if (args.base) cliArgs.push("--base", args.base);
        if (args.tools) cliArgs.push("--tools", args.tools);
        if (args.strict) cliArgs.push("--strict");
        const res = await runPeer(cliArgs, directory);
        return res.stdout.trim() || res.stderr.trim();
      },
    }),

    peer_analyze: tool({
      description:
        "Run Stage 1 deterministic Rust PR analysis (git diff, clippy, cargo-audit CVE delta, Cargo.lock diff, Tree-sitter AST symbol/unsafe/panic graph, and optional tools). Writes .peer/<pr>/<sha>/01-analyze/prompt-context.md.",
      args: {
        pr: tool.schema.string().describe("PR number or full GitHub PR URL"),
        tools: tool.schema
          .string()
          .optional()
          .describe("Optional Cargo analyzers: deny,geiger,semver,coverage,miri or all"),
        profile: tool.schema
          .enum(["quiet", "chill", "assertive"])
          .optional()
          .describe("Strictness profile (default: assertive)"),
        fresh: tool.schema.boolean().optional().describe("Force re-run ignoring cached stage"),
      },
      async execute(args) {
        const cliArgs = ["analyze", args.pr];
        if (args.tools) cliArgs.push("--tools", args.tools);
        if (args.profile) cliArgs.push("--profile", args.profile);
        if (args.fresh) cliArgs.push("--fresh");
        const res = await runPeer(cliArgs, directory);
        if (res.exitCode !== 0) {
          throw new Error(res.stderr.trim() || res.stdout.trim() || `peer analyze exited ${res.exitCode}`);
        }
        return res.stdout.trim();
      },
    }),

    peer_finalize: tool({
      description:
        "Run Judge merge + crate-scoped `cargo check` suggestion verification on an agent review file (--from), or apply deterministic skeptic verdicts (--verdicts).",
      args: {
        pr: tool.schema.string().describe("PR number or full GitHub PR URL"),
        from: tool.schema.string().optional().describe("Path to the agent review Markdown or JSON file"),
        verdicts: tool.schema.string().optional().describe("Path to skeptic KEEP/DROP verdicts file"),
        stage: tool.schema
          .enum(["review", "verify"])
          .optional()
          .describe("Target stage folder (default: review)"),
        strict: tool.schema.boolean().optional().describe("Fail if any finding blocks are malformed"),
        profile: tool.schema.enum(["quiet", "chill", "assertive"]).optional(),
      },
      async execute(args) {
        const cliArgs = ["finalize", args.pr];
        if (args.from) cliArgs.push("--from", args.from);
        if (args.verdicts) cliArgs.push("--verdicts", args.verdicts);
        if (args.stage) cliArgs.push("--stage", args.stage);
        if (args.strict) cliArgs.push("--strict");
        if (args.profile) cliArgs.push("--profile", args.profile);
        const res = await runPeer(cliArgs, directory);
        if (res.exitCode !== 0) {
          throw new Error(res.stderr.trim() || res.stdout.trim() || `peer finalize exited ${res.exitCode}`);
        }
        return res.stdout.trim();
      },
    }),

    peer_publish: tool({
      description:
        "Upload the latest saved local review stage (01-analyze, 02-review, or 03-verify) to the GitHub PR as a PENDING draft (or submitted COMMENT with submit=true).",
      args: {
        pr: tool.schema.string().describe("PR number or full GitHub PR URL"),
        submit: tool.schema
          .boolean()
          .optional()
          .describe("Submit immediately as COMMENT instead of PENDING draft"),
      },
      async execute(args) {
        const cliArgs = ["publish", args.pr];
        if (args.submit) cliArgs.push("--submit");
        const res = await runPeer(cliArgs, directory);
        if (res.exitCode !== 0) {
          throw new Error(res.stderr.trim() || res.stdout.trim() || `peer publish exited ${res.exitCode}`);
        }
        return res.stdout.trim();
      },
    }),
  },
});

export default PeerRustReviewerPlugin;
