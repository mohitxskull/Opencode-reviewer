import { fillTemplate } from "../render/template.ts";
import cohortAuditMd from "./md/cohort-audit.md" with { type: "text" };
import findingsFormatMd from "./md/findings-format.md" with { type: "text" };
import idiomsMd from "./md/idioms.md" with { type: "text" };
import soundnessMd from "./md/soundness.md" with { type: "text" };
import walkthroughMd from "./md/walkthrough.md" with { type: "text" };

const FINDINGS_FORMAT = findingsFormatMd.trim();

export const WALKTHROUGH_LENS_PROMPT = walkthroughMd.trim();
export const COHORT_DEEP_AUDIT_PROMPT = fillTemplate(cohortAuditMd, {
  FINDINGS_FORMAT,
});
export const SOUNDNESS_CONCURRENCY_LENS_PROMPT = fillTemplate(soundnessMd, {
  FINDINGS_FORMAT,
});
export const IDIOMS_LOGIC_LENS_PROMPT = fillTemplate(idiomsMd, {
  FINDINGS_FORMAT,
});
