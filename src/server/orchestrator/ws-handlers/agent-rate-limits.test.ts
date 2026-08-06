import { describe, expect, it } from "vitest";
import {
  MAX_LIMIT_NOTICE_CHARS,
  UNKNOWN_RESET_LOCKOUT_MS,
  detectHardExhaustion,
  detectHardExhaustionInTurnText,
  exhaustionLockoutUntil,
  normalizeAgentUsageLimitError,
} from "./agent-rate-limits.js";
import type { AgentId, SubscriptionLimits, SubscriptionLimitsMap, SubscriptionLimitsWindow } from "../../shared/types.js";

/**
 * The exact text the Claude CLI emitted in the incident this coverage exists
 * for (session 174b5d98, 2026-08-06 17:09 UTC) — verbatim, including the
 * middle dot, because the failure was that none of the patterns matched it.
 */
const SESSION_LIMIT_NOTICE = "You've hit your session limit · resets 5:10pm (UTC)";
const NOON_UTC = Date.parse("2026-08-06T12:00:00.000Z");

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

  // The exact string production missed: the CLI dropped "usage" and started
  // naming the `session` window, and none of the five patterns matched it.
  it("recognizes the CLI's own session-limit notice", () => {
    expect(detectHardExhaustion(SESSION_LIMIT_NOTICE, NOON_UTC))
      .toEqual({ resetAt: "2026-08-06T17:10:00.000Z" });
  });

  it("recognizes the window wordings with and without the word 'usage'", () => {
    for (const message of [
      "You've hit your session limit",
      "You've hit your session usage limit",
      "You've hit your weekly limit",
      "You've hit Claude's monthly usage limit",
    ]) {
      expect(detectHardExhaustion(message)).not.toBeNull();
    }
  });

  // The notice carries no date, so a clock time already past today is tomorrow's.
  it("resolves a wall-clock UTC reset to the next time that clock reads it", () => {
    expect(detectHardExhaustion("You've hit your session limit · resets 9am (UTC)", NOON_UTC))
      .toEqual({ resetAt: "2026-08-07T09:00:00.000Z" });
    expect(detectHardExhaustion("You've hit your session limit · resets 12:30am (UTC)", NOON_UTC))
      .toEqual({ resetAt: "2026-08-07T00:30:00.000Z" });
    expect(detectHardExhaustion("You've hit your session limit · resets 12:30pm (UTC)", NOON_UTC))
      .toEqual({ resetAt: "2026-08-06T12:30:00.000Z" });
  });

  // Without a named zone the hour is meaningless here; guessing one would
  // produce a lockout hours wrong. The 15-minute fallback is the right answer.
  // An offset suffix is the same case: `UTC+02:00` is not UTC.
  it("ignores a wall-clock reset that names no usable timezone", () => {
    for (const message of [
      "You've hit your session limit · resets 5:10pm",
      "You've hit your session limit · resets 5:10pm PT",
      "You've hit your session limit · resets 5:10pm UTC+02:00",
      "You've hit your session limit · resets 5:10pm UTC-7",
    ]) {
      expect(detectHardExhaustion(message, NOON_UTC)).toEqual({ resetAt: null });
    }
  });
});

/**
 * The structural half of the same incident: the limit notice arrived as
 * ASSISTANT TEXT on a `subtype: "success"` turn, so `agent_result.error` was
 * undefined and every error-gated detector was blind to it.
 */
describe("detectHardExhaustionInTurnText", () => {
  it("recognizes the notice production saw on the text channel", () => {
    expect(detectHardExhaustionInTurnText(SESSION_LIMIT_NOTICE, NOON_UTC))
      .toEqual({ resetAt: "2026-08-06T17:10:00.000Z" });
  });

  it("ignores an absent or empty final message", () => {
    for (const text of [undefined, null, "", "   "]) {
      expect(detectHardExhaustionInTurnText(text)).toBeNull();
    }
  });

  // The notice IS the message. Anchoring is what separates it from an ordinary
  // short turn summary that happens to contain the same words — the case a
  // reuse of the error channel's patterns would have gotten wrong, benching a
  // healthy Claude subscription over somebody else's billing problem.
  it("ignores a notice-shaped phrase that something else in the message introduces", () => {
    for (const text of [
      "The Vercel deploy failed because your account is out of credits; add funds and retry.",
      "The message is: You've hit your session limit.",
      "Nothing to do — the API returned quota exceeded for the third-party key.",
      "Retried twice; the upstream service is out of quota.",
    ]) {
      expect(text.length).toBeLessThan(MAX_LIMIT_NOTICE_CHARS);
      expect(detectHardExhaustionInTurnText(text)).toBeNull();
    }
  });

  // Decoration a CLI may prefix the notice with is not "something else".
  it("still matches through leading decoration", () => {
    expect(detectHardExhaustionInTurnText(`⏺ ${SESSION_LIMIT_NOTICE}`, NOON_UTC))
      .toEqual({ resetAt: "2026-08-06T17:10:00.000Z" });
  });

  // An agent DISCUSSING quota — including one working on this very file — must
  // not bench the account it is running on. Length is what separates a notice
  // from a discussion of one.
  it("ignores quota language buried in a long assistant message", () => {
    const prose =
      "I updated the exhaustion detector so that the CLI's newer wording, "
      + "\"You've hit your session limit\", is recognized on both the error channel "
      + "and the assistant-text channel. Previously the regex only knew about the "
      + "weekly, monthly and 5h usage limits, so a session-limit notice slipped "
      + "through and the turn retired as a success.";
    expect(prose.length).toBeGreaterThan(MAX_LIMIT_NOTICE_CHARS);
    expect(detectHardExhaustionInTurnText(prose)).toBeNull();
  });

  it("ignores an ordinary short turn summary", () => {
    for (const text of [
      "Done — all tests pass.",
      "I hit a rate limit on the API and retried; it succeeded.",
    ]) {
      expect(detectHardExhaustionInTurnText(text)).toBeNull();
    }
  });

  it("recognizes the CLI's other notice wordings", () => {
    for (const text of [
      "Claude usage limit reached",
      "Claude AI usage limit reached · resets 5am (UTC)",
      "You've hit your weekly limit",
    ]) {
      expect(detectHardExhaustionInTurnText(text)).not.toBeNull();
    }
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
