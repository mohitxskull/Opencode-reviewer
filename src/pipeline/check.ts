import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { collectAstDeterministicFindings } from "../analyzers/ast-detectors.ts";
import { collectCargoLlvmCovReport, coverageReportToFindings } from "../analyzers/coverage.ts";
import {
  CargoDenyMissingError,
  collectCargoDenyDiagnostics,
  denyDiagnosticsToFindings,
} from "../analyzers/deny.ts";
import { collectCargoGeigerReport, geigerReportToFindings } from "../analyzers/geiger.ts";
import { collectMiriReport, miriReportToFindings } from "../analyzers/miri.ts";
import {
  collectClippyDiagnostics,
  collectCrateGraph,
  resolveFileArchitecturalLayer,
} from "../analyzers/rust.ts";
import { CargoAuditMissingError, collectSecurityAdvisories } from "../analyzers/security.ts";
import { collectCargoSemverViolations, semverViolationsToFindings } from "../analyzers/semver.ts";
import { filterCodeOnlyDiffMap, findSensitiveFiles, parseUnifiedDiff } from "../domain/diff.ts";
import { type Finding, FindingSchema, type ReviewProfile } from "../domain/models.ts";
import {
  advisoriesToFindings,
  clippyToFindings,
  partitionAndFilterFindings,
} from "../judge/partition.ts";
import { renderSarifReport } from "../render/sarif.ts";
import {
  filterFindingsByBaseline,
  loadBaselineFingerprints,
  saveBaselineFingerprints,
} from "../workspace/baseline.ts";
import { loadPeerConfig } from "../workspace/config.ts";
import { ensurePeerWorkspaceExcluded, runGitSync, tryGitRawSync } from "../workspace/git.ts";
import type { OptionalTool } from "./analyze.ts";

export interface CheckGateInput {
  readonly repoRoot: string;
  readonly baseRef?: string;
  readonly profileOverride?: ReviewProfile;
  readonly cliTools: ReadonlySet<OptionalTool>;
  readonly sarifPath?: string;
  readonly updateBaseline?: boolean;
  readonly strict?: boolean;
  readonly writeOut: (text: string) => void;
  readonly writeErr: (text: string) => void;
}

function resolveLocalBaseSha(repoRoot: string, explicitBase?: string): string {
  const candidates = explicitBase ? [explicitBase] : ["main", "master", "HEAD~1"];
  for (const ref of candidates) {
    const attempt = tryGitRawSync(repoRoot, ["rev-parse", "--verify", ref]);
    if (attempt.ok && attempt.stdout.trim().length > 0) {
      return attempt.stdout.trim();
    }
  }
  throw new Error(
    `Unable to resolve base git ref (${candidates.join(", ")}). Pass --base <ref> explicitly.`,
  );
}

export async function runCheckGate(input: CheckGateInput): Promise<number> {
  const {
    repoRoot,
    baseRef,
    profileOverride,
    cliTools,
    sarifPath,
    updateBaseline = false,
    strict = false,
    writeOut,
  } = input;

  const baseSha = resolveLocalBaseSha(repoRoot, baseRef);
  const headSha = runGitSync(repoRoot, ["rev-parse", "HEAD"]);
  const peerConfig = await loadPeerConfig(repoRoot, baseSha);
  const profile: ReviewProfile = profileOverride ?? peerConfig.profile;

  const enabledTools = new Set<OptionalTool>(cliTools);
  for (const t of ["deny", "geiger", "semver", "coverage", "miri"] as const) {
    if (peerConfig.tools[t]) {
      enabledTools.add(t);
    }
  }

  // If HEAD === baseSha, diff against working tree so `peer check` works on uncommitted edits too
  const diffArgs =
    baseSha === headSha
      ? ["diff", "--no-color", "--unified=3", baseSha]
      : ["diff", "--no-color", "--unified=3", `${baseSha}...HEAD`];
  const diffAttempt = tryGitRawSync(repoRoot, diffArgs);
  const diffText = diffAttempt.ok ? diffAttempt.stdout : "";

  const rawDiffMap = parseUnifiedDiff(diffText);
  const diffMap = filterCodeOnlyDiffMap(rawDiffMap, peerConfig.diff.ignore);
  const modifiedFiles = new Set(Object.keys(diffMap));
  const skippedTools: string[] = [];

  const runAuditWithPolicy = async () => {
    if (modifiedFiles.size === 0 || !peerConfig.tools.audit) {
      return [];
    }
    try {
      return await collectSecurityAdvisories(repoRoot, { baseSha });
    } catch (err) {
      if (err instanceof CargoAuditMissingError) {
        skippedTools.push("cargo-audit (not installed — cargo install cargo-audit)");
        return [];
      }
      throw err;
    }
  };

  const runDenyWithPolicy = async () => {
    if (modifiedFiles.size === 0) {
      return [];
    }
    try {
      return await collectCargoDenyDiagnostics(repoRoot, { force: enabledTools.has("deny") });
    } catch (err) {
      if (err instanceof CargoDenyMissingError && !enabledTools.has("deny")) {
        skippedTools.push("cargo-deny (not installed — cargo install cargo-deny)");
        return [];
      }
      throw err;
    }
  };

  const [crateGraph, clippyDiagnostics, securityAdvisories, denyDiagnostics, astFindings] =
    await Promise.all([
      collectCrateGraph(repoRoot),
      modifiedFiles.size > 0 && peerConfig.tools.clippy
        ? collectClippyDiagnostics(repoRoot, modifiedFiles, diffMap)
        : Promise.resolve([]),
      runAuditWithPolicy(),
      runDenyWithPolicy(),
      modifiedFiles.size > 0
        ? collectAstDeterministicFindings(repoRoot, diffMap)
        : Promise.resolve([]),
    ]);

  const modifiedCrates = new Set(
    Array.from(modifiedFiles)
      .map((fp) => resolveFileArchitecturalLayer(crateGraph, fp).crateName)
      .filter((name) => Boolean(crateGraph.crates[name])),
  );

  const [geigerReport, semverViolations, coverageReport, miriReport] = await Promise.all([
    collectCargoGeigerReport(repoRoot, { enabled: enabledTools.has("geiger"), crateGraph }),
    collectCargoSemverViolations(repoRoot, { enabled: enabledTools.has("semver"), baseSha }),
    collectCargoLlvmCovReport(repoRoot, diffMap, {
      enabled: enabledTools.has("coverage"),
      packages: Array.from(modifiedCrates),
    }),
    collectMiriReport(repoRoot, diffMap, { enabled: enabledTools.has("miri"), crateGraph }),
  ]);

  const sensitiveFileFindings = findSensitiveFiles(Object.keys(rawDiffMap)).map((filePath) =>
    FindingSchema.parse({
      id: `audit-sensitive-file-${filePath.replace(/[^a-z0-9]+/gi, "-")}`,
      filePath,
      startLine: 1,
      endLine: 1,
      severity: "Major",
      type: "Security",
      epistemicState: "NEEDS-RUNTIME-VERIFICATION",
      evidenceMechanism: "Security",
      title: `Sensitive build/toolchain/CI file modified: \`${filePath}\``,
      body: `Security-sensitive file \`${filePath}\` was modified.`,
      rootCause: `Modification to sensitive configuration file ${filePath}`,
      blastRadius: "Build pipeline / toolchain / CI security boundary",
      reversible: true,
      dependsOn: null,
      verificationCommand: `git diff ${baseSha.slice(0, 7)} -- ${filePath}`,
      traceability: `deterministic sensitive-file detector (${filePath})`,
      suggestion: null,
      suggestionVerified: false,
      agentPrompt: `Manually audit changes to sensitive file \`${filePath}\`.`,
      confidence: 1.0,
      source: "audit",
    }),
  );

  const rawFindings: Finding[] = [
    ...clippyToFindings(clippyDiagnostics, diffMap),
    ...(await advisoriesToFindings(securityAdvisories, repoRoot, crateGraph)),
    ...denyDiagnosticsToFindings(denyDiagnostics),
    ...(geigerReport ? geigerReportToFindings(geigerReport, modifiedCrates, crateGraph) : []),
    ...semverViolationsToFindings(semverViolations),
    ...(coverageReport ? coverageReportToFindings(coverageReport) : []),
    ...(miriReport ? miriReportToFindings(miriReport) : []),
    ...astFindings,
    ...sensitiveFileFindings,
  ];

  const partitioned = partitionAndFilterFindings(rawFindings, diffMap, profile);
  const allActionable = [...partitioned.inlineFindings, ...partitioned.outsideDiffFindings];

  if (updateBaseline) {
    const baselinePath = await saveBaselineFingerprints(repoRoot, allActionable);
    writeOut(
      `Updated baseline with ${allActionable.length} finding fingerprint(s): file://${resolve(baselinePath)}`,
    );
    return 0;
  }

  const baseline = await loadBaselineFingerprints(repoRoot);
  const { newFindings, baselinedCount } = filterFindingsByBaseline(allActionable, baseline);

  // Persist local check report under .peer/local/<short-sha>/
  await ensurePeerWorkspaceExcluded(repoRoot);
  const localDir = join(repoRoot, ".peer", "local", headSha.slice(0, 7));
  await mkdir(localDir, { recursive: true });
  const reportMd = [
    `# peer check — Local Deterministic Gate (${baseSha.slice(0, 7)}..${headSha.slice(0, 7)})`,
    "",
    `- **Profile:** \`${profile}\` | **Modified Rust Files:** ${modifiedFiles.size}`,
    `- **New Findings:** ${newFindings.length} | **Baselined (Ignored):** ${baselinedCount}`,
    ...(skippedTools.length > 0 ? [`- **Tools Skipped:** ${skippedTools.join("; ")}`] : []),
    "",
    ...newFindings.map(
      (f) => `- **[${f.severity} | ${f.type}]** \`${f.filePath}:${f.startLine}\` — ${f.title}`,
    ),
    "",
  ].join("\n");
  await Bun.write(join(localDir, "report.md"), reportMd);

  if (sarifPath) {
    const absSarif = resolve(sarifPath);
    await Bun.write(absSarif, renderSarifReport(newFindings));
    writeOut(`SARIF report written: file://${absSarif}`);
  }

  writeOut(
    `peer check (${baseSha.slice(0, 7)}..${headSha.slice(0, 7)}, profile=${profile}): ${newFindings.length} new finding(s), ${baselinedCount} baselined.`,
  );
  if (newFindings.length > 0) {
    writeOut(
      Bun.inspect.table(
        newFindings.map((f) => ({
          Severity: f.severity,
          Type: f.type,
          Location: `${f.filePath}:${f.startLine}`,
          Title: f.title.length > 56 ? `${f.title.slice(0, 53)}...` : f.title,
        })),
        ["Severity", "Type", "Location", "Title"],
      ),
    );
  }
  if (skippedTools.length > 0) {
    writeOut(`Tools skipped: ${skippedTools.join("; ")}`);
  }
  writeOut(`Report: file://${resolve(localDir, "report.md")}`);

  const blockingFindings = strict
    ? newFindings
    : newFindings.filter((f) => f.severity === "Critical" || f.severity === "Major");
  return blockingFindings.length > 0 ? 1 : 0;
}
