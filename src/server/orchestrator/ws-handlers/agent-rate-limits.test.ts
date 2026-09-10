import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_LIMIT_NOTICE_CHARS,
  UNKNOWN_RESET_LOCKOUT_MS,
  detectHardExhaustion,
  detectHardExhaustionInTurnText,
  exhaustionLockoutUntil,
  normalizeAgentUsageLimitError,
} from "./agent-rate-limits.js";
import type { AgentId, SubscriptionLimits, SubscriptionLimitsMap, SubscriptionLimitsWindow } from "../../shared/types.js";

// Captured from Claude CLI, 2026-08-06 17:09 UTC, session 174b5d98.
const SESSION_LIMIT_NOTICE = "You've hit your session limit · resets 5:10pm (UTC)";
const NOON_UTC = Date.parse("2026-08-06T12:00:00.000Z");

const GROK_FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../session/agents/grok/__fixtures__",
);

const serviceOf = (agentId: AgentId): string => (agentId === "claude" ? "anthropic" : "openai");

const snapshot = (
  agentId: AgentId,
  session: SubscriptionLimitsWindow | null,
  routeId = `acct-${agentId}`,
): SubscriptionLimits => ({
  serviceId: serviceOf(agentId),
  billingMode: "sub",
  routeId,
  plan: null,
  session,
  weekly: null,
  fetchedAt: 0,
});

const limitsFor = (agentId: AgentId, session: SubscriptionLimitsWindow | null): SubscriptionLimitsMap => ({
  [`${serviceOf(agentId)}:sub`]: { [`acct-${agentId}`]: snapshot(agentId, session) },
});

const twoAccounts = (
  agentId: AgentId,
  a: SubscriptionLimitsWindow | null,
  b: SubscriptionLimitsWindow | null,
): SubscriptionLimitsMap => ({
  [`${serviceOf(agentId)}:sub`]: {
    "acct-a": snapshot(agentId, a, "acct-a"),
    "acct-b": snapshot(agentId, b, "acct-b"),
  },
});

const BEFORE_RESET = Date.parse("2026-06-16T00:00:00.000Z");

describe("normalizeAgentUsageLimitError", () => {
  it("leaves a non-usage-limit message untouched", () => {
    const limits = limitsFor("claude", { usedPct: 100, resetAt: "2026-06-16T05:00:00.000Z" });
    expect(normalizeAgentUsageLimitError("claude", "network error", limits, BEFORE_RESET)).toBe("network error");
  });

  it("keeps the upstream text when there is no subscription snapshot", () => {
    expect(normalizeAgentUsageLimitError("claude", "monthly usage limit reached", undefined, BEFORE_RESET)).toBe(
      "monthly usage limit reached",
    );
  });

  it("keeps the upstream text when the session window has no reported utilization (usedPct null)", () => {
    const limits = limitsFor("claude", { usedPct: null, resetAt: "2026-06-16T05:00:00.000Z" });
    expect(normalizeAgentUsageLimitError("claude", "monthly usage limit reached", limits, BEFORE_RESET)).toBe(
      "monthly usage limit reached",
    );
  });

  it("keeps the upstream text when the session window is not yet exhausted (usedPct < 100)", () => {
    const limits = limitsFor("claude", { usedPct: 80, resetAt: "2026-06-16T05:00:00.000Z" });
    expect(normalizeAgentUsageLimitError("claude", "monthly usage limit reached", limits, BEFORE_RESET)).toBe(
      "monthly usage limit reached",
    );
  });

  it("reclassifies to the 5h-window message when the session window is exhausted", () => {
    const limits = limitsFor("claude", { usedPct: 100, resetAt: "2026-06-16T05:00:00.000Z" });
    expect(normalizeAgentUsageLimitError("claude", "monthly usage limit reached", limits, BEFORE_RESET)).toBe(
      "You've hit Claude's 5h usage limit. It resets at 2026-06-16T05:00:00.000Z.",
    );
  });

  it("labels the agent by id (Codex) and normalizes the reset time to ISO", () => {
    const limits = limitsFor("codex", { usedPct: 100, resetAt: "2026-06-16T05:00:00.000Z" });
    expect(normalizeAgentUsageLimitError("codex", "Monthly Usage Limit", limits, BEFORE_RESET)).toBe(
      "You've hit Codex's 5h usage limit. It resets at 2026-06-16T05:00:00.000Z.",
    );
  });

  it("keeps the upstream text when the exhausted window has already reset", () => {
    const limits = limitsFor("claude", { usedPct: 100, resetAt: "2026-06-16T05:00:00.000Z" });
    const afterReset = Date.parse("2026-06-16T06:00:00.000Z");
    expect(normalizeAgentUsageLimitError("claude", "monthly usage limit", limits, afterReset)).toBe(
      "monthly usage limit",
    );
  });

  it("keeps the upstream text when the reset time is not a parseable date", () => {
    const limits = limitsFor("claude", { usedPct: 100, resetAt: "not-a-date" });
    expect(normalizeAgentUsageLimitError("claude", "monthly usage limit", limits, BEFORE_RESET)).toBe(
      "monthly usage limit",
    );
  });

  it("does not claim exhaustion while another connected account still has quota", () => {
    const limits = twoAccounts(
      "claude",
      { usedPct: 100, resetAt: "2026-06-16T05:00:00.000Z" },
      { usedPct: 12, resetAt: "2026-06-16T09:00:00.000Z" },
    );
    expect(normalizeAgentUsageLimitError("claude", "monthly usage limit", limits, BEFORE_RESET)).toBe(
      "monthly usage limit",
    );
  });

  it("reports the soonest reset once every connected account is exhausted", () => {
    const limits = twoAccounts(
      "claude",
      { usedPct: 100, resetAt: "2026-06-16T09:00:00.000Z" },
      { usedPct: 100, resetAt: "2026-06-16T05:00:00.000Z" },
    );
    expect(normalizeAgentUsageLimitError("claude", "monthly usage limit", limits, BEFORE_RESET)).toBe(
      "You've hit Claude's 5h usage limit. It resets at 2026-06-16T05:00:00.000Z.",
    );
  });
});

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

  it("does not fire on throttling, auth, or ordinary turn failures", () => {
    for (const message of [
      "429 Too Many Requests",
      "rate limit exceeded, please retry",
      "API Error: 401 Unauthorized",
      "Request timed out",
      "tool use failed: file not found",
      "",
      "model claude-opus-5 is not available on your plan",
      "The model `claude-opus-5` does not exist or you do not have access to it",
      "This model is not supported for your account",
    ]) {
      expect(detectHardExhaustion(message)).toBeNull();
    }
  });

  it("treats an already-past reset instant as unknown", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(detectHardExhaustion(`You've hit Claude's 5h usage limit. It resets at ${past}.`))
      .toEqual({ resetAt: null });
  });

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

  it("resolves a wall-clock UTC reset to the next time that clock reads it", () => {
    expect(detectHardExhaustion("You've hit your session limit · resets 9am (UTC)", NOON_UTC))
      .toEqual({ resetAt: "2026-08-07T09:00:00.000Z" });
    expect(detectHardExhaustion("You've hit your session limit · resets 12:30am (UTC)", NOON_UTC))
      .toEqual({ resetAt: "2026-08-07T00:30:00.000Z" });
    expect(detectHardExhaustion("You've hit your session limit · resets 12:30pm (UTC)", NOON_UTC))
      .toEqual({ resetAt: "2026-08-06T12:30:00.000Z" });
  });

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

  it("still matches through leading decoration", () => {
    expect(detectHardExhaustionInTurnText(`⏺ ${SESSION_LIMIT_NOTICE}`, NOON_UTC))
      .toEqual({ resetAt: "2026-08-06T17:10:00.000Z" });
  });

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

// Await a real headless subscription-exhaustion capture, preserving its channel
// and exact bytes (including apostrophes). TUI strings do not establish wire wording.
const GROK_SUBSCRIPTION_EXHAUSTION_CAPTURE: {
  channel: "error" | "text";
  text: string;
} | null = null;

// From grok 1.0.1 binary strings, 2026-08-20; not subscription-exhaustion captures.
const GROK_NON_SUBSCRIPTION_COPY = [
  "You hit your free usage limit.",
  "usage balance exhausted",
  "You can continue by increasing your spending limit.",
  "You can continue by enabling pay-as-you-go usage.",
  "You can continue by purchasing more credits.",
  "You've hit the credit limit for your plan.",
  "You've hit your spending cap.",
  "You\u2019ve hit the credit limit for your plan.",
  "You\u2019ve hit your spending cap.",
] as const;

describe("Grok exhaustion channels (planning#453)", () => {
  it("does not treat free-tier or credit-balance copy as a spent subscription", () => {
    for (const message of GROK_NON_SUBSCRIPTION_COPY) {
      expect(detectHardExhaustion(message), `error channel: ${message}`).toBeNull();
      expect(detectHardExhaustionInTurnText(message), `text channel: ${message}`).toBeNull();
    }
  });

  it("the text channel's provider prefix names Claude and Codex, not Grok", () => {
    expect(detectHardExhaustion("Grok usage limit reached")).not.toBeNull();
    expect(detectHardExhaustion("usage limit reached")).not.toBeNull();
    expect(detectHardExhaustionInTurnText("usage limit reached")).not.toBeNull();
    expect(detectHardExhaustionInTurnText("Claude usage limit reached")).not.toBeNull();
    expect(detectHardExhaustionInTurnText("Codex usage limit reached")).not.toBeNull();
    expect(detectHardExhaustionInTurnText("Grok usage limit reached")).toBeNull();
    expect(detectHardExhaustionInTurnText("Grok Build usage limit reached")).toBeNull();
  });

  it("keeps generic credit language on the error channel and off the text channel", () => {
    expect(detectHardExhaustion("out of credits")).not.toBeNull();
    expect(detectHardExhaustionInTurnText("out of credits")).toBeNull();
  });

  it("does not yet match the unverified TUI weekly-limit wording", () => {
    const tuiWeekly = "You hit your weekly limit.";
    expect(detectHardExhaustion(tuiWeekly)).toBeNull();
    expect(detectHardExhaustionInTurnText(tuiWeekly)).toBeNull();
  });

  it("does not fire on the grok adapter's synthesized fatal-error result", () => {
    expect(detectHardExhaustion("Grok exited with code 1 before producing a result")).toBeNull();
    expect(
      detectHardExhaustionInTurnText("Grok exited with code 1 before producing a result"),
    ).toBeNull();
  });

  // CLI 1.0.1 against a local recorder returning 429; no subscription was spent.
  it("matches the real captured Grok refusal on the error channel", () => {
    const fixture = path.join(
      GROK_FIXTURES,
      "rate-limited-429-grok-4.5.ndjson",
    );
    const result = fs
      .readFileSync(fixture, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { type: string; errors?: string[] })
      .find((e) => e.type === "result");
    const text = result?.errors?.[0];
    expect(text, "the fixture's errored result must carry an errors[] entry").toBeTruthy();

    expect(detectHardExhaustion(text!)).not.toBeNull();
    expect(detectHardExhaustionInTurnText(text!)).toBeNull();
  });

  it.skipIf(GROK_SUBSCRIPTION_EXHAUSTION_CAPTURE === null)(
    "recognizes a captured SuperGrok subscription notice on the channel it arrived on",
    () => {
      const capture = GROK_SUBSCRIPTION_EXHAUSTION_CAPTURE!;
      const detected =
        capture.channel === "error"
          ? detectHardExhaustion(capture.text)
          : detectHardExhaustionInTurnText(capture.text);
      expect(detected).not.toBeNull();
    },
  );
});
