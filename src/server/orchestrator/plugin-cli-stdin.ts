import { PassThrough, type Readable } from "node:stream";

// A part and the call that names its id travel on two connections, so a part can arrive first.
export const PLUGIN_STDIN_CLAIM_WAIT_MS = 10_000;
export const MAX_WAITING_PLUGIN_STDIN_PARTS_PER_SESSION = 8;
// A part can also arrive after its command exited, and a call can be sent again after it ran.
export const FINISHED_PLUGIN_STDIN_CALL_MS = 60_000;

interface Call {
  /** Null when the command exited. The record stays for a time; the stream and its data do not. */
  stream: PassThrough | null;
  /** How many parts the stream took, which is also the number of the next one. */
  taken: number;
  inFlight: Promise<boolean> | null;
}

interface Waiter {
  id: string;
  wake: () => void;
}

const calls = new Map<string, Call>();
const waiting = new Map<string, Set<Waiter>>();

const keyOf = (sessionId: string, id: string): string => `${sessionId}\n${id}`;

export interface PluginStdinClaim {
  stream: Readable;
  release(): void;
}

export interface PluginStdinPart {
  /** Counts from 0. It makes a part that is sent again harmless. */
  seq: number;
  data: string;
  end: boolean;
}

/** `accepted: false` is a call that takes no more input; `error` is input that was not delivered. */
export type PluginStdinAnswer = { accepted: boolean } | { error: string };

/**
 * The stdin of one plugin command whose caller sends it apart from the call, as
 * it arrives (docs/262-plugins plan.md, "Stdin is delivered when it arrives").
 * Null when a call has or had the id: a call that is sent again must not take
 * the input of the first one, and must not run the command again.
 */
export function claimPluginStdin(
  sessionId: string,
  id: string,
  finishedMs = FINISHED_PLUGIN_STDIN_CALL_MS,
): PluginStdinClaim | null {
  const key = keyOf(sessionId, id);
  if (calls.has(key)) return null;
  const stream = new PassThrough();
  const call: Call = { stream, taken: 0, inFlight: null };
  calls.set(key, call);
  for (const waiter of [...(waiting.get(sessionId) ?? [])]) {
    if (waiter.id === id) waiter.wake();
  }
  return {
    stream,
    release: () => {
      call.stream = null;
      stream.destroy();
      const timer = setTimeout(() => calls.delete(key), finishedMs);
      timer.unref?.();
    },
  };
}

/**
 * Answers when the stream to the command had room for the part, so a caller that
 * sends one part at a time reads its own stdin no faster than the command does.
 */
export async function writePluginStdin(
  sessionId: string,
  id: string,
  part: PluginStdinPart,
  claimWaitMs = PLUGIN_STDIN_CLAIM_WAIT_MS,
): Promise<PluginStdinAnswer> {
  const call = calls.get(keyOf(sessionId, id)) ?? await claimed(sessionId, id, claimWaitMs);
  if (!call) return { error: "The call that this input belongs to did not arrive." };
  if (part.seq < call.taken) return { accepted: true };
  const { stream } = call;
  if (!stream) return { accepted: false };
  if (part.seq > call.taken) {
    return { error: `Part ${part.seq} of this input arrived before part ${call.taken}.` };
  }
  // One write at a time for a call: a part that is sent again while it waits joins the first one.
  call.inFlight ??= (async () => {
    const accepted = await put(stream, part.data, part.end);
    if (accepted) call.taken += 1;
    call.inFlight = null;
    return accepted;
  })();
  return { accepted: await call.inFlight };
}

function put(stream: PassThrough, data: string, end: boolean): Promise<boolean> {
  if (stream.destroyed || stream.writableEnded) return Promise.resolve(false);
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

function claimed(sessionId: string, id: string, waitMs: number): Promise<Call | null> {
  const waiters = waiting.get(sessionId) ?? new Set<Waiter>();
  if (waiters.size >= MAX_WAITING_PLUGIN_STDIN_PARTS_PER_SESSION) return Promise.resolve(null);
  waiting.set(sessionId, waiters);
  return new Promise((resolve) => {
    const waiter: Waiter = {
      id,
      wake: () => {
        clearTimeout(timer);
        waiters.delete(waiter);
        if (waiters.size === 0 && waiting.get(sessionId) === waiters) waiting.delete(sessionId);
        resolve(calls.get(keyOf(sessionId, id)) ?? null);
      },
    };
    const timer = setTimeout(waiter.wake, waitMs);
    timer.unref?.();
    waiters.add(waiter);
  });
}
