import type { LearningStore } from "../workspace/learnings.ts";

export async function runLearnCommand(
  args: readonly string[],
  scope: string | undefined,
  learningStore: LearningStore,
  writeOut: (text: string) => void,
  writeErr: (text: string) => void,
): Promise<number> {
  const action = args[0];
  if (action === "add") {
    const ruleText = args.slice(1).join(" ").trim();
    if (!ruleText) {
      writeErr('Usage: peer learn add "<rule>" [--scope "<glob>"]');
      return 1;
    }
    const entry = await learningStore.add({
      rule: ruleText,
      scope: scope ?? null,
    });
    writeOut(
      `Added learning [${entry.id}]${entry.scope ? ` (scope: ${entry.scope})` : ""}: ${entry.rule}`,
    );
    return 0;
  }

  if (action === "list") {
    const list = await learningStore.list();
    if (list.length === 0) {
      writeOut("No repository learnings recorded yet.");
    } else {
      for (const item of list) {
        writeOut(
          `[${item.id}] ${item.scope ? `(scope: ${item.scope}) ` : "(global) "}${item.rule}`,
        );
      }
    }
    return 0;
  }

  if (action === "remove") {
    const id = args[1]?.trim();
    if (!id) {
      writeErr("Usage: peer learn remove <id>");
      return 1;
    }
    const removed = await learningStore.remove(id);
    if (!removed) {
      writeErr(`Learning ID "${id}" not found.`);
      return 1;
    }
    writeOut(`Removed learning [${id}].`);
    return 0;
  }

  writeErr("Unknown learn subcommand. Expected: peer learn add | list | remove");
  return 1;
}
