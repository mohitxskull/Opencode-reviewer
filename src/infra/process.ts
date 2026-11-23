import { registerSignalCleanup } from "./lifecycle.ts";

export const DEFAULT_ANALYZER_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_VERIFIER_TIMEOUT_MS = 2 * 60 * 1000;

export interface TrackedCommandOptions {
  readonly cwd: string;
  readonly env?: Record<string, string | undefined>;
  readonly timeoutMs?: number;
}

export interface TrackedCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
}

/**
 * Spawns a subprocess with LIFO SIGINT/SIGTERM cleanup registration (so active
 * `cargo` processes are killed before outer `git checkout -f` runs) and an
 * enforced timeout so hung builds/Miri tests never stall indefinitely.
 */
export async function runTrackedCommand(
  cmd: readonly string[],
  options: TrackedCommandOptions,
): Promise<TrackedCommandResult> {
  const proc = Bun.spawn([...cmd], {
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timeoutMs = options.timeoutMs ?? DEFAULT_ANALYZER_TIMEOUT_MS;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          try {
            proc.kill();
          } catch {
            // Process may already have exited
          }
        }, timeoutMs)
      : null;

  const unregister = registerSignalCleanup(() => {
    try {
      proc.kill();
    } catch {
      // Best-effort process cleanup on SIGINT/SIGTERM
    }
  });

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return {
      stdout,
      stderr: timedOut
        ? `${stderr}\nProcess timed out after ${Math.round(timeoutMs / 1000)}s`.trim()
        : stderr,
      exitCode: timedOut ? 124 : exitCode,
      timedOut,
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    unregister();
  }
}
