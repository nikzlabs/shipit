import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { RemediationArbiter, CLAIM_TTL_MS } from "./auto-remediation-arbiter.js";

describe("RemediationArbiter", () => {
  let arb: RemediationArbiter;
  beforeEach(() => { arb = new RemediationArbiter(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("grants a single claim and reports it held", () => {
    expect(arb.claim("s1", "sha1", "auto-fix")).toBe(true);
    expect(arb.isClaimed("s1")).toBe(true);
  });

  it("mutual exclusion: a second automation cannot claim while one is held", () => {
    expect(arb.claim("s1", "sha1", "auto-fix")).toBe(true);
    expect(arb.claim("s1", "sha1", "auto-resolve")).toBe(false);
    // The same owner re-claiming is a no-op success (multi-turn attempt).
    expect(arb.claim("s1", "sha1", "auto-fix")).toBe(true);
  });

  it("shouldSuppress is true while a claim is held (any head)", () => {
    arb.claim("s1", "sha1", "auto-fix");
    expect(arb.shouldSuppress("s1", "sha1")).toBe(true);
    expect(arb.shouldSuppress("s1", "sha-other")).toBe(true);
  });

  it("release(pushed:false) leaves the same-head budget untouched", () => {
    arb.claim("s1", "sha1", "auto-fix");
    arb.release("s1", "auto-fix", { pushed: false });
    expect(arb.isClaimed("s1")).toBe(false);
    // No suppression on the same head — a same-head retry is allowed.
    expect(arb.shouldSuppress("s1", "sha1")).toBe(false);
    expect(arb.claim("s1", "sha1", "auto-resolve")).toBe(true);
  });

  it("release(pushed:true) arms await-fresh-signal on the acted head", () => {
    arb.claim("s1", "sha1", "auto-resolve");
    arb.release("s1", "auto-resolve", { pushed: true });
    expect(arb.lastActedHeadSha("s1")).toBe("sha1");
    // Same head is suppressed; a fresh head lifts suppression.
    expect(arb.shouldSuppress("s1", "sha1")).toBe(true);
    // Another automation cannot claim on the still-stale head.
    expect(arb.claim("s1", "sha1", "auto-fix")).toBe(false);
  });

  it("await-fresh-signal lifts the moment a different head SHA is observed", () => {
    arb.claim("s1", "sha1", "auto-resolve");
    arb.release("s1", "auto-resolve", { pushed: true });
    expect(arb.shouldSuppress("s1", "sha1")).toBe(true);
    // A new head lands → suppression lifts and clears.
    expect(arb.shouldSuppress("s1", "sha2")).toBe(false);
    expect(arb.lastActedHeadSha("s1")).toBeUndefined();
    expect(arb.shouldSuppress("s1", "sha1")).toBe(false);
  });

  it("full cross-cycle: auto-resolve pushes → new head → auto-fix may claim", () => {
    // 1. auto-resolve claims + force-pushes on sha1.
    expect(arb.claim("s1", "sha1", "auto-resolve")).toBe(true);
    arb.release("s1", "auto-resolve", { pushed: true });
    // 2. On the still-old head (GitHub hasn't recomputed), auto-fix is suppressed.
    expect(arb.shouldSuppress("s1", "sha1")).toBe(true);
    // 3. The poller observes the new head sha2 (fresh CI verdict) → suppression lifts.
    expect(arb.shouldSuppress("s1", "sha2")).toBe(false);
    // 4. auto-fix can now claim on the fresh head.
    expect(arb.claim("s1", "sha2", "auto-fix")).toBe(true);
  });

  it("liveness: double-release is a safe no-op, and a release by a non-owner is ignored", () => {
    arb.claim("s1", "sha1", "auto-fix");
    arb.release("s1", "auto-resolve", { pushed: true }); // wrong owner — ignored
    expect(arb.isClaimed("s1")).toBe(true);
    arb.release("s1", "auto-fix", { pushed: false });
    expect(arb.isClaimed("s1")).toBe(false);
    arb.release("s1", "auto-fix", { pushed: false }); // double release — no throw
    expect(arb.isClaimed("s1")).toBe(false);
  });

  it("delete drops all state for a session", () => {
    arb.claim("s1", "sha1", "auto-fix");
    arb.release("s1", "auto-fix", { pushed: true });
    arb.delete("s1");
    expect(arb.lastActedHeadSha("s1")).toBeUndefined();
    expect(arb.shouldSuppress("s1", "sha1")).toBe(false);
    expect(arb.isClaimed("s1")).toBe(false);
  });

  it("sessions are isolated from one another", () => {
    arb.claim("s1", "sha1", "auto-fix");
    expect(arb.isClaimed("s2")).toBe(false);
    expect(arb.claim("s2", "sha9", "auto-resolve")).toBe(true);
  });

  // The TTL backstop. Guarantee 1 ("released on EVERY terminal path") is
  // convention, and convention failed in production: an auto-fix attempt whose
  // fix turn was dispatched into a runner that then went away never reached its
  // terminal write, so the claim never released — and with no TTL that wedged
  // managed auto-merge and auto-resolve for the session indefinitely.
  describe("claim TTL backstop", () => {
    let now: number;
    let ttlArb: RemediationArbiter;
    beforeEach(() => {
      now = 1_000_000;
      ttlArb = new RemediationArbiter(() => now);
    });

    it("a claim held past the TTL stops suppressing and stops reading as held", () => {
      vi.spyOn(console, "warn").mockImplementation(() => { /* expected */ });
      ttlArb.claim("s1", "sha1", "auto-fix");
      expect(ttlArb.isClaimed("s1")).toBe(true);
      expect(ttlArb.shouldSuppress("s1", "sha1")).toBe(true);

      // Just under the TTL: still a live claim (a slow attempt is not a leak).
      now += CLAIM_TTL_MS - 1;
      expect(ttlArb.isClaimed("s1")).toBe(true);

      now += 2;
      expect(ttlArb.isClaimed("s1")).toBe(false);
      expect(ttlArb.shouldSuppress("s1", "sha1")).toBe(false);
    });

    it("the other automation can claim once an abandoned claim expires", () => {
      vi.spyOn(console, "warn").mockImplementation(() => { /* expected */ });
      ttlArb.claim("s1", "sha1", "auto-fix");
      expect(ttlArb.claim("s1", "sha1", "auto-resolve")).toBe(false);

      now += CLAIM_TTL_MS + 1;

      expect(ttlArb.claim("s1", "sha1", "auto-resolve")).toBe(true);
      expect(ttlArb.isClaimed("s1")).toBe(true);
    });

    it("a released-and-reclaimed slot restarts the TTL clock", () => {
      ttlArb.claim("s1", "sha1", "auto-fix");
      now += CLAIM_TTL_MS - 1;
      ttlArb.release("s1", "auto-fix", { pushed: false });
      ttlArb.claim("s1", "sha1", "auto-fix");
      now += 2;
      // The second claim is young — the first claim's age must not carry over.
      expect(ttlArb.isClaimed("s1")).toBe(true);
    });
  });
});
