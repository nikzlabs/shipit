import { describe, expect, it } from "vitest";
import {
  UNKNOWN_RESET_LOCKOUT_MS,
  detectHardExhaustion,
  exhaustionLockoutUntil,
  normalizeAgentUsageLimitError,
} from "./agent-rate-limits.js";
import type { AgentId, SubscriptionLimits, SubscriptionLimitsMap, SubscriptionLimitsWindow } from "../../shared/types.js";

const snapshot = (
  agentId: AgentId,
  session: SubscriptionLimitsWindow | null,
  routeId = `acct-${agentId}`,
): SubscriptionLimits => ({
  agentId,
  routeId,
  plan: null,
  session,
  weekly: null,
  fetchedAt: 0,
});

const limitsFor = (agentId: AgentId, session: SubscriptionLimitsWindow | null): SubscriptionLimitsMap => ({
  [agentId]: { [`acct-${agentId}`]: snapshot(agentId, session) },
});

/** docs/150 — two connected accounts for one provider. */
const twoAccounts = (
  agentId: AgentId,
  a: SubscriptionLimitsWindow | null,
  b: SubscriptionLimitsWindow | null,
): SubscriptionLimitsMap => ({
  [agentId]: {
    "acct-a": snapshot(agentId, a, "acct-a"),
    "acct-b": snapshot(agentId, b, "acct-b"),
  },
});

describe("normalizeAgentUsageLimitError", () => {
  it("leaves a non-usage-limit message untouched", () => {
    const limits = limitsFor("claude", { usedPct: 100, resetAt: "2026-06-16T05:00:00.000Z" });
    expect(normalizeAgentUsageLimitError("claude", "network error", limits)).toBe("network error");
  });

  it("keeps the upstream text when there is no subscription snapshot", () => {
    expect(normalizeAgentUsageLimitError("claude", "monthly usage limit reached", undefined)).toBe(
      "monthly usage limit reached",
    );
  });

  it("keeps the upstream text when the session window has no reported utilization (usedPct null)", () => {
    const limits = limitsFor("claude", { usedPct: null, resetAt: "2026-06-16T05:00:00.000Z" });
    expect(normalizeAgentUsageLimitError("claude", "monthly usage limit reached", limits)).toBe(
      "monthly usage limit reached",
    );
  });

  it("keeps the upstream text when the session window is not yet exhausted (usedPct < 100)", () => {
    const limits = limitsFor("claude", { usedPct: 80, resetAt: "2026-06-16T05:00:00.000Z" });
    expect(normalizeAgentUsageLimitError("claude", "monthly usage limit reached", limits)).toBe(
      "monthly usage limit reached",
    );
  });

  it("reclassifies to the 5h-window message when the session window is exhausted", () => {
    const limits = limitsFor("claude", { usedPct: 100, resetAt: "2026-06-16T05:00:00.000Z" });
    expect(normalizeAgentUsageLimitError("claude", "monthly usage limit reached", limits)).toBe(
      "You've hit Claude's 5h usage limit. It resets at 2026-06-16T05:00:00.000Z.",
    );
  });

  it("labels the agent by id (Codex) and normalizes the reset time to ISO", () => {
    const limits = limitsFor("codex", { usedPct: 100, resetAt: "2026-06-16T05:00:00.000Z" });
    expect(normalizeAgentUsageLimitError("codex", "Monthly Usage Limit", limits)).toBe(
      "You've hit Codex's 5h usage limit. It resets at 2026-06-16T05:00:00.000Z.",
    );
  });

  it("falls back to the raw resetAt string when it isn't a parseable date", () => {
    const limits = limitsFor("claude", { usedPct: 100, resetAt: "not-a-date" });
    expect(normalizeAgentUsageLimitError("claude", "monthly usage limit", limits)).toBe(
      "You've hit Claude's 5h usage limit. It resets at not-a-date.",
    );
  });

  it("does not claim exhaustion while another connected account still has quota", () => {
    // docs/150 — with two subscriptions, one exhausted window is not "you are
    // out of quota": failover will move the turn to the healthy account.
    const limits = twoAccounts(
      "claude",
      { usedPct: 100, resetAt: "2026-06-16T05:00:00.000Z" },
      { usedPct: 12, resetAt: "2026-06-16T09:00:00.000Z" },
    );
    expect(normalizeAgentUsageLimitError("claude", "monthly usage limit", limits)).toBe(
      "monthly usage limit",
    );
  });

  it("reports the soonest reset once every connected account is exhausted", () => {
    const limits = twoAccounts(
      "claude",
      { usedPct: 100, resetAt: "2026-06-16T09:00:00.000Z" },
      { usedPct: 100, resetAt: "2026-06-16T05:00:00.000Z" },
    );
    expect(normalizeAgentUsageLimitError("claude", "monthly usage limit", limits)).toBe(
      "You've hit Claude's 5h usage limit. It resets at 2026-06-16T05:00:00.000Z.",
    );
  });
});

/**
 * docs/150 req 7 — recognizing that a failed turn means the *subscription* is
 * spent, as opposed to any of the other things a turn dies of. A false
 * positive benches a working subscription, so the negative cases matter as
 * much as the positive ones.
 */
describe("detectHardExhaustion", () => {
  it("recognizes each provider's normalized usage-limit message and keeps the reset instant", () => {
    const resetAt = new Date(Date.now() + 3_600_000).toISOString();
    for (const message of [
      `You've hit Claude's 5h usage limit. It resets at ${resetAt}.`,
      `You've hit Codex's 5h usage limit. It resets at ${resetAt}.`,
    ]) {
      expect(detectHardExhaustion(message)).toEqual({ resetAt });
    }
  });

  it("recognizes upstream phrasings that carry no reset instant", () => {
    for (const message of [
      "Claude AI usage limit reached",
      "You've hit your weekly limit",
      "Your organization's monthly usage limit has been reached",
      "quota exceeded for this account",
    ]) {
      expect(detectHardExhaustion(message)).toEqual({ resetAt: null });
    }
  });

  // Short-term throttling is not subscription exhaustion — a retry fixes it,
  // and benching the account would take a healthy subscription out of service.
  it("does not fire on throttling, auth, or ordinary turn failures", () => {
    for (const message of [
      "429 Too Many Requests",
      "rate limit exceeded, please retry",
      "API Error: 401 Unauthorized",
      "Request timed out",
      "tool use failed: file not found",
      "",
      // docs/150 req 17 (non-goal) — a model the account cannot run must NOT
      // trigger the same-turn retry. "No automatic recovery" holds because this
      // detector is the retry's only trigger and matches quota language only.
      "model claude-opus-5 is not available on your plan",
      "The model `claude-opus-5` does not exist or you do not have access to it",
      "This model is not supported for your account",
    ]) {
      expect(detectHardExhaustion(message)).toBeNull();
    }
  });

  // The message describes the window that just ended, not one that blocks us;
  // stamping it would persist an already-expired lockout that blocks nothing.
  it("treats an already-past reset instant as unknown", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(detectHardExhaustion(`You've hit Claude's 5h usage limit. It resets at ${past}.`))
      .toEqual({ resetAt: null });
  });
});

describe("exhaustionLockoutUntil", () => {
  const NOW = 1_800_000_000_000;

  it("uses the provider's own reset instant when it gave one", () => {
    const resetAt = new Date(NOW + 3_600_000).toISOString();
    expect(exhaustionLockoutUntil({ resetAt }, NOW)).toBe(NOW + 3_600_000);
  });

  it("falls back to a short self-expiring lockout when the reset is unknown", () => {
    expect(exhaustionLockoutUntil({ resetAt: null }, NOW)).toBe(NOW + UNKNOWN_RESET_LOCKOUT_MS);
  });

  it("falls back rather than producing NaN on an unparseable instant", () => {
    expect(exhaustionLockoutUntil({ resetAt: "soon-ish" }, NOW)).toBe(NOW + UNKNOWN_RESET_LOCKOUT_MS);
  });
});
