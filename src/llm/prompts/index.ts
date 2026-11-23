import { fillTemplate } from "../../domain/template.ts";
import cohortAuditMd from "./cohort-audit.md" with { type: "text" };
import findingsFormatMd from "./findings-format.md" with { type: "text" };
import idiomsMd from "./idioms.md" with { type: "text" };
import skepticMd from "./skeptic.md" with { type: "text" };
import soundnessMd from "./soundness.md" with { type: "text" };
import walkthroughMd from "./walkthrough.md" with { type: "text" };

const FINDINGS_FORMAT = findingsFormatMd.trim();

export const WALKTHROUGH_LENS_PROMPT = walkthroughMd.trim();
export const SKEPTIC_VERIFIER_PROMPT = skepticMd.trim();
export const COHORT_DEEP_AUDIT_PROMPT = fillTemplate(cohortAuditMd, {
  FINDINGS_FORMAT,
});
export const SOUNDNESS_CONCURRENCY_LENS_PROMPT = fillTemplate(soundnessMd, {
  FINDINGS_FORMAT,
});
export const IDIOMS_LOGIC_LENS_PROMPT = fillTemplate(idiomsMd, {
  FINDINGS_FORMAT,
});
