import { describe, it, expect, beforeEach } from "vitest";
import {
  withFirstTurnAdmission,
  firstTurnAdmissionHeld,
  _resetFirstTurnAdmission,
} from "./first-turn-admission.js";

/**
 * docs/285 — the session-keyed critical section around a session's first turn.
 *
 * What it has to guarantee: two near-simultaneous first Sends do not both
 * reconcile; a mode written while one is in flight lands after it, not inside
 * it; and a failure in one holder does not strand every later one.
 */

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("withFirstTurnAdmission (docs/285)", () => {
  beforeEach(() => _resetFirstTurnAdmission());

  it("runs one holder at a time, in arrival order", async () => {
    const order: string[] = [];
    const first = deferred<null>();

    const a = withFirstTurnAdmission("s1", async () => {
      order.push("a:start");
      await first.promise;
      order.push("a:end");
    });
    const b = withFirstTurnAdmission("s1", async () => {
      order.push("b:start");
    });

    // B must not have begun while A holds the section — this is the whole point:
    // with an 8-second container restart inside A, two first Sends would
    // otherwise both pass the idle check and both reconcile.
    await Promise.resolve();
    expect(order).toEqual(["a:start"]);

    first.resolve(null);
    await Promise.all([a, b]);
    expect(order).toEqual(["a:start", "a:end", "b:start"]);
  });

  it("does not serialize across different sessions", async () => {
    const started: string[] = [];
    const hold = deferred<null>();
    const a = withFirstTurnAdmission("s1", async () => {
      started.push("s1");
      await hold.promise;
    });
    const b = withFirstTurnAdmission("s2", async () => {
      started.push("s2");
    });
    await b;
    // A lock held across every session would put a container restart in front of
    // an unrelated session's first message.
    expect(started).toContain("s2");
    hold.resolve(null);
    await a;
  });

  it("releases the section when a holder throws, and propagates only to its own caller", async () => {
    const failing = withFirstTurnAdmission("s1", async () => {
      throw new Error("restart blew up");
    });
    await expect(failing).rejects.toThrow("restart blew up");

    // A failed first Send must not take the queue down with it.
    await expect(withFirstTurnAdmission("s1", async () => "ok")).resolves.toBe("ok");
  });

  it("reports the section as held while someone owns it, and free once it drains", async () => {
    // The reported state is what lets a competing Send queue rather than fall
    // through — and it must not stay held forever, or the session reads as
    // permanently busy.
    expect(firstTurnAdmissionHeld("s1")).toBe(false);
    const hold = deferred<null>();
    const run = withFirstTurnAdmission("s1", async () => {
      await hold.promise;
    });
    expect(firstTurnAdmissionHeld("s1")).toBe(true);
    hold.resolve(null);
    await run;
    // Drain is asynchronous — let the chain's own cleanup tick.
    await new Promise((r) => setTimeout(r, 0));
    expect(firstTurnAdmissionHeld("s1")).toBe(false);
  });

  it("keeps a waiter's turn when a later arrival replaces the chain tail", async () => {
    // The cleanup must only clear the entry it owns. Dropping a tail another
    // waiter has already replaced would let the next arrival run concurrently.
    const order: string[] = [];
    const hold = deferred<null>();
    const a = withFirstTurnAdmission("s1", async () => {
      await hold.promise;
      order.push("a");
    });
    const b = withFirstTurnAdmission("s1", async () => { order.push("b"); });
    const c = withFirstTurnAdmission("s1", async () => { order.push("c"); });
    hold.resolve(null);
    await Promise.all([a, b, c]);
    expect(order).toEqual(["a", "b", "c"]);
  });
});
