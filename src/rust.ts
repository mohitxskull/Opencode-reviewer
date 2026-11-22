import { dirname, relative } from "node:path";
import {
  type ClippyDiagnostic,
  ClippyDiagnosticSchema,
  type CrateGraph,
  CrateGraphSchema,
  type CrateLayerInfo,
  type ReviewBaselineHeader,
  ReviewBaselineHeaderSchema,
} from "./models.ts";

export function collectRustToolchainBaseline(repoRoot: string): ReviewBaselineHeader {
  const rustcProc = Bun.spawnSync(["rustc", "--version"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const cargoProc = Bun.spawnSync(["cargo", "--version"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  const rustcVersion =
    rustcProc.exitCode === 0 ? rustcProc.stdout.toString().trim() : "rustc (unknown)";
  const cargoVersion =
    cargoProc.exitCode === 0 ? cargoProc.stdout.toString().trim() : "cargo (unknown)";

  return ReviewBaselineHeaderSchema.parse({
    mode: "REVIEW",
    rustcVersion,
    cargoVersion,
    verificationCommands: [
      "cargo clippy --workspace --all-targets -- -D warnings",
      "cargo fmt --all --check",
      "cargo test --workspace",
    ],
  });
}

interface CargoMetadataPackage {
  id: string;
  name: string;
  manifest_path: string;
  dependencies: Array<{ name: string; kind: string | null }>;
}

interface CargoMetadataPayload {
  packages: CargoMetadataPackage[];
  workspace_members: string[];
  workspace_root: string;
}

export async function collectCrateGraph(repoRoot: string): Promise<CrateGraph> {
  const proc = Bun.spawnSync(["cargo", "metadata", "--format-version", "1", "--no-deps"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (proc.exitCode !== 0) {
    return CrateGraphSchema.parse({
      crates: {},
      testLayer: 1,
    });
  }

  const payload = JSON.parse(proc.stdout.toString()) as CargoMetadataPayload;
  const memberIds = new Set(payload.workspace_members);
  const memberPackages = payload.packages.filter((pkg) => memberIds.has(pkg.id));
  const memberNames = new Set(memberPackages.map((pkg) => pkg.name));

  const internalDepsByCrate = new Map<string, string[]>();
  const manifestDirByCrate = new Map<string, string>();

  for (const pkg of memberPackages) {
    const absManifestDir = dirname(pkg.manifest_path);
    const relDir = relative(payload.workspace_root, absManifestDir).replace(/\\/g, "/");
    manifestDirByCrate.set(pkg.name, relDir);

    const internalDeps = pkg.dependencies
      .filter((dep) => dep.kind === null && memberNames.has(dep.name) && dep.name !== pkg.name)
      .map((dep) => dep.name);
    internalDepsByCrate.set(pkg.name, Array.from(new Set(internalDeps)));
  }

  const computedLayers = new Map<string, number>();
  const visiting = new Set<string>();

  const computeDepth = (crateName: string): number => {
    const cached = computedLayers.get(crateName);
    if (cached !== undefined) {
      return cached;
    }
    if (visiting.has(crateName)) {
      return 0;
    }
    visiting.add(crateName);
    const deps = internalDepsByCrate.get(crateName) ?? [];
    let depth = 0;
    for (const dep of deps) {
      depth = Math.max(depth, 1 + computeDepth(dep));
    }
    visiting.delete(crateName);
    computedLayers.set(crateName, depth);
    return depth;
  };

  const cratesRecord: Record<string, CrateLayerInfo> = {};
  let maxLayer = 0;

  for (const pkg of memberPackages) {
    const layer = computeDepth(pkg.name);
    maxLayer = Math.max(maxLayer, layer);
    cratesRecord[pkg.name] = {
      name: pkg.name,
      manifestDir: manifestDirByCrate.get(pkg.name) ?? "",
      layer,
      dependencies: internalDepsByCrate.get(pkg.name) ?? [],
    };
  }

  return CrateGraphSchema.parse({
    crates: cratesRecord,
    testLayer: maxLayer + 1,
  });
}

export function resolveFileArchitecturalLayer(
  graph: CrateGraph,
  filePath: string,
): { crateName: string; layer: number } {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const segments = normalized.split("/");
  const isVerificationFile =
    segments.includes("tests") || segments.includes("benches") || normalized.endsWith("_test.rs");

  let matchedCrate: CrateLayerInfo | null = null;
  for (const info of Object.values(graph.crates)) {
    if (info.manifestDir === "") {
      if (!matchedCrate) {
        matchedCrate = info;
      }
      continue;
    }
    if (normalized === info.manifestDir || normalized.startsWith(`${info.manifestDir}/`)) {
      if (!matchedCrate || info.manifestDir.length > matchedCrate.manifestDir.length) {
        matchedCrate = info;
      }
    }
  }

  const crateName = matchedCrate?.name ?? "workspace";
  const layer = isVerificationFile ? graph.testLayer : (matchedCrate?.layer ?? 0);
  return { crateName, layer };
}

interface RustcSpanText {
  text: string;
  highlight_start: number;
  highlight_end: number;
}

interface RustcSpan {
  file_name: string;
  line_start: number;
  line_end: number;
  column_start?: number;
  column_end?: number;
  is_primary: boolean;
  text?: RustcSpanText[];
  suggested_replacement?: string | null;
  suggestion_applicability?: string | null;
}

interface RustcCompilerMessage {
  level: string;
  message: string;
  code?: { code: string } | null;
  spans?: RustcSpan[];
  rendered?: string | null;
  children?: RustcCompilerMessage[];
}

interface CargoJsonLine {
  reason?: string;
  message?: RustcCompilerMessage;
}

function spliceSpanReplacementIntoFullLine(span: RustcSpan): string | null {
  if (typeof span.suggested_replacement !== "string" || span.line_start !== span.line_end) {
    return null;
  }
  if (
    span.suggestion_applicability &&
    span.suggestion_applicability !== "MachineApplicable" &&
    span.suggestion_applicability !== "MaybeIncorrect"
  ) {
    return null;
  }

  const lineEntry = span.text?.[0];
  const colStart = span.column_start ?? lineEntry?.highlight_start;
  const colEnd = span.column_end ?? lineEntry?.highlight_end;

  if (
    lineEntry &&
    typeof lineEntry.text === "string" &&
    typeof colStart === "number" &&
    typeof colEnd === "number" &&
    colStart >= 1 &&
    colEnd >= colStart
  ) {
    const chars = Array.from(lineEntry.text);
    if (colEnd - 1 <= chars.length) {
      const prefix = chars.slice(0, colStart - 1).join("");
      const suffix = chars.slice(colEnd - 1).join("");
      const spliced = `${prefix}${span.suggested_replacement}${suffix}`;
      return spliced.trim().length > 0 ? spliced : null;
    }
  }

  return span.suggested_replacement.trim().length > 0 ? span.suggested_replacement : null;
}

function findSuggestedReplacement(msg: RustcCompilerMessage): string | null {
  const candidates: Array<{ span: RustcSpan; spliced: string }> = [];
  const collect = (node: RustcCompilerMessage) => {
    for (const span of node.spans ?? []) {
      const spliced = spliceSpanReplacementIntoFullLine(span);
      if (spliced !== null) {
        candidates.push({ span, spliced });
      }
    }
    for (const child of node.children ?? []) {
      collect(child);
    }
  };
  collect(msg);

  if (candidates.length === 0) {
    return null;
  }

  // Group multi-span replacements on the same line (e.g. clippy::needless_return emits
  // one span replacing `return x + 1` with `x + 1` and a second span deleting `;`)
  const firstLine = candidates[0]?.span.line_start;
  const sameLineSpans = candidates
    .map((c) => c.span)
    .filter(
      (s) =>
        s.line_start === firstLine &&
        typeof s.column_start === "number" &&
        typeof s.column_end === "number",
    );

  const lineText = sameLineSpans[0]?.text?.[0]?.text;
  if (sameLineSpans.length > 1 && typeof lineText === "string") {
    const sortedDesc = [...sameLineSpans].sort(
      (a, b) => (b.column_start ?? 0) - (a.column_start ?? 0),
    );
    let chars = Array.from(lineText);
    for (const span of sortedDesc) {
      const cStart = (span.column_start ?? 1) - 1;
      const cEnd = (span.column_end ?? 1) - 1;
      if (cStart >= 0 && cEnd >= cStart && cEnd <= chars.length) {
        chars = [
          ...chars.slice(0, cStart),
          ...Array.from(span.suggested_replacement ?? ""),
          ...chars.slice(cEnd),
        ];
      }
    }
    const combined = chars.join("");
    return combined.trim().length > 0 ? combined : null;
  }

  return candidates[0]?.spliced ?? null;
}

export async function collectClippyDiagnostics(
  repoRoot: string,
  modifiedFiles: ReadonlySet<string>,
): Promise<ClippyDiagnostic[]> {
  const proc = Bun.spawn(
    ["cargo", "clippy", "--workspace", "--all-targets", "--message-format=json"],
    {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [stdoutText] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const lines = stdoutText.split("\n");
  const diagnostics: ClippyDiagnostic[] = [];
  const seenKeys = new Set<string>();

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    let parsed: CargoJsonLine;
    try {
      parsed = JSON.parse(trimmed) as CargoJsonLine;
    } catch {
      continue;
    }
    if (parsed.reason !== "compiler-message" || !parsed.message) {
      continue;
    }

    const msg = parsed.message;
    if (msg.level !== "error" && msg.level !== "warning") {
      continue;
    }

    const primarySpan = msg.spans?.find((s) => s.is_primary) ?? msg.spans?.[0];
    if (!primarySpan) {
      continue;
    }

    const normalizedPath = primarySpan.file_name.replace(/\\/g, "/").replace(/^\.\//, "");

    // Keep all workspace errors, and warnings that touch modified files
    if (msg.level === "warning" && !modifiedFiles.has(normalizedPath)) {
      continue;
    }

    const startLine = Math.max(1, primarySpan.line_start);
    const endLine = Math.max(startLine, primarySpan.line_end);
    const code = msg.code?.code ?? null;
    const dedupKey = `${normalizedPath}:${startLine}:${endLine}:${code ?? ""}:${msg.message}`;
    if (seenKeys.has(dedupKey)) {
      continue;
    }
    seenKeys.add(dedupKey);

    diagnostics.push(
      ClippyDiagnosticSchema.parse({
        filePath: normalizedPath,
        startLine,
        endLine,
        level: msg.level,
        code,
        message: msg.message,
        rendered: msg.rendered ?? msg.message,
        suggestedReplacement: findSuggestedReplacement(msg),
      }),
    );
  }

  return diagnostics;
}
