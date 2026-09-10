// process.exit drops pending pipe writes. Wait for their callbacks before exit.

let pendingWrites = 0;

let armedExitCode: number | null = null;

let forceTimer: ReturnType<typeof setTimeout> | undefined;

// Bound the wait for a consumer that neither reads nor closes its pipe.
export const FLUSH_TIMEOUT_MS = 30_000;

const guardedStreams = new WeakSet<NodeJS.WritableStream>();

// A consumer such as head can close early; EPIPE must not replace the exit code.
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
    settle();
  }
}

// This can return before exit. Callers must return or throw to stop further work.
export function exitAfterFlush(code: number): void {
  armedExitCode = code;
  process.exitCode = code;
  if (pendingWrites > 0 && !forceTimer) {
    forceTimer = setTimeout(() => process.exit(code), FLUSH_TIMEOUT_MS);
    forceTimer.unref?.();
  }
  exitIfDrained();
}
