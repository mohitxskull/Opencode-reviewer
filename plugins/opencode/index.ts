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
    peer_analyze: tool({
      description:
        "Run Stage 1 deterministic Rust PR analysis (git diff, clippy, cargo-audit CVE delta, Cargo.lock diff, Tree-sitter AST symbol graph, and optional deny/geiger/semver/coverage/miri). Writes .peer/<pr>/<sha>/01-analyze/prompt-context.md.",
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
        "Run Judge merge + transactional `cargo check` suggestion verification on an agent's Structured Markdown or JSON review file, writing 02-review/ (or 03-verify/) and .peer/<pr>/<sha>/review.md.",
      args: {
        pr: tool.schema.string().describe("PR number or full GitHub PR URL"),
        from: tool.schema.string().describe("Path to the agent review Markdown or JSON file"),
        stage: tool.schema
          .enum(["review", "verify"])
          .optional()
          .describe("Target stage folder (default: review)"),
        profile: tool.schema.enum(["quiet", "chill", "assertive"]).optional(),
      },
      async execute(args) {
        const cliArgs = ["finalize", args.pr, "--from", args.from];
        if (args.stage) cliArgs.push("--stage", args.stage);
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
