import { describe, expect, it } from "vitest";
import { PersistGateTimeoutError, withPersistLease } from "./persist-gate.js";
import { serializeStackOp } from "./stack-op-queue.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe("withPersistLease (docs/331)", () => {
  it("runs shared leases of one session together", async () => {
    const release = deferred();
    const order: string[] = [];
    const first = withPersistLease("s1", "shared", async () => {
      order.push("first");
      await release.promise;
    });
    const second = withPersistLease("s1", "shared", async () => { order.push("second"); });
    await second;
    expect(order).toEqual(["first", "second"]);
    release.resolve();
    await first;
  });

  it("keeps the exclusive side waiting until every shared lease ends, and later shared leases behind it", async () => {
    const release = deferred();
    const order: string[] = [];
    const start = withPersistLease("s2", "shared", async () => {
      await release.promise;
      order.push("start ends");
    });
    const copy = withPersistLease("s2", "exclusive", async () => { order.push("copy"); });
    const helper = withPersistLease("s2", "shared", async () => { order.push("helper"); });
    await tick();
    expect(order).toEqual([]);
    release.resolve();
    await Promise.all([start, copy, helper]);
    expect(order).toEqual(["start ends", "copy", "helper"]);
  });

  it("does not deadlock a shared lease taken inside a shared lease while an exclusive request waits", async () => {
    const inner = deferred();
    const order: string[] = [];
    const start = withPersistLease("s3", "shared", async () => {
      await inner.promise;
      // A Compose helper run inside the start's lease.
      await withPersistLease("s3", "shared", async () => { order.push("helper"); });
      order.push("up");
    });
    const copy = withPersistLease("s3", "exclusive", async () => { order.push("copy"); });
    await tick();
    inner.resolve();
    await Promise.all([start, copy]);
    expect(order).toEqual(["helper", "up", "copy"]);
  });

  it("lets a request inside the exclusive lease borrow it (rule 2)", async () => {
    const order: string[] = [];
    await withPersistLease("s4", "exclusive", async () => {
      await withPersistLease("s4", "shared", async () => { order.push("measure"); });
      await withPersistLease("s4", "exclusive", async () => { order.push("nested"); });
    });
    expect(order).toEqual(["measure", "nested"]);
  });

  it("refuses an exclusive request inside a shared lease of the same session", async () => {
    await expect(withPersistLease("s5", "shared", () => withPersistLease("s5", "exclusive", async () => "x")))
      .rejects.toThrow(/exclusive/);
  });

  it("keeps sessions apart", async () => {
    const release = deferred();
    const held = withPersistLease("s6", "exclusive", () => release.promise);
    await withPersistLease("s7", "exclusive", async () => undefined);
    release.resolve();
    await held;
  });

  it("gives up after the timeout and lets the requests behind it run", async () => {
    const release = deferred();
    const start = withPersistLease("s8", "shared", () => release.promise);
    const copy = withPersistLease("s8", "exclusive", async () => "copied", { timeoutMs: 20 });
    const order: string[] = [];
    const helper = withPersistLease("s8", "shared", async () => { order.push("helper"); });
    await expect(copy).rejects.toBeInstanceOf(PersistGateTimeoutError);
    await helper;
    expect(order).toEqual(["helper"]);
    release.resolve();
    await start;
  });

  it("does not let work that outlives its lease borrow it", async () => {
    const order: string[] = [];
    const go = deferred();
    let late!: Promise<void>;
    await withPersistLease("s9", "exclusive", async () => {
      // Started inside the lease, so it carries the lease's context after the lease ends.
      late = (async () => {
        await go.promise;
        await withPersistLease("s9", "shared", async () => { order.push("late helper"); });
      })();
    });
    const release = deferred();
    const copy = withPersistLease("s9", "exclusive", async () => {
      await release.promise;
      order.push("copy");
    });
    go.resolve();
    await tick();
    expect(order).toEqual([]);
    release.resolve();
    await Promise.all([copy, late]);
    expect(order).toEqual(["copy", "late helper"]);
  });

  it("finishes a copy while a start that holds the stack queue waits for the shared side (rule 3)", async () => {
    const order: string[] = [];
    const inCopy = deferred();
    const copy = withPersistLease("s10", "exclusive", async () => {
      await inCopy.promise;
      order.push("copy");
    });
    const start = serializeStackOp("s10", () => withPersistLease("s10", "shared", async () => {
      order.push("start");
    }));
    await tick();
    inCopy.resolve();
    await Promise.all([copy, start]);
    expect(order).toEqual(["copy", "start"]);
  });
});
