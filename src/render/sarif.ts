import {
  computeFindingFingerprint,
  type Finding,
  PEER_VERSION,
  type Severity,
} from "../domain/models.ts";

function severityToSarifLevel(severity: Severity): "error" | "warning" | "note" {
  switch (severity) {
    case "Critical":
    case "Major":
      return "error";
    case "Minor":
      return "warning";
    default:
      return "note";
  }
}

export function renderSarifReport(findings: readonly Finding[], version = PEER_VERSION): string {
  const rulesMap = new Map<
    string,
    { id: string; shortDescription: { text: string }; properties: { tags: string[] } }
  >();

  const results = findings.map((f) => {
    const ruleId = `${f.source}/${f.type.toLowerCase()}`;
    if (!rulesMap.has(ruleId)) {
      rulesMap.set(ruleId, {
        id: ruleId,
        shortDescription: { text: `peer ${f.source} (${f.type})` },
        properties: { tags: ["rust", f.source, f.type.toLowerCase()] },
      });
    }

    return {
      ruleId,
      level: severityToSarifLevel(f.severity),
      message: { text: `${f.title}\n\n${f.body}` },
      locations: [
        {
          physicalLocation: {
            artifactLocation: {
              uri: f.filePath
                .replace(/\\/g, "/")
                .replace(/^\.\//, "")
                .split("/")
                .map((seg) => encodeURIComponent(seg))
                .join("/"),
            },
            region: {
              startLine: f.startLine,
              endLine: f.endLine,
            },
          },
        },
      ],
      partialFingerprints: {
        primaryLocationLineHash: computeFindingFingerprint(f),
      },
    };
  });

  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "peer",
            version,
            informationUri: "https://github.com/mohitxskull/Opencode-reviewer",
            rules: Array.from(rulesMap.values()),
          },
        },
        results,
      },
    ],
  };

  return `${JSON.stringify(sarif, null, 2)}\n`;
}
