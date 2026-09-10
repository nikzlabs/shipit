import { describe, it, expect, vi } from "vitest";
import { trackComposeStop, awaitComposeStop } from "../app-lifecycle.js";

function makeStubMgr(stopImpl: () => Promise<void>) {
  return {
    stop: vi.fn(stopImpl),
  };
}

describe("trackComposeStop", () => {
  it("registers an in-flight stop and clears the entry when it settles", async () => {
    const map = new Map<string, Promise<void>>();
    const mgr = makeStubMgr(() => Promise.resolve());

    trackComposeStop(map, "s1", mgr);
    expect(map.has("s1")).toBe(true);
    expect(mgr.stop).toHaveBeenCalledTimes(1);

    await map.get("s1");
    expect(map.has("s1")).toBe(false);
  });

  it("clears the entry even when stop rejects", async () => {
    const map = new Map<string, Promise<void>>();
    const mgr = makeStubMgr(() => Promise.reject(new Error("compose down failed")));

    trackComposeStop(map, "s1", mgr);
    await map.get("s1");
    expect(map.has("s1")).toBe(false);
  });

  it("does not delete a fresher stop promise during cleanup", async () => {
    const map = new Map<string, Promise<void>>();
    let resolveFirst!: () => void;
    const mgrA = makeStubMgr(() => new Promise<void>((r) => { resolveFirst = r; }));
    trackComposeStop(map, "s1", mgrA);
    const firstEntry = map.get("s1");

    let resolveSecond!: () => void;
    const mgrB = makeStubMgr(() => new Promise<void>((r) => { resolveSecond = r; }));
    trackComposeStop(map, "s1", mgrB);
    const secondEntry = map.get("s1");
    expect(secondEntry).not.toBe(firstEntry);

    resolveFirst();
    await firstEntry;
    expect(map.get("s1")).toBe(secondEntry);

    resolveSecond();
    await secondEntry;
    expect(map.has("s1")).toBe(false);
  });
});

describe("awaitComposeStop", () => {
  it("returns immediately when no pending stop", async () => {
    const map = new Map<string, Promise<void>>();
    const start = Date.now();
    await awaitComposeStop(map, "s1");
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("blocks until the prior stop settles", async () => {
    const map = new Map<string, Promise<void>>();
    let resolveStop!: () => void;
    const mgr = makeStubMgr(() => new Promise<void>((r) => { resolveStop = r; }));
    trackComposeStop(map, "s1", mgr);

    let resolved = false;
    const waiter = (async () => {
      await awaitComposeStop(map, "s1");
      resolved = true;
    })();

    await new Promise<void>((r) => setImmediate(r));
    expect(resolved).toBe(false);

    resolveStop();
    await waiter;
    expect(resolved).toBe(true);
  });

  it("gives up after the timeout instead of hanging forever", async () => {
    vi.useFakeTimers();
    try {
      const map = new Map<string, Promise<void>>();
      const mgr = makeStubMgr(() => new Promise<void>(() => {}));
      trackComposeStop(map, "s1", mgr);

      const waiter = awaitComposeStop(map, "s1");

      await vi.advanceTimersByTimeAsync(15_000);
      await waiter;
    } finally {
      vi.useRealTimers();
    }
  });
});
