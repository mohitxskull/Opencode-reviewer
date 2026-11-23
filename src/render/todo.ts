import type { Finding, ReviewBundle, Severity } from "../domain/models.ts";

export type PriorityTier = "P0" | "P1" | "P2" | "P3";

export interface ReviewTodoItem {
  readonly id: string;
  readonly severity: Severity;
  readonly type: Finding["type"];
  readonly epistemicState: Finding["epistemicState"];
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly title: string;
  readonly rootCause: string;
  readonly blastRadius: string;
  readonly dependsOn: string | null;
  readonly verificationCommand: string;
  readonly suggestion: string | null;
  readonly suggestionVerified: boolean;
  readonly agentPrompt: string;
}

export interface ReviewTodoGroup {
  readonly groupId: string;
  readonly priority: PriorityTier;
  readonly rootCause: string;
  readonly files: readonly string[];
  readonly verificationCommands: readonly string[];
  readonly items: readonly ReviewTodoItem[];
}

export interface ReviewTodoQueue {
  readonly prNumber: number;
  readonly headSha: string;
  readonly totalActionable: number;
  readonly verifiedSuggestions: number;
  readonly countsByPriority: Readonly<Record<PriorityTier, number>>;
  readonly groups: readonly ReviewTodoGroup[];
}

const TIER_META: Record<PriorityTier, { heading: string; desc: string }> = {
  P0: { heading: "P0 — Critical", desc: "Fix immediately before merge" },
  P1: { heading: "P1 — Major", desc: "Fix before merge" },
  P2: { heading: "P2 — Minor", desc: "Fix or explicitly defer" },
  P3: { heading: "P3 — Trivial / Info", desc: "Optional hardening or acknowledgment" },
};

function severityToTier(severity: Severity): PriorityTier {
  switch (severity) {
    case "Critical":
      return "P0";
    case "Major":
      return "P1";
    case "Minor":
      return "P2";
    default:
      return "P3";
  }
}

function groupKeyForFinding(f: Finding): string {
  const dir = f.filePath.split("/").slice(0, -1).join("/") || ".";
  const normCause = (f.rootCause || f.title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 48);
  return `${dir}::${normCause}`;
}

/**
 * Deterministically builds a machine-readable `todo.json` fix queue for coding agents.
 */
export function buildReviewTodoQueue(bundle: ReviewBundle): ReviewTodoQueue {
  const allFindings = [...bundle.findings, ...(bundle.outsideDiffFindings ?? [])];
  const byTier: Record<PriorityTier, Finding[]> = { P0: [], P1: [], P2: [], P3: [] };
  for (const f of allFindings) {
    byTier[severityToTier(f.severity)].push(f);
  }

  const groups: ReviewTodoGroup[] = [];
  let groupSeq = 1;

  for (const tier of ["P0", "P1", "P2", "P3"] as const) {
    const items = byTier[tier];
    if (items.length === 0) {
      continue;
    }
    const bucketed = new Map<string, Finding[]>();
    for (const f of items) {
      const k = groupKeyForFinding(f);
      const list = bucketed.get(k) ?? [];
      list.push(f);
      bucketed.set(k, list);
    }

    for (const groupItems of bucketed.values()) {
      const groupId = `${tier}-G${String(groupSeq).padStart(2, "0")}`;
      groupSeq += 1;
      const files = Array.from(new Set(groupItems.map((f) => f.filePath)));
      const verificationCommands = Array.from(
        new Set(
          groupItems.map((f) => f.verificationCommand).filter((cmd): cmd is string => Boolean(cmd)),
        ),
      );
      groups.push({
        groupId,
        priority: tier,
        rootCause: groupItems[0]?.rootCause || groupItems[0]?.title || "",
        files,
        verificationCommands,
        items: groupItems.map((f) => ({
          id: f.id,
          severity: f.severity,
          type: f.type,
          epistemicState: f.epistemicState ?? "VERIFIED-DEFECT",
          filePath: f.filePath,
          startLine: f.startLine,
          endLine: f.endLine,
          title: f.title,
          rootCause: f.rootCause ?? f.title,
          blastRadius: f.blastRadius ?? "Crate / module boundary",
          dependsOn: f.dependsOn ?? null,
          verificationCommand: f.verificationCommand ?? "cargo test --workspace",
          suggestion: f.suggestion,
          suggestionVerified: f.suggestionVerified,
          agentPrompt: f.agentPrompt,
        })),
      });
    }
  }

  return {
    prNumber: bundle.pr.number,
    headSha: bundle.headSha,
    totalActionable: allFindings.length,
    verifiedSuggestions: allFindings.filter((f) => f.suggestion && f.suggestionVerified).length,
    countsByPriority: {
      P0: byTier.P0.length,
      P1: byTier.P1.length,
      P2: byTier.P2.length,
      P3: byTier.P3.length,
    },
    groups,
  };
}

/**
 * Deterministically derives a dependency-ordered `todo.md` fix queue from a
 * finalized `ReviewBundle`, grouping related findings into P0-P3 solving groups.
 */
export function renderReviewTodoMarkdown(bundle: ReviewBundle): string {
  const allFindings = [...bundle.findings, ...(bundle.outsideDiffFindings ?? [])];
  const lines: string[] = [
    `# Review TODO — ${bundle.pr.owner}/${bundle.pr.repo}#${bundle.pr.number} (${bundle.headSha.slice(0, 7)})`,
    "",
    "Derived deterministically from the finalized review bundle. Ordered by priority (`P0`–`P3`) with findings sharing a root cause or subsystem grouped together.",
    "",
  ];

  if (allFindings.length === 0) {
    lines.push("No actionable findings — ready to merge.", "");
    return lines.join("\n");
  }

  const byTier: Record<PriorityTier, Finding[]> = { P0: [], P1: [], P2: [], P3: [] };
  for (const f of allFindings) {
    byTier[severityToTier(f.severity)].push(f);
  }

  let groupLetterCode = 65; // 'A'

  for (const tier of ["P0", "P1", "P2", "P3"] as const) {
    const items = byTier[tier];
    if (items.length === 0) {
      continue;
    }
    lines.push(`## ${TIER_META[tier].heading} (${TIER_META[tier].desc})`, "");

    const groups = new Map<string, Finding[]>();
    for (const f of items) {
      const k = groupKeyForFinding(f);
      const list = groups.get(k) ?? [];
      list.push(f);
      groups.set(k, list);
    }

    for (const groupItems of groups.values()) {
      if (groupItems.length > 1) {
        const label = String.fromCharCode(groupLetterCode);
        groupLetterCode += 1;
        const sample = groupItems[0];
        lines.push(`### Group ${label} — ${sample?.filePath ?? "shared"} (solve together)`, "");
      }
      for (const f of groupItems) {
        const range = f.startLine === f.endLine ? `${f.startLine}` : `${f.startLine}-${f.endLine}`;
        const verifiedTag = f.suggestionVerified ? " [suggestion: cargo check OK]" : "";
        const fixHint = f.agentPrompt.split("\n")[0]?.trim() ?? "Resolve finding.";
        lines.push(
          `- [ ] **\`${f.id}\` — ${f.title}**${verifiedTag}`,
          `      \`${f.filePath}:${range}\` (${f.severity} | ${f.type}). ${fixHint}`,
        );
      }
      lines.push("");
    }
  }

  lines.push(
    "## Counts",
    `- **P0 (Critical):** ${byTier.P0.length}`,
    `- **P1 (Major):** ${byTier.P1.length}`,
    `- **P2 (Minor):** ${byTier.P2.length}`,
    `- **P3 (Trivial/Info):** ${byTier.P3.length}`,
    `- **Total Actionable:** ${allFindings.length}`,
    "",
  );

  return lines.join("\n");
}
