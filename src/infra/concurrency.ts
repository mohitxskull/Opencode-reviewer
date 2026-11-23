export async function runWithConcurrency<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  concurrencyLimit: number,
): Promise<T[]> {
  if (tasks.length === 0) {
    return [];
  }
  const results = new Array<T>(tasks.length);
  const limit = Math.max(1, Math.min(concurrencyLimit, tasks.length));
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIndex++;
      if (idx >= tasks.length) {
        return;
      }
      const task = tasks[idx];
      if (task) {
        results[idx] = await task();
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}
