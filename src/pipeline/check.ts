import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { collectAstDeterministicFindings } from "../analyzers/ast-detectors.ts";
import { collectCargoLlvmCovReport, coverageReportToFindings } from "../analyzers/coverage.ts";
import {
  CargoDenyMissingError,
  collectCargoDenyDiagnostics,
  denyDiagnosticsToFindings,
  hasCargoDenyConfig,
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
import {
  type Finding,
  FindingSchema,
  type ReviewProfile,
  type ToolOutcomeDetail,
} from "../domain/models.ts";
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
  readonly allFiles?: boolean;
  readonly staged?: boolean;
  readonly json?: boolean;
  readonly quiet?: boolean;
  readonly writeOut: (text: string) => void;
  readonly writeErr: (text: string) => void;
}

const GIT_EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

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
    allFiles = false,
    staged = false,
    json = false,
    quiet = false,
    writeOut,
  } = input;

  const headSha = runGitSync(repoRoot, ["rev-parse", "HEAD"]);
  const baseSha = allFiles || staged ? headSha : resolveLocalBaseSha(repoRoot, baseRef);
  const peerConfig = await loadPeerConfig(repoRoot, baseSha);
  const profile: ReviewProfile = profileOverride ?? peerConfig.profile;

  const enabledTools = new Set<OptionalTool>(cliTools);
  for (const t of ["deny", "geiger", "semver", "coverage", "miri"] as const) {
    if (peerConfig.tools[t]) {
      enabledTools.add(t);
    }
  }

  // Support --all-files (diff against Git empty tree), --staged (pre-commit), or base...HEAD
  const diffArgs = allFiles
    ? ["diff", "--no-color", "--unified=3", GIT_EMPTY_TREE_SHA, "HEAD"]
    : staged
      ? ["diff", "--no-color", "--unified=3", "--cached"]
      : baseSha === headSha
        ? ["diff", "--no-color", "--unified=3", baseSha]
        : ["diff", "--no-color", "--unified=3", `${baseSha}...HEAD`];
  const diffAttempt = tryGitRawSync(repoRoot, diffArgs);
  if (!diffAttempt.ok) {
    throw new Error(
      `git ${diffArgs.join(" ")} failed: ${diffAttempt.stderr.trim() || "unable to compute merge-base diff"}. ` +
        `If running in CI with a shallow clone, configure actions/checkout with \`fetch-depth: 0\` or run \`git fetch --unshallow\`.`,
    );
  }
  const diffText = diffAttempt.stdout;

  const rawDiffMap = parseUnifiedDiff(diffText);
  const diffMap = filterCodeOnlyDiffMap(rawDiffMap, peerConfig.diff.ignore);
  const modifiedFiles = new Set(Object.keys(diffMap));
  const skippedTools: string[] = [];
  const toolOutcomes: Record<string, ToolOutcomeDetail> = {};

  for (const optTool of ["deny", "geiger", "semver", "coverage", "miri"] as const) {
    if (!enabledTools.has(optTool)) {
      toolOutcomes[optTool] = {
        status: "skipped",
        findingsCount: 0,
        reason: "not_enabled",
        remediationCommand: `peer check --tools ${optTool}`,
      };
    }
  }

  const runAuditWithPolicy = async () => {
    if (modifiedFiles.size === 0 || !peerConfig.tools.audit) {
      toolOutcomes.audit = {
        status: "skipped",
        findingsCount: 0,
        reason: modifiedFiles.size === 0 ? "no_modified_files" : "not_enabled",
      };
      return [];
    }
    try {
      return await collectSecurityAdvisories(repoRoot, { baseSha });
    } catch (err) {
      if (err instanceof CargoAuditMissingError) {
        skippedTools.push("cargo-audit (not installed — cargo install cargo-audit)");
        toolOutcomes.audit = {
          status: "skipped",
          findingsCount: 0,
          reason: "missing_binary",
          remediationCommand: "cargo install cargo-audit",
        };
        return [];
      }
      throw err;
    }
  };

  const runDenyWithPolicy = async () => {
    if (modifiedFiles.size === 0) {
      return [];
    }
    const hasConfig = await hasCargoDenyConfig(repoRoot);
    if (!hasConfig) {
      if (enabledTools.has("deny")) {
        skippedTools.push(
          "deny (skipped: no deny.toml or .cargo/deny.toml in repository; run 'cargo deny init' to configure)",
        );
        toolOutcomes.deny = {
          status: "skipped",
          findingsCount: 0,
          reason: "missing_config",
          remediationCommand: "cargo deny init",
        };
      }
      return [];
    }
    try {
      return await collectCargoDenyDiagnostics(repoRoot, { force: true });
    } catch (err) {
      if (err instanceof CargoDenyMissingError && !enabledTools.has("deny")) {
        skippedTools.push("cargo-deny (not installed — cargo install cargo-deny)");
        toolOutcomes.deny = {
          status: "skipped",
          findingsCount: 0,
          reason: "missing_binary",
          remediationCommand: "cargo install cargo-deny",
        };
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
        ? collectAstDeterministicFindings(repoRoot, diffMap, peerConfig.detectors)
        : Promise.resolve([]),
    ]);

  const modifiedCrates = new Set(
    Array.from(modifiedFiles)
      .map((fp) => resolveFileArchitecturalLayer(crateGraph, fp).crateName)
      .filter((name) => Boolean(crateGraph.crates[name])),
  );

  // Run heavy optional Cargo analyzers sequentially to avoid workspace target/ lock contention
  const geigerReport = await collectCargoGeigerReport(repoRoot, {
    enabled: enabledTools.has("geiger"),
    crateGraph,
  });
  const semverViolations = await collectCargoSemverViolations(repoRoot, {
    enabled: enabledTools.has("semver"),
    baseSha,
  });
  const coverageReport = await collectCargoLlvmCovReport(repoRoot, diffMap, {
    enabled: enabledTools.has("coverage"),
    packages: Array.from(modifiedCrates),
  });
  const miriReport = await collectMiriReport(repoRoot, diffMap, {
    enabled: enabledTools.has("miri"),
    crateGraph,
  });
  if (miriReport?.skippedReason) {
    skippedTools.push(`miri (skipped: ${miriReport.skippedReason})`);
  }

  const sensitiveFileFindings = findSensitiveFiles(Object.keys(rawDiffMap)).map((filePath) =>
    FindingSchema.parse({
      id: `audit-sensitive-file-${filePath.replace(/[^a-z0-9]+/gi, "-")}`,
      filePath,
      startLine: 1,
      endLine: 1,
      severity: "Info",
      type: "Security",
      epistemicState: "NEEDS-RUNTIME-VERIFICATION",
      evidenceMechanism: "Security",
      title: `Sensitive file modified (needs human review): \`${filePath}\``,
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

  const clippyFindings = clippyToFindings(clippyDiagnostics, diffMap);
  const auditFindings = await advisoriesToFindings(securityAdvisories, repoRoot, crateGraph);
  const denyFindings = denyDiagnosticsToFindings(denyDiagnostics);
  const geigerFindings = geigerReport
    ? geigerReportToFindings(geigerReport, modifiedCrates, crateGraph)
    : [];
  const semverFindings = semverViolationsToFindings(semverViolations);
  const coverageFindings = coverageReport ? coverageReportToFindings(coverageReport) : [];
  const miriFindings = miriReport ? miriReportToFindings(miriReport) : [];

  toolOutcomes.clippy ??= { status: "ok", findingsCount: clippyFindings.length };
  toolOutcomes.audit ??= { status: "ok", findingsCount: auditFindings.length };
  if (enabledTools.has("deny") && !toolOutcomes.deny) {
    toolOutcomes.deny = { status: "ok", findingsCount: denyFindings.length };
  }
  if (enabledTools.has("geiger") && !toolOutcomes.geiger) {
    toolOutcomes.geiger = { status: "ok", findingsCount: geigerFindings.length };
  }
  if (enabledTools.has("semver") && !toolOutcomes.semver) {
    toolOutcomes.semver = { status: "ok", findingsCount: semverFindings.length };
  }
  if (enabledTools.has("coverage") && !toolOutcomes.coverage) {
    toolOutcomes.coverage = { status: "ok", findingsCount: coverageFindings.length };
  }
  if (enabledTools.has("miri")) {
    toolOutcomes.miri = miriReport?.skippedReason
      ? { status: "skipped", findingsCount: 0, reason: "no_unsafe_in_diff" }
      : { status: "ok", findingsCount: miriFindings.length };
  }

  const rawFindings: Finding[] = [
    ...clippyFindings,
    ...auditFindings,
    ...denyFindings,
    ...geigerFindings,
    ...semverFindings,
    ...coverageFindings,
    ...miriFindings,
    ...astFindings,
    ...sensitiveFileFindings,
  ];

  const partitioned = partitionAndFilterFindings(rawFindings, diffMap, profile);
  const allActionable = [...partitioned.inlineFindings, ...partitioned.outsideDiffFindings];

  if (updateBaseline) {
    const baselinePath = await saveBaselineFingerprints(repoRoot, allActionable);
    if (json || quiet) {
      writeOut(
        JSON.stringify(
          {
            status: "baseline_updated",
            fingerprintsCount: allActionable.length,
            baselinePath: resolve(baselinePath),
          },
          null,
          quiet ? undefined : 2,
        ),
      );
      return 0;
    }
    writeOut(
      `Updated baseline with ${allActionable.length} finding fingerprint(s): file://${resolve(baselinePath)}`,
    );
    return 0;
  }

  // Load baseline strictly from trusted baseSha when comparing a branch/PR against base
  const baselineRef = baseSha !== headSha ? baseSha : undefined;
  const baseline = await loadBaselineFingerprints(repoRoot, baselineRef);
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
    if (!json && !quiet) {
      writeOut(`SARIF report written: file://${absSarif}`);
    }
  }

  const blockingFindings = strict
    ? newFindings
    : newFindings.filter((f) => f.severity === "Critical" || f.severity === "Major");
  const exitCode = blockingFindings.length > 0 ? 1 : 0;

  if (json || quiet) {
    const countsBySeverity = {
      Critical: newFindings.filter((f) => f.severity === "Critical").length,
      Major: newFindings.filter((f) => f.severity === "Major").length,
      Minor: newFindings.filter((f) => f.severity === "Minor").length,
      Trivial: newFindings.filter((f) => f.severity === "Trivial").length,
      Info: newFindings.filter((f) => f.severity === "Info").length,
    };
    writeOut(
      JSON.stringify(
        {
          exitCode,
          baseSha,
          headSha,
          profile,
          modifiedRustFiles: modifiedFiles.size,
          newCount: newFindings.length,
          blockingCount: blockingFindings.length,
          baselinedCount,
          countsBySeverity,
          enabledTools: Array.from(enabledTools).sort(),
          skippedTools,
          toolOutcomes,
          reportMd: resolve(localDir, "report.md"),
          sarifPath: sarifPath ? resolve(sarifPath) : null,
          findings: newFindings.map((f) => ({
            id: f.id,
            severity: f.severity,
            type: f.type,
            filePath: f.filePath,
            startLine: f.startLine,
            endLine: f.endLine,
            title: f.title,
            rootCause: f.rootCause,
            verificationCommand: f.verificationCommand,
          })),
        },
        null,
        quiet ? undefined : 2,
      ),
    );
    return exitCode;
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

  return exitCode;
}
