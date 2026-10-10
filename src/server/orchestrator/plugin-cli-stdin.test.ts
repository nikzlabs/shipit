import { describe, expect, it } from "vitest";
import type { Readable } from "node:stream";
import {
  claimPluginStdin,
  MAX_WAITING_PLUGIN_STDIN_PARTS_PER_SESSION,
  writePluginStdin,
  type PluginStdinClaim,
} from "./plugin-cli-stdin.js";

const SESSION = "s-1";
// More than a stream buffers before it asks the writer to wait.
const LARGE = "x".repeat(200 * 1024);
const ACCEPTED = { accepted: true };
const CLOSED = { accepted: false };
const NO_CALL = { error: "The call that this input belongs to did not arrive." };

function claim(sessionId: string, id: string, finishedMs?: number): PluginStdinClaim {
  const claimed = claimPluginStdin(sessionId, id, finishedMs);
  if (!claimed) throw new Error(`a call already has the id ${id}`);
  return claimed;
}

const part = (id: string, seq: number, data: string, opts: { end?: boolean; session?: string; waitMs?: number } = {}) =>
  writePluginStdin(opts.session ?? SESSION, id, { seq, data, end: opts.end ?? false }, opts.waitMs);

function collect(stream: Readable): { text: () => string; ended: () => boolean } {
  const chunks: Buffer[] = [];
  let ended = false;
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  stream.on("end", () => { ended = true; });
  return { text: () => Buffer.concat(chunks).toString(), ended: () => ended };
}

function settled(promise: Promise<unknown>): () => boolean {
  let done = false;
  void (async () => {
    await promise;
    done = true;
  })();
  return () => done;
}

const tick = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("writePluginStdin", () => {
  it("gives the command each part in the order it was sent, and then the end", async () => {
    const call = claim(SESSION, "ordered");
    const got = collect(call.stream);

    expect(await part("ordered", 0, "one\n")).toEqual(ACCEPTED);
    expect(await part("ordered", 1, "two\n")).toEqual(ACCEPTED);
    expect(got.ended()).toBe(false);
    expect(await part("ordered", 2, "", { end: true })).toEqual(ACCEPTED);
    await tick();

    expect(got.text()).toBe("one\ntwo\n");
    expect(got.ended()).toBe(true);
    call.release();
  });

  it("keeps a part that arrives before its call, and delivers it when the call arrives", async () => {
    const early = part("early", 0, "early\n");
    const isSettled = settled(early);
    await tick();
    expect(isSettled()).toBe(false);

    const call = claim(SESSION, "early");
    const got = collect(call.stream);

    expect(await early).toEqual(ACCEPTED);
    await tick();
    expect(got.text()).toBe("early\n");
    call.release();
  });

  it("says that the input was not delivered when its call does not arrive, and not before the wait ends", async () => {
    const lost = part("no-such-call", 0, "lost\n", { waitMs: 60 });
    const isSettled = settled(lost);

    await tick(20);
    expect(isSettled()).toBe(false);

    expect(await lost).toEqual(NO_CALL);
  });

  it("lets only a few parts of one session wait for a call, and refuses the next one at once", async () => {
    const ids = Array.from({ length: MAX_WAITING_PLUGIN_STDIN_PARTS_PER_SESSION }, (_, i) => `crowd-${i}`);
    const waiters = ids.map((id) => part(id, 0, "x", { session: "s-crowd", waitMs: 5_000 }));
    const anyWaiterSettled = settled(Promise.race(waiters));

    const oneMore = await Promise.race([
      part("one-more", 0, "x", { session: "s-crowd", waitMs: 5_000 }),
      tick(100),
    ]);
    const other = part("elsewhere", 0, "x", { session: "s-other", waitMs: 5_000 });
    const call = claim("s-other", "elsewhere");
    collect(call.stream);

    expect(oneMore).toEqual(NO_CALL);
    expect(anyWaiterSettled()).toBe(false);
    expect(await other).toEqual(ACCEPTED);
    call.release();
    for (const id of ids) collect(claim("s-crowd", id).stream);
    expect(await Promise.all(waiters)).toEqual(waiters.map(() => ACCEPTED));
  });

  it("does not answer a part before the stream to the command has room, so the sender waits", async () => {
    const call = claim(SESSION, "slow-reader");
    const sent = part("slow-reader", 0, LARGE);
    const isSettled = settled(sent);
    await tick();
    expect(isSettled()).toBe(false);

    const got = collect(call.stream);

    expect(await sent).toEqual(ACCEPTED);
    expect(got.text()).toHaveLength(LARGE.length);
    call.release();
  });

  it("writes a part once when it is sent again, while it waits and after it was taken", async () => {
    const call = claim(SESSION, "repeated");
    const first = part("repeated", 0, LARGE);
    const again = part("repeated", 0, LARGE);
    await tick();

    const got = collect(call.stream);

    expect(await Promise.all([first, again])).toEqual([ACCEPTED, ACCEPTED]);
    expect(await part("repeated", 0, LARGE)).toEqual(ACCEPTED);
    expect(await part("repeated", 1, "tail\n", { end: true })).toEqual(ACCEPTED);
    await tick();
    expect(got.text()).toBe(`${LARGE}tail\n`);
    call.release();
  });

  it("refuses a part that is not the next one, and writes nothing of it", async () => {
    const call = claim(SESSION, "skipped");
    const got = collect(call.stream);

    expect(await part("skipped", 1, "second\n")).toEqual({
      error: "Part 1 of this input arrived before part 0.",
    });
    await tick();

    expect(got.text()).toBe("");
    call.release();
  });

  it("tells a part that the command takes no more input when the command exits, and after that at once", async () => {
    const call = claim(SESSION, "exited");
    expect(await part("exited", 0, "taken\n")).toEqual(ACCEPTED);
    const unread = part("exited", 1, LARGE);
    await tick();

    call.release();

    expect(await unread).toEqual(CLOSED);
    const late = await Promise.race([part("exited", 1, "late\n", { waitMs: 5_000 }), tick(100)]);
    expect(late).toEqual(CLOSED);
    expect(await part("exited", 0, "taken\n")).toEqual(ACCEPTED);
  });

  it("takes no input after the end, also when the command has not read to it", async () => {
    const call = claim(SESSION, "ended");
    // A write after the end is an error that nothing handles, and this suite's runner does not report one.
    const unhandled: unknown[] = [];
    const record = (err: unknown): void => { unhandled.push(err); };
    process.on("uncaughtException", record);

    try {
      expect(await part("ended", 0, "all\n", { end: true })).toEqual(ACCEPTED);

      expect(await part("ended", 1, "more\n")).toEqual(CLOSED);
      await tick();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("uncaughtException", record);
      call.release();
    }
  });

  it("does not give a call's id, or its input, to a second call while it runs or soon after", async () => {
    const call = claim(SESSION, "taken", 40);
    const got = collect(call.stream);

    expect(claimPluginStdin(SESSION, "taken")).toBeNull();
    expect(await part("taken", 0, "for the first\n")).toEqual(ACCEPTED);
    await tick();
    expect(got.text()).toBe("for the first\n");

    call.release();
    expect(claimPluginStdin(SESSION, "taken")).toBeNull();

    await tick(80);
    claim(SESSION, "taken").release();
  });

  it("does not give one session's input to a call of another session with the same id", async () => {
    const call = claim("s-2", "shared-id");
    const got = collect(call.stream);

    expect(await part("shared-id", 0, "not yours\n", { waitMs: 20 })).toEqual(NO_CALL);
    await tick();

    expect(got.text()).toBe("");
    call.release();
  });
});
