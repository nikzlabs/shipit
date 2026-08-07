/**
 * Flush-then-exit plumbing shared by every agent shim (`shipit`, `gh`,
 * `shipit-git-credential`).
 *
 * `process.exit()` is immediate: it does NOT wait for queued stdout/stderr
 * writes. That is harmless when the shim's output goes to a TTY or a file
 * (Node writes those synchronously) but silently destructive when it goes to a
 * **pipe** — `shipit issue view … | jq`, `| head`, `$(shipit source cat …)` —
 * because pipe writes are asynchronous. Anything past the OS pipe buffer
 * (64 KiB on Linux) is still sitting inside Node when the process dies, and the
 * consumer receives a document truncated at exactly 65,536 bytes with no error,
 * no warning, and an exit code of 0. Redirecting the identical command to a file
 * produced the complete output, which is what made this read like a server-side
 * cap rather than a shim bug.
 *
 * The fix is to route every shim write through {@link shimWrite}, which tracks
 * completion callbacks, and to exit via {@link exitAfterFlush}, which terminates
 * only once nothing is outstanding. Exit codes are unchanged: the code is set on
 * `process.exitCode` immediately (so a natural exit reports it too) and passed
 * to the eventual `process.exit`.
 *
 * NOT related to `MAX_ISSUE_FREETEXT_CHARS` / `MAX_ISSUE_COMMENTS_CHARS` in
 * `shipit-issue.ts` — those deliberately clamp the *human-readable* issue
 * rendering as a context-stuffing defense (planning#87 / docs/176) and are untouched.
 */

/** Writes handed to a stream that have not reported completion yet. */
let pendingWrites = 0;

/** Exit code armed by {@link exitAfterFlush}, or null while none is armed. */
let armedExitCode: number | null = null;

let forceTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Backstop for the pathological case: a consumer that neither reads nor closes
 * the pipe would otherwise keep the shim alive forever. Generous enough that a
 * merely slow reader still gets the complete document.
 */
export const FLUSH_TIMEOUT_MS = 30_000;

/** Streams we've already attached the EPIPE swallow to. */
const guardedStreams = new WeakSet<NodeJS.WritableStream>();

/**
 * Swallow write errors on a std stream. Waiting for the drain means we now
 * outlive a `| head` that closed the pipe early, so the EPIPE that used to be
 * outrun by `process.exit()` can reach us. An unhandled `error` on
 * `process.stdout` crashes the process with a stack trace over the agent's
 * output; there is nothing useful to do about it, so it is ignored and the
 * armed exit code still stands.
 */
function guardStream(stream: NodeJS.WritableStream): void {
  if (guardedStreams.has(stream)) return;
  guardedStreams.add(stream);
  stream.on("error", () => {});
}

function exitIfDrained(): void {
  if (armedExitCode === null || pendingWrites > 0) return;
  if (forceTimer) {
    clearTimeout(forceTimer);
    forceTimer = undefined;
  }
  process.exit(armedExitCode);
}

/**
 * Write to a std stream, tracking the write so {@link exitAfterFlush} can wait
 * for it. Drop-in replacement for `stream.write(text)`.
 */
export function shimWrite(stream: NodeJS.WritableStream, text: string): void {
  if (text.length === 0) return;
  guardStream(stream);
  pendingWrites++;
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    pendingWrites--;
    exitIfDrained();
  };
  try {
    stream.write(text, settle);
  } catch {
    // A destroyed/closed stream can throw synchronously — nothing left to flush.
    settle();
  }
}

/**
 * Exit with `code`, but only once every {@link shimWrite} has completed.
 *
 * Returns immediately when writes are still outstanding: the pending write keeps
 * the event loop alive, and the process exits from the write callback. Callers
 * must therefore treat this the way the shims already treat `ShimIO.exit` — as
 * "stop doing work", followed by a `return` or a thrown `__shim_exit__` — which
 * is exactly the contract the injected test IO has always had.
 */
export function exitAfterFlush(code: number): void {
  armedExitCode = code;
  process.exitCode = code;
  if (pendingWrites > 0 && !forceTimer) {
    forceTimer = setTimeout(() => process.exit(code), FLUSH_TIMEOUT_MS);
    forceTimer.unref?.();
  }
  exitIfDrained();
}
