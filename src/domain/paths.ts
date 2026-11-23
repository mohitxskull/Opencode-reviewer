/**
 * Returns true if a repository-relative Rust path belongs to tests, benchmarks,
 * or examples rather than production code.
 *
 * Covers integration/bench/example directories (`tests/`, `benches/`, `examples/`),
 * suffixed test files (`*_test.rs`, `*_tests.rs`), and standalone module test files
 * (`tests.rs`, `test.rs` loaded via `#[cfg(test)] mod tests;`).
 */
export function isRustTestOrBenchPath(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return (
    /(^|\/)(tests|benches|examples)\//.test(norm) ||
    /(^|\/)tests?\.rs$/.test(norm) ||
    norm.endsWith("_test.rs") ||
    norm.endsWith("_tests.rs")
  );
}

/**
 * Matches a repository-relative file path against a user/config glob pattern
 * safely (never throws on malformed patterns) and handles zero-segment `**`
 * forms (`a/**\/b`, `**\/b`, `a/**`).
 */
export function matchRepoGlob(pattern: string, filePath: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const normalizedPattern = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalizedPattern) {
    return false;
  }

  const candidates = new Set<string>([normalizedPattern]);
  // Iteratively collapse zero-segment `/**/` and leading `**/` so multi-`**` globs like `**/a/**/b` match `a/b`
  let added = true;
  while (added) {
    added = false;
    for (const c of Array.from(candidates)) {
      if (c.includes("/**/")) {
        const next = c.replace("/**/", "/");
        if (!candidates.has(next)) {
          candidates.add(next);
          added = true;
        }
      }
      if (c.startsWith("**/")) {
        const next = c.slice(3);
        if (next && !candidates.has(next)) {
          candidates.add(next);
          added = true;
        }
      }
    }
  }
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    if (normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)) {
      return true;
    }
  }

  for (const candidate of candidates) {
    try {
      if (new Bun.Glob(candidate).match(normalizedPath)) {
        return true;
      }
    } catch {
      // Ignore malformed user glob patterns rather than crashing review
    }
  }
  return false;
}
