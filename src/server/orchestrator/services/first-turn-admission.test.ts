import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  withFirstTurnAdmission,
  claimFirstTurn,
  firstTurnClaimed,
  pinFirstTurnEgress,
  firstTurnEgressPin,
  consumeFirstTurnEgressPin,
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

/**
 * docs/285 — the session-scoped CLAIM, which is a different guarantee from the
 * section above: the section serializes entry, the claim marks the whole span
 * from before reconciliation until the turn is dispatched.
 */
describe("the first-turn claim (docs/285)", () => {
  beforeEach(() => _resetFirstTurnAdmission());

  it("holds across the span and clears on release", () => {
    expect(firstTurnClaimed("s1")).toBe(false);
    const release = claimFirstTurn("s1")!;
    // It must read as claimed for the WHOLE span, including the interval where
    // reconciliation has replaced the runner — which is why this is keyed by
    // session rather than stored on the runner object that gets destroyed.
    expect(firstTurnClaimed("s1")).toBe(true);
    expect(firstTurnClaimed("s2")).toBe(false);
    release();
    expect(firstTurnClaimed("s1")).toBe(false);
  });

  it("REFUSES a second claimant rather than handing it a no-op release", () => {
    // A no-op release made a loser indistinguishable from a winner, so it
    // carried on as though it owned the span and started a second first turn.
    // The caller has to be able to tell, because "someone else owns this
    // session's first turn" is exactly the condition it must act on.
    const first = claimFirstTurn("s1");
    expect(first).not.toBeNull();
    expect(claimFirstTurn("s1")).toBeNull();
    expect(firstTurnClaimed("s1")).toBe(true);
    first?.();
    expect(firstTurnClaimed("s1")).toBe(false);
    // Freed, so the next first Send for this session can own it.
    expect(claimFirstTurn("s1")).not.toBeNull();
  });

});

/**
 * docs/285 — the egress PIN, which is what actually keeps the first turn's mode
 * from moving.
 *
 * The claim marks the span; the pin carries the answer across it. Container
 * creation resolves containment when it reaches the plumbing step — an unbounded
 * time after the turn was admitted — so without a pin, whatever the store says
 * at that arbitrary moment decides the mode, and no amount of locking around the
 * admission changes that.
 */
describe("the first-turn egress pin (docs/285)", () => {
  beforeEach(() => _resetFirstTurnAdmission());

  it("holds the pinned value until a container consumes it", () => {
    expect(firstTurnEgressPin("s1")).toBeUndefined();
    pinFirstTurnEgress("s1", true);
    expect(firstTurnEgressPin("s1")).toBe(true);
    consumeFirstTurnEgressPin("s1");
    // Consumed: the next container for this session resolves from the store
    // again, so a mode changed after the first turn is an ordinary "applies on
    // next container start".
    expect(firstTurnEgressPin("s1")).toBeUndefined();
  });

  it("OUTLIVES the first-turn claim, because the container outlives the handler", () => {
    // The failure this exists for: the agent start is fire-and-forget
    // (`ProxyAgentProcess.run()`), so `handleSendMessage` returns — and its
    // `finally` runs — while the replacement container is still being built. A
    // pin tied to the claim was therefore gone before the creation it exists
    // for ever read it, and that creation sampled the store instead.
    const release = claimFirstTurn("s1")!;
    pinFirstTurnEgress("s1", false);
    release();
    expect(firstTurnClaimed("s1")).toBe(false);
    expect(firstTurnEgressPin("s1")).toBe(false);
    consumeFirstTurnEgressPin("s1");
  });

  it("pins Open as firmly as Contained", () => {
    // `false` must be distinguishable from "no pin", or an explicit Open pick
    // falls back to the store — the direction that silently RESTORES containment
    // the user opted out of.
    pinFirstTurnEgress("s1", false);
    expect(firstTurnEgressPin("s1")).toBe(false);
    consumeFirstTurnEgressPin("s1");
  });

  it("is scoped to its session", () => {
    pinFirstTurnEgress("s1", true);
    expect(firstTurnEgressPin("s2")).toBeUndefined();
    pinFirstTurnEgress("s2", false);
    expect(firstTurnEgressPin("s1")).toBe(true);
    expect(firstTurnEgressPin("s2")).toBe(false);
  });

  it("consumes only the named session's pin", () => {
    pinFirstTurnEgress("s1", true);
    pinFirstTurnEgress("s2", false);
    consumeFirstTurnEgressPin("s1");
    expect(firstTurnEgressPin("s1")).toBeUndefined();
    expect(firstTurnEgressPin("s2")).toBe(false);
  });

  it("expires rather than deciding a container built much later", async () => {
    // The backstop for the case that never arrives: a failed rebuild, local
    // mode, a closed tab. Without it the pin would still be there when some
    // unrelated later container is built, and would decide its mode from a
    // choice nobody is still making.
    vi.useFakeTimers();
    try {
      pinFirstTurnEgress("s1", true);
      expect(firstTurnEgressPin("s1")).toBe(true);
      await vi.advanceTimersByTimeAsync(119_000);
      expect(firstTurnEgressPin("s1")).toBe(true); // still inside a container build
      await vi.advanceTimersByTimeAsync(2_000);
      expect(firstTurnEgressPin("s1")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-pinning restarts the expiry rather than inheriting the old one", () => {
    pinFirstTurnEgress("s1", true);
    pinFirstTurnEgress("s1", false);
    expect(firstTurnEgressPin("s1")).toBe(false);
    consumeFirstTurnEgressPin("s1");
    expect(firstTurnEgressPin("s1")).toBeUndefined();
  });
});
