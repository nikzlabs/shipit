import { PassThrough, type Readable } from "node:stream";

// A part and the call that names its id travel on two connections, so a part can arrive first.
export const PLUGIN_STDIN_CLAIM_WAIT_MS = 10_000;

const channels = new Map<string, PassThrough>();
const waiting = new Map<string, Set<() => void>>();

const keyOf = (sessionId: string, id: string): string => `${sessionId}\n${id}`;

export interface PluginStdinClaim {
  stream: Readable;
  release(): void;
}

/**
 * The stdin of one plugin command whose caller sends it apart from the call, as
 * it arrives (docs/262-plugins plan.md, "Stdin is delivered when it arrives").
 */
export function claimPluginStdin(sessionId: string, id: string): PluginStdinClaim {
  const key = keyOf(sessionId, id);
  const stream = new PassThrough();
  channels.set(key, stream);
  for (const wake of [...(waiting.get(key) ?? [])]) wake();
  return {
    stream,
    release: () => {
      if (channels.get(key) === stream) channels.delete(key);
      stream.destroy();
    },
  };
}

/**
 * Resolves when the command's side took the part, so a caller that sends one
 * part at a time reads its own stdin no faster than the command does. False
 * means the call takes no more input.
 */
export async function writePluginStdin(
  sessionId: string,
  id: string,
  data: string,
  end: boolean,
  claimWaitMs = PLUGIN_STDIN_CLAIM_WAIT_MS,
): Promise<boolean> {
  const key = keyOf(sessionId, id);
  const stream = channels.get(key) ?? await claimed(key, claimWaitMs);
  if (!stream || stream.destroyed || stream.writableEnded) return false;
  return new Promise((resolve) => {
    // A destroyed stream does not call the callback of a write it still holds.
    const closed = (): void => resolve(false);
    stream.once("close", closed);
    const taken = (err?: Error | null): void => {
      stream.off("close", closed);
      resolve(!err);
    };
    if (end) stream.end(data, taken);
    else stream.write(data, taken);
  });
}

function claimed(key: string, waitMs: number): Promise<PassThrough | null> {
  return new Promise((resolve) => {
    const wake = (): void => {
      clearTimeout(timer);
      const others = waiting.get(key);
      others?.delete(wake);
      if (others?.size === 0) waiting.delete(key);
      resolve(channels.get(key) ?? null);
    };
    const timer = setTimeout(wake, waitMs);
    timer.unref?.();
    waiting.set(key, (waiting.get(key) ?? new Set()).add(wake));
  });
}
