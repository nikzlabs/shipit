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
    expect(arb.shouldSuppress("s1", "sha1")).toBe(false);
    expect(arb.claim("s1", "sha1", "auto-resolve")).toBe(true);
  });

  it("release(pushed:true) arms await-fresh-signal on the acted head", () => {
    arb.claim("s1", "sha1", "auto-resolve");
    arb.release("s1", "auto-resolve", { pushed: true });
    expect(arb.lastActedHeadSha("s1")).toBe("sha1");
    expect(arb.shouldSuppress("s1", "sha1")).toBe(true);
    expect(arb.claim("s1", "sha1", "auto-fix")).toBe(false);
  });

  it("await-fresh-signal lifts the moment a different head SHA is observed", () => {
    arb.claim("s1", "sha1", "auto-resolve");
    arb.release("s1", "auto-resolve", { pushed: true });
    expect(arb.shouldSuppress("s1", "sha1")).toBe(true);
    expect(arb.shouldSuppress("s1", "sha2")).toBe(false);
    expect(arb.lastActedHeadSha("s1")).toBeUndefined();
    expect(arb.shouldSuppress("s1", "sha1")).toBe(false);
  });

  it("full cross-cycle: auto-resolve pushes → new head → auto-fix may claim", () => {
    expect(arb.claim("s1", "sha1", "auto-resolve")).toBe(true);
    arb.release("s1", "auto-resolve", { pushed: true });
    expect(arb.shouldSuppress("s1", "sha1")).toBe(true);
    expect(arb.shouldSuppress("s1", "sha2")).toBe(false);
    expect(arb.claim("s1", "sha2", "auto-fix")).toBe(true);
  });

  it("liveness: double-release is a safe no-op, and a release by a non-owner is ignored", () => {
    arb.claim("s1", "sha1", "auto-fix");
    arb.release("s1", "auto-resolve", { pushed: true });
    expect(arb.isClaimed("s1")).toBe(true);
    arb.release("s1", "auto-fix", { pushed: false });
    expect(arb.isClaimed("s1")).toBe(false);
    arb.release("s1", "auto-fix", { pushed: false });
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
      expect(ttlArb.isClaimed("s1")).toBe(true);
    });
  });
});
