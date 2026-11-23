import {
  FINDINGS_FORMAT_PROMPT,
  IDIOMS_LOGIC_LENS_PROMPT,
  SKEPTIC_VERIFIER_PROMPT,
  SOUNDNESS_CONCURRENCY_LENS_PROMPT,
  WALKTHROUGH_LENS_PROMPT,
} from "../llm/prompts/index.ts";

const PROMPTS: Readonly<Record<string, string>> = {
  walkthrough: WALKTHROUGH_LENS_PROMPT,
  soundness: SOUNDNESS_CONCURRENCY_LENS_PROMPT,
  idioms: IDIOMS_LOGIC_LENS_PROMPT,
  skeptic: SKEPTIC_VERIFIER_PROMPT,
  format: FINDINGS_FORMAT_PROMPT,
};

export function runPromptCommand(
  args: readonly string[],
  writeOut: (text: string) => void,
  writeErr: (text: string) => void,
): number {
  const name = args[0]?.trim().toLowerCase();
  const validNames = Object.keys(PROMPTS);

  if (!name || name === "list") {
    writeOut(`Available prompts: ${validNames.join(", ")}\nUsage: peer prompt <name>`);
    return 0;
  }

  const content = PROMPTS[name];
  if (!content) {
    writeErr(`Unknown prompt "${name}". Available: ${validNames.join(", ")}`);
    return 1;
  }

  writeOut(content);
  return 0;
}
