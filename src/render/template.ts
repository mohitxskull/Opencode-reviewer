// Why: Using native Bun `.md` text imports (`with { type: "text" }`) paired with
// this typed `{{SLOT}}` substitution helper keeps Markdown in real `.md` files
// (full editor syntax highlighting, zero backtick escaping) while preserving
// 100% compile-time key checking in TypeScript and avoiding runtime `new Function`
// evaluation.
export function fillTemplate<K extends string>(
  template: string,
  slots: Readonly<Record<K, string>>,
): string {
  const filled = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key: string) => {
    if (Object.hasOwn(slots, key)) {
      return slots[key as K];
    }
    return match;
  });

  // Collapse 3+ consecutive newlines caused by empty optional slots down to a single blank line
  return filled.replace(/\n{3,}/g, "\n\n").trimEnd();
}
