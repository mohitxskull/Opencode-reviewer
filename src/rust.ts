import { dirname, relative } from "node:path";
import { buildScrubbedCargoEnv } from "./env.ts";
import {
  type ClippyDiagnostic,
  ClippyDiagnosticSchema,
  type CrateGraph,
  CrateGraphSchema,
  type CrateLayerInfo,
  type DiffFileMap,
  type ReviewBaselineHeader,
  ReviewBaselineHeaderSchema,
} from "./models.ts";

export function collectRustToolchainBaseline(repoRoot: string): ReviewBaselineHeader {
  const env = buildScrubbedCargoEnv();
  const rustcProc = Bun.spawnSync(["rustc", "--version"], {
    cwd: repoRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const cargoProc = Bun.spawnSync(["cargo", "--version"], {
    cwd: repoRoot,
    env,
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
  const proc = Bun.spawn(["cargo", "metadata", "--format-version", "1", "--no-deps"], {
    cwd: repoRoot,
    env: buildScrubbedCargoEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdoutText, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    return CrateGraphSchema.parse({
      crates: {},
      testLayer: 1,
    });
  }

  const payload = JSON.parse(stdoutText) as CargoMetadataPayload;
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

export interface RustcSpanText {
  text: string;
  highlight_start: number;
  highlight_end: number;
}

export interface RustcSpan {
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

export interface RustcCompilerMessage {
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

function spliceSingleNodeSpans(
  node: RustcCompilerMessage,
  primarySpan?: Pick<RustcSpan, "file_name" | "line_start" | "line_end">,
): string | null {
  const normalizedPrimaryFile = primarySpan?.file_name.replace(/\\/g, "/").replace(/^\.\//, "");
  const validSpans = (node.spans ?? []).filter((span) => {
    if (
      typeof span.suggested_replacement !== "string" ||
      span.line_start !== span.line_end ||
      (span.suggestion_applicability && span.suggestion_applicability !== "MachineApplicable")
    ) {
      return false;
    }
    if (primarySpan) {
      const normalizedSpanFile = span.file_name.replace(/\\/g, "/").replace(/^\.\//, "");
      if (
        normalizedSpanFile !== normalizedPrimaryFile ||
        primarySpan.line_start !== primarySpan.line_end ||
        span.line_start !== primarySpan.line_start
      ) {
        return false;
      }
    }
    return true;
  });

  if (validSpans.length === 0) {
    return null;
  }

  const firstSpan = validSpans[0];
  if (!firstSpan) {
    return null;
  }

  const targetLine = firstSpan.line_start;
  const sameLineSpans = validSpans.filter((s) => s.line_start === targetLine);
  const lineText = sameLineSpans[0]?.text?.[0]?.text;

  if (
    sameLineSpans.length >= 1 &&
    typeof lineText === "string" &&
    sameLineSpans.every(
      (s) =>
        typeof (s.column_start ?? s.text?.[0]?.highlight_start) === "number" &&
        typeof (s.column_end ?? s.text?.[0]?.highlight_end) === "number",
    )
  ) {
    const withCols = sameLineSpans
      .map((s) => ({
        span: s,
        start: (s.column_start ?? s.text?.[0]?.highlight_start ?? 1) - 1,
        end: (s.column_end ?? s.text?.[0]?.highlight_end ?? 1) - 1,
      }))
      .sort((a, b) => b.start - a.start);

    // Reject overlapping column intervals within the same node
    for (let i = 0; i < withCols.length - 1; i++) {
      const right = withCols[i];
      const left = withCols[i + 1];
      if (right && left && left.end > right.start) {
        return null;
      }
    }

    let chars = Array.from(lineText);
    for (const item of withCols) {
      if (item.start >= 0 && item.end >= item.start && item.end <= chars.length) {
        chars = [
          ...chars.slice(0, item.start),
          ...Array.from(item.span.suggested_replacement ?? ""),
          ...chars.slice(item.end),
        ];
      }
    }
    const combined = chars.join("");
    return combined.trim().length > 0 ? combined : null;
  }

  const raw = firstSpan.suggested_replacement ?? "";
  return raw.trim().length > 0 ? raw : null;
}

export function findSuggestedReplacementForMessage(
  msg: RustcCompilerMessage,
  primarySpan?: Pick<RustcSpan, "file_name" | "line_start" | "line_end">,
): string | null {
  const effectivePrimary = primarySpan ?? msg.spans?.find((s) => s.is_primary) ?? msg.spans?.[0];
  const direct = spliceSingleNodeSpans(msg, effectivePrimary);
  if (direct !== null) {
    return direct;
  }
  for (const child of msg.children ?? []) {
    const childResult = findSuggestedReplacementForMessage(child, effectivePrimary);
    if (childResult !== null) {
      return childResult;
    }
  }
  return null;
}

export async function collectClippyDiagnostics(
  repoRoot: string,
  modifiedFiles: ReadonlySet<string>,
  diffMap?: Readonly<Record<string, DiffFileMap>>,
): Promise<ClippyDiagnostic[]> {
  if (modifiedFiles.size === 0) {
    return [];
  }

  const proc = Bun.spawn(
    ["cargo", "clippy", "--workspace", "--all-targets", "--message-format=json"],
    {
      cwd: repoRoot,
      env: buildScrubbedCargoEnv(),
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const jsonlPayload = stdoutText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .join("\n");
  const parsedLines: CargoJsonLine[] = [];
  if (jsonlPayload.length > 0) {
    let offset = 0;
    while (offset < jsonlPayload.length) {
      const chunk = Bun.JSONL.parseChunk(jsonlPayload.slice(offset));
      for (const val of chunk.values) {
        if (val && typeof val === "object") {
          parsedLines.push(val as CargoJsonLine);
        }
      }
      if (chunk.done) {
        break;
      }
      if (chunk.read > 0) {
        offset += chunk.read;
      } else {
        const nextNl = jsonlPayload.indexOf("\n", offset);
        if (nextNl === -1) break;
        offset = nextNl + 1;
      }
    }
  }
  const diagnostics: ClippyDiagnostic[] = [];
  const seenKeys = new Set<string>();
  const sawAnyJsonMessage = parsedLines.length > 0;

  for (const parsed of parsedLines) {
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

    // When diffMap is provided, filter warnings to modified diff hunks (+/- 3 lines)
    // so pre-existing warnings on untouched lines of a modified file don't add noise.
    if (msg.level === "warning" && diffMap) {
      const fm = diffMap[normalizedPath];
      if (
        fm &&
        !fm.hunks.some((h) => startLine <= h.newEnd + 3 && endLine >= Math.max(1, h.newStart - 3))
      ) {
        continue;
      }
    }
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
        suggestedReplacement: findSuggestedReplacementForMessage(msg, primarySpan),
      }),
    );
  }

  if (exitCode !== 0 && !sawAnyJsonMessage && stderrText.trim().length > 0) {
    throw new Error(`cargo clippy failed (exit ${exitCode}): ${stderrText.trim().slice(0, 300)}`);
  }

  return diagnostics;
}
