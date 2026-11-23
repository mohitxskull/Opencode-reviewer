import type { LearningStore } from "../workspace/learnings.ts";

export async function runLearnCommand(
  args: readonly string[],
  scope: string | undefined,
  learningStore: LearningStore,
  writeOut: (text: string) => void,
  writeErr: (text: string) => void,
  options: { readonly json?: boolean; readonly quiet?: boolean } = {},
): Promise<number> {
  const isJson = options.json ?? false;
  const isQuiet = options.quiet ?? false;
  const action = args[0];
  if (action === "add") {
    const ruleText = args.slice(1).join(" ").trim();
    if (!ruleText) {
      writeErr('Usage: peer learn add "<rule>" [--scope "<glob>"]');
      return 2;
    }
    const entry = await learningStore.add({
      rule: ruleText,
      scope: scope ?? null,
    });
    if (isJson || isQuiet) {
      writeOut(JSON.stringify({ status: "added", learning: entry }, null, isQuiet ? undefined : 2));
      return 0;
    }
    writeOut(
      `Added learning [${entry.id}]${entry.scope ? ` (scope: ${entry.scope})` : ""}: ${entry.rule}`,
    );
    return 0;
  }

  if (action === "list") {
    const list = await learningStore.list();
    if (isJson || isQuiet) {
      writeOut(JSON.stringify({ learnings: list }, null, isQuiet ? undefined : 2));
      return 0;
    }
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
      return 2;
    }
    const removed = await learningStore.remove(id);
    if (!removed) {
      writeErr(`Learning ID "${id}" not found.`);
      return 2;
    }
    if (isJson || isQuiet) {
      writeOut(JSON.stringify({ status: "removed", id }, null, isQuiet ? undefined : 2));
      return 0;
    }
    writeOut(`Removed learning [${id}].`);
    return 0;
  }

  writeErr("Unknown learn subcommand. Expected: peer learn add | list | remove");
  return 2;
}
