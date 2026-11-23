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
