/**
 * planning#371 — the decision-query token registry.
 *
 * Three concerns: a token is valid only for the session it was minted for; a
 * token this process never minted is recovered from the sidecar's own
 * environment (the orchestrator-restart case); and the recovery is throttled, so
 * a container-reachable route cannot be used to drive Docker inspections.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  EGRESS_DECISION_HEADER,
  EGRESS_DECISION_TOKEN_ENV,
  clearAllEgressDecisionTokens,
  clearEgressDecisionTokens,
  isEgressDecisionPath,
  mintEgressDecisionToken,
  presentedEgressDecisionToken,
  setEgressDecisionTokenRecovery,
  tokenFromContainerEnv,
  verifyEgressDecisionToken,
} from "./egress-decision-auth.js";

describe("egress decision tokens", () => {
  beforeEach(() => {
    clearAllEgressDecisionTokens();
  });
  afterEach(() => {
    clearAllEgressDecisionTokens();
    vi.useRealTimers();
  });

  it("accepts a minted token for its own session only", async () => {
    const token = mintEgressDecisionToken("sess-a");
    expect(await verifyEgressDecisionToken("sess-a", token)).toBe(true);
    expect(await verifyEgressDecisionToken("sess-b", token)).toBe(false);
  });

  it("mints a distinct token per launch and keeps earlier ones valid", async () => {
    const first = mintEgressDecisionToken("sess-a");
    const second = mintEgressDecisionToken("sess-a");
    expect(second).not.toBe(first);
    expect(await verifyEgressDecisionToken("sess-a", first)).toBe(true);
    expect(await verifyEgressDecisionToken("sess-a", second)).toBe(true);
  });

  it("rejects a malformed token without consulting the recovery seam", async () => {
    const recover = vi.fn(async () => []);
    setEgressDecisionTokenRecovery(recover);
    expect(await verifyEgressDecisionToken("sess-a", "not-a-token")).toBe(false);
    expect(await verifyEgressDecisionToken("sess-a", "")).toBe(false);
    expect(recover).not.toHaveBeenCalled();
  });

  it("forgets a session's tokens when its containers are torn down", async () => {
    const token = mintEgressDecisionToken("sess-a");
    clearEgressDecisionTokens("sess-a");
    expect(await verifyEgressDecisionToken("sess-a", token)).toBe(false);
  });

  it("recovers a token this process never minted (orchestrator restart)", async () => {
    // Minted by a previous orchestrator, still in the live sidecar's env.
    const survivor = mintEgressDecisionToken("sess-a");
    clearEgressDecisionTokens("sess-a");
    setEgressDecisionTokenRecovery(async (sessionId) =>
      sessionId === "sess-a" ? [survivor] : []);

    expect(await verifyEgressDecisionToken("sess-a", survivor)).toBe(true);
    // And it is cached — a second query does not re-inspect.
    setEgressDecisionTokenRecovery(async () => {
      throw new Error("should not be consulted again");
    });
    expect(await verifyEgressDecisionToken("sess-a", survivor)).toBe(true);
  });

  it("throttles recovery so a bad token cannot drive repeated inspections", async () => {
    vi.useFakeTimers();
    const recover = vi.fn(async () => []);
    setEgressDecisionTokenRecovery(recover);
    const bogus = "a".repeat(64);

    expect(await verifyEgressDecisionToken("sess-a", bogus)).toBe(false);
    expect(await verifyEgressDecisionToken("sess-a", bogus)).toBe(false);
    expect(await verifyEgressDecisionToken("sess-a", bogus)).toBe(false);
    expect(recover).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5_001);
    expect(await verifyEgressDecisionToken("sess-a", bogus)).toBe(false);
    expect(recover).toHaveBeenCalledTimes(2);
  });

  it("treats a failing recovery as a denial, not an error", async () => {
    setEgressDecisionTokenRecovery(async () => {
      throw new Error("docker is unavailable");
    });
    expect(await verifyEgressDecisionToken("sess-a", "b".repeat(64))).toBe(false);
  });

  it("reads the token back out of a container env array", () => {
    expect(tokenFromContainerEnv([
      "EGRESS_PROXY_ALLOWED=.github.com",
      `${EGRESS_DECISION_TOKEN_ENV}=abc123`,
    ])).toBe("abc123");
    expect(tokenFromContainerEnv([`${EGRESS_DECISION_TOKEN_ENV}=`])).toBeUndefined();
    expect(tokenFromContainerEnv(undefined)).toBeUndefined();
  });

  it("reads the header only in its single-value form", () => {
    expect(presentedEgressDecisionToken({ [EGRESS_DECISION_HEADER]: "t" })).toBe("t");
    expect(presentedEgressDecisionToken({ [EGRESS_DECISION_HEADER]: ["a", "b"] })).toBeUndefined();
    expect(presentedEgressDecisionToken({})).toBeUndefined();
  });

  it("authenticates the decision route and nothing else", () => {
    expect(isEgressDecisionPath("/api/egress/decision")).toBe(true);
    expect(isEgressDecisionPath("/api/egress/settings")).toBe(false);
    expect(isEgressDecisionPath("/api/egress/decision/x")).toBe(false);
  });
});
