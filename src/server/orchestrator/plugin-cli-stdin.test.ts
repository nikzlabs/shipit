import { describe, expect, it } from "vitest";
import type { Readable } from "node:stream";
import { claimPluginStdin, writePluginStdin } from "./plugin-cli-stdin.js";

const SESSION = "s-1";
// More than a stream buffers before it asks the writer to wait.
const LARGE = "x".repeat(200 * 1024);

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

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

describe("writePluginStdin", () => {
  it("gives the command each part in the order it was sent, and then the end", async () => {
    const claim = claimPluginStdin(SESSION, "call-1");
    const got = collect(claim.stream);

    expect(await writePluginStdin(SESSION, "call-1", "one\n", false)).toBe(true);
    expect(await writePluginStdin(SESSION, "call-1", "two\n", false)).toBe(true);
    expect(got.ended()).toBe(false);
    expect(await writePluginStdin(SESSION, "call-1", "", true)).toBe(true);
    await tick();

    expect(got.text()).toBe("one\ntwo\n");
    expect(got.ended()).toBe(true);
    claim.release();
  });

  it("keeps a part that arrives before its call, and delivers it when the call arrives", async () => {
    const early = writePluginStdin(SESSION, "call-2", "early\n", false);
    const isSettled = settled(early);
    await tick();
    expect(isSettled()).toBe(false);

    const claim = claimPluginStdin(SESSION, "call-2");
    const got = collect(claim.stream);

    expect(await early).toBe(true);
    await tick();
    expect(got.text()).toBe("early\n");
    claim.release();
  });

  it("refuses a part whose call does not arrive, after the wait", async () => {
    expect(await writePluginStdin(SESSION, "no-such-call", "lost\n", false, 20)).toBe(false);
  });

  it("does not answer a part before the command took it, so the sender waits", async () => {
    const claim = claimPluginStdin(SESSION, "call-3");
    const part = writePluginStdin(SESSION, "call-3", LARGE, false);
    const isSettled = settled(part);
    await tick();
    expect(isSettled()).toBe(false);

    const got = collect(claim.stream);

    expect(await part).toBe(true);
    expect(got.text()).toHaveLength(LARGE.length);
    claim.release();
  });

  it("refuses a part that still waits when the command exits, and every part after that", async () => {
    const claim = claimPluginStdin(SESSION, "call-4");
    const unread = writePluginStdin(SESSION, "call-4", LARGE, false);
    await tick();

    claim.release();

    expect(await unread).toBe(false);
    expect(await writePluginStdin(SESSION, "call-4", "late\n", false, 20)).toBe(false);
  });

  it("refuses input after the end", async () => {
    const claim = claimPluginStdin(SESSION, "call-5");
    collect(claim.stream);

    await writePluginStdin(SESSION, "call-5", "all\n", true);

    expect(await writePluginStdin(SESSION, "call-5", "more\n", false)).toBe(false);
    claim.release();
  });

  it("does not give one session's input to a call of another session with the same id", async () => {
    const claim = claimPluginStdin("s-2", "shared-id");
    const got = collect(claim.stream);

    expect(await writePluginStdin(SESSION, "shared-id", "not yours\n", false, 20)).toBe(false);
    await tick();

    expect(got.text()).toBe("");
    claim.release();
  });
});
