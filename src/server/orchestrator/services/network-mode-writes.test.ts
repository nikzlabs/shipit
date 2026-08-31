/**
 * docs/285 — the two things that must not overlap a network-mode write.
 *
 * Changing an ungraduated session's mode rebuilds its container, so the write is
 * slow and destructive. Another write for the same session would interleave a
 * destroy and a create (`restartContainer` has no guard of its own), and another
 * viewer's first message would go into the container being torn down.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  serializeNetworkModeWrite,
  settleNetworkModeWrites,
  _resetNetworkModeWrites,
} from "./network-mode-writes.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("network-mode writes (docs/285)", () => {
  beforeEach(() => _resetNetworkModeWrites());

  it("runs one write at a time, in arrival order", async () => {
    const order: string[] = [];
    const first = deferred();

    const a = serializeNetworkModeWrite("s1", async () => {
      order.push("a:start");
      await first.promise;
      order.push("a:end");
    });
    const b = serializeNetworkModeWrite("s1", async () => { order.push("b:start"); });

    await Promise.resolve();
    expect(order).toEqual(["a:start"]);

    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(["a:start", "a:end", "b:start"]);
  });

  it("does not serialize across different sessions", async () => {
    const started: string[] = [];
    const hold = deferred();
    const a = serializeNetworkModeWrite("s1", async () => {
      started.push("s1");
      await hold.promise;
    });
    const b = serializeNetworkModeWrite("s2", async () => { started.push("s2"); });
    await b;
    // A rebuild for one session must not put an unrelated session's settings
    // write behind a container build.
    expect(started).toContain("s2");
    hold.resolve();
    await a;
  });

  it("makes a first message WAIT for an in-flight rebuild", async () => {
    // The composer that issued the write is barred by its own save barrier;
    // ANOTHER viewer's is not, and only learns of the change from the broadcast
    // at the end. Without this it sends into the container being torn down.
    const hold = deferred();
    const write = serializeNetworkModeWrite("s1", async () => { await hold.promise; });

    let sent = false;
    // eslint-disable-next-line no-restricted-syntax -- observing that it has NOT resolved is the assertion; awaiting would defeat it
    const send = settleNetworkModeWrites("s1").then(() => { sent = true; });
    await Promise.resolve();
    expect(sent).toBe(false);

    hold.resolve();
    await write;
    await send;
    expect(sent).toBe(true);
  });

  it("lets a first message straight through when nothing is in flight", async () => {
    // The control: this is the ordinary Send path, and it must cost nothing.
    await settleNetworkModeWrites("s-idle");
  });

  it("does not make a message wait on a DIFFERENT session's write", async () => {
    const hold = deferred();
    const write = serializeNetworkModeWrite("s1", async () => { await hold.promise; });
    await settleNetworkModeWrites("s2");
    hold.resolve();
    await write;
  });

  it("releases the waiter when the write THROWS, and does not strand the next one", async () => {
    // A failed rebuild must not wedge every later message for that session.
    const failing = serializeNetworkModeWrite("s1", async () => {
      throw new Error("rebuild blew up");
    });
    await expect(failing).rejects.toThrow("rebuild blew up");
    await settleNetworkModeWrites("s1");
    await expect(serializeNetworkModeWrite("s1", async () => "ok")).resolves.toBe("ok");
  });
});
