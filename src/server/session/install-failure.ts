/**
 * Install-failure diagnostics (extracted from `session-worker.ts` so the pure
 * formatting is unit-testable without importing the heavy worker module).
 *
 * Background: a non-zero `agent.install` command used to surface only as
 * `Command "npm install" exited with code 1` — the exit code but never the
 * cause. The original incident (a recreated session whose root-owned workspace
 * made `npm install` fail fast with EACCES) showed up downstream merely as a
 * stale `install_ok=false`, with the actual `EACCES … permission denied` line
 * lost in the emit-only `install_log` stream. Capturing a bounded stderr tail
 * and folding it into the failure message makes the failure self-diagnosing.
 */

/**
 * Max bytes of an install command's stderr retained for the failure message.
 * Bounded so a chatty installer can't grow the retained result without limit;
 * the tail carries the actionable cause, so we keep the END.
 */
export const INSTALL_STDERR_TAIL_BYTES = 4096;

/**
 * Compose the `install_error` message for a non-zero install command: the
 * command + exit code, plus the last few non-empty stderr lines when present.
 * Pure so it can be unit-tested without spawning a process.
 */
export function formatInstallFailureMessage(
  command: string,
  exitCode: number,
  stderrTail: string,
): string {
  const base = `Command "${command}" exited with code ${exitCode}`;
  const tail = stderrTail
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .slice(-6)
    .join("\n");
  return tail ? `${base}\n${tail}` : base;
}
