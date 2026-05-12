import { describe, it, expect } from "vitest";
import { createOomCircuitBreaker } from "./oom-circuit-breaker.js";

describe("createOomCircuitBreaker", () => {
  function mkBreaker(start = 1_000_000) {
    let t = start;
    const breaker = createOomCircuitBreaker({
      windowMs: 60_000,
      threshold: 3,
      now: () => t,
    });
    return {
      breaker,
      advance(ms: number) { t += ms; },
      at() { return t; },
    };
  }

  it("does not trip below the threshold", () => {
    const { breaker } = mkBreaker();
    const r1 = breaker.recordOom("s");
    const r2 = breaker.recordOom("s");
    expect(r1.tripped).toBe(false);
    expect(r2.tripped).toBe(false);
    expect(r1.countInWindow).toBe(1);
    expect(r2.countInWindow).toBe(2);
    expect(breaker.isTripped("s")).toBe(false);
  });

  it("trips on the Nth OOM and reports justTripped only once", () => {
    const { breaker } = mkBreaker();
    breaker.recordOom("s");
    breaker.recordOom("s");
    const tripping = breaker.recordOom("s");
    expect(tripping.tripped).toBe(true);
    expect(tripping.justTripped).toBe(true);
    expect(tripping.countInWindow).toBe(3);

    // A subsequent OOM keeps it tripped but doesn't re-flip the edge.
    const next = breaker.recordOom("s");
    expect(next.tripped).toBe(true);
    expect(next.justTripped).toBe(false);
  });

  it("records trippedAt at the time of the threshold-crossing OOM", () => {
    const { breaker, advance, at } = mkBreaker();
    breaker.recordOom("s");
    advance(5_000);
    breaker.recordOom("s");
    advance(5_000);
    const trippingTs = at();
    breaker.recordOom("s");
    expect(breaker.getState("s").trippedAt).toBe(trippingTs);
  });

  it("evicts old OOMs outside the window", () => {
    const { breaker, advance } = mkBreaker();
    breaker.recordOom("s"); // window starts here
    advance(30_000);
    breaker.recordOom("s");
    advance(40_000); // first OOM now outside the 60s window
    const result = breaker.recordOom("s");
    // First OOM evicted; we should still only have 2 in window.
    expect(result.countInWindow).toBe(2);
    expect(result.tripped).toBe(false);
  });

  it("isolates state across sessions", () => {
    const { breaker } = mkBreaker();
    breaker.recordOom("a");
    breaker.recordOom("a");
    breaker.recordOom("a");
    expect(breaker.isTripped("a")).toBe(true);
    expect(breaker.isTripped("b")).toBe(false);
    expect(breaker.getState("b").countInWindow).toBe(0);
  });

  it("getState returns a healthy snapshot for unknown sessions", () => {
    const { breaker } = mkBreaker();
    const state = breaker.getState("never-seen");
    expect(state.tripped).toBe(false);
    expect(state.countInWindow).toBe(0);
    expect(state.lastOomAt).toBeNull();
    expect(state.trippedAt).toBeNull();
    expect(state.threshold).toBe(3);
    expect(state.windowMs).toBe(60_000);
  });

  it("reset clears trip + history so a fresh sequence has to re-trip", () => {
    const { breaker } = mkBreaker();
    breaker.recordOom("s");
    breaker.recordOom("s");
    breaker.recordOom("s");
    expect(breaker.isTripped("s")).toBe(true);

    breaker.reset("s");
    expect(breaker.isTripped("s")).toBe(false);
    expect(breaker.getState("s").countInWindow).toBe(0);

    // After reset, two more OOMs should NOT re-trip — we're starting over.
    breaker.recordOom("s");
    const second = breaker.recordOom("s");
    expect(second.tripped).toBe(false);
  });

  it("forget is equivalent to reset for the public surface", () => {
    const { breaker } = mkBreaker();
    breaker.recordOom("s");
    breaker.recordOom("s");
    breaker.recordOom("s");
    breaker.forget("s");
    expect(breaker.isTripped("s")).toBe(false);
    expect(breaker.getState("s").countInWindow).toBe(0);
  });

  it("recordOom returns the latest lastOomAt", () => {
    const { breaker, advance, at } = mkBreaker();
    breaker.recordOom("s");
    advance(1_000);
    const r = breaker.recordOom("s");
    expect(r.lastOomAt).toBe(at());
  });
});
