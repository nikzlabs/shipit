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

/**
 * The exact text the Claude CLI emitted in the incident this coverage exists
 * for (session 174b5d98, 2026-08-06 17:09 UTC) — verbatim, including the
 * middle dot, because the failure was that none of the patterns matched it.
 */
const SESSION_LIMIT_NOTICE = "You've hit your session limit · resets 5:10pm (UTC)";
const NOON_UTC = Date.parse("2026-08-06T12:00:00.000Z");

/**
 * The grok adapter's captured-stream fixtures. Reached from here on purpose:
 * the adapter half and the matcher half of planning#453 are one fix, and
 * asserting the matcher against the *same bytes* the adapter replays is what
 * keeps them from drifting apart.
 */
const GROK_FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../session/agents/grok/__fixtures__",
);

/** docs/252 req 10 — quota belongs to a service's SUBSCRIPTION, not to a harness. */
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

/** docs/150 — two connected accounts for one provider. */
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

/**
 * An instant before every `resetAt` these cases use, passed explicitly. The
 * reclassification now asks whether a window still describes NOW (docs/260
 * req 8), so a fixed fixture date that quietly slid into the past would make
 * these cases assert the opposite of what they were written for.
 */
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

  // docs/260-turn-level-account-routing req 8 — a snapshot is only refreshed by a turn on that account or
  // by the refresh button, so a 100% reading can outlive its window by hours.
  // Rewriting a real monthly-limit refusal from one would tell the user the
  // wrong limit AND quote a reset that has already passed (req 6).
  it("keeps the upstream text when the exhausted window has already reset", () => {
    const limits = limitsFor("claude", { usedPct: 100, resetAt: "2026-06-16T05:00:00.000Z" });
    const afterReset = Date.parse("2026-06-16T06:00:00.000Z");
    expect(normalizeAgentUsageLimitError("claude", "monthly usage limit", limits, afterReset)).toBe(
      "monthly usage limit",
    );
  });

  it("keeps the upstream text when the reset time is not a parseable date", () => {
    // No usable reset means no window to attach the percentage to — and the
    // old behavior quoted the junk string straight back at the user.
    const limits = limitsFor("claude", { usedPct: 100, resetAt: "not-a-date" });
    expect(normalizeAgentUsageLimitError("claude", "monthly usage limit", limits, BEFORE_RESET)).toBe(
      "monthly usage limit",
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

/**
 * docs/150-multiple-provider-subscriptions req 7 — recognizing that a failed turn means the *subscription* is
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
      // docs/150-multiple-provider-subscriptions req 17 (non-goal) — a model the account cannot run must NOT
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

/**
 * planning#453 — verbatim SuperGrok *subscription* exhaustion text captured
 * from a real headless turn, plus the channel it arrived on.
 *
 * `null` until one is captured. Filling this in is the one-assignment change
 * that un-skips the lock below. Do NOT paste TUI copy from `strings` on the
 * grok binary: pager wording has never been seen on the `-p` wire.
 *
 * Paste the capture byte-exact, including the apostrophe code point. The grok
 * binary stores U+2019 (`’`) in its contracted copy; `/you'?ve/i` does NOT
 * match `you’ve` (`'?` is an optional ASCII apostrophe, not a character class).
 * A widening against a curly-apostrophe capture must use `['’]?` (or normalize
 * first) — an ASCII-only rewrite of a U+2019 original locks a string the CLI
 * never emits.
 *
 * `channel: "error"` = `agent_result.error` (unanchored {@link detectHardExhaustion}).
 * `channel: "text"`  = final assistant text (anchored {@link detectHardExhaustionInTurnText}).
 *
 * **The channel is now settled, so expect `"error"`.** Probed 2026-08-23
 * against CLI 1.0.1 at a local recorder (docs/274 plan.md, "What the CLI does
 * to the service's words"): a refused Grok turn ends `is_error: true` with no
 * assistant text at all, so `turnSummary` is empty and the anchored text
 * matcher is never reached. A capture arriving as `"text"` would itself be the
 * finding.
 *
 * **And the transport was the real blocker, not this fixture.** The reason no
 * capture existed is not only that no plan was spent — it is that until
 * planning#453's fix the adapter discarded the text on the way past
 * (`errors[]` was unread; see `session/agents/grok/stream.ts`). Whatever xAI
 * says now reaches this matcher verbatim, and the recorder probe showed the
 * CLI adds nothing to a JSON body beyond joining `code`/`type` to the message
 * with `": "`.
 */
const GROK_SUBSCRIPTION_EXHAUSTION_CAPTURE: {
  channel: "error" | "text";
  text: string;
} | null = null;

/**
 * Binary-sourced copy from grok 1.0.1 (`@xai-official/grok-linux-x64`).
 * Provenance is `strings` on the installed binary, 2026-08-20 — NOT a
 * captured headless emission. Classified from neighbouring literals in
 * `xai-grok-pager` (TUI) and `xai-grok-shell` (compaction / API-error
 * matching). A future widening of either matcher that starts firing on
 * these is a false positive: they are a free tier, a credit balance, or
 * a pay-as-you-go CTA, not a spent SuperGrok subscription.
 */
const GROK_NON_SUBSCRIPTION_COPY = [
  // Tagged `free-usage-upsell` in the pager, next to "Unlock all features
  // with SuperGrok." — the free-tier wall, not a subscription.
  "You hit your free usage limit.",
  // Compaction/API-error matching in the shell. Credit-balance language.
  "usage balance exhausted",
  // Pager CTA for a spending cap, not a spent plan.
  "You can continue by increasing your spending limit.",
  "You can continue by enabling pay-as-you-go usage.",
  "You can continue by purchasing more credits.",
  // Pager copy for credits / PAYG. The binary stores these with U+2019
  // (`’`); `/you'?ve/i` matches neither encoding, because "credit" /
  // "spending cap" are not window words. Both spellings stay here so a
  // future `['’]?` widening still refuses them.
  "You've hit the credit limit for your plan.",
  "You've hit your spending cap.",
  "You\u2019ve hit the credit limit for your plan.",
  "You\u2019ve hit your spending cap.",
] as const;

/**
 * planning#453 — Grok has no quota reader, so these two matchers are the
 * *only* spent-plan signal. The gap is that we have never seen a SuperGrok
 * subscription emit a limit notice on the headless wire, so the patterns
 * stay as they are. What we can pin from the code and from the binary:
 *
 *   - which matcher applies to which channel
 *   - that the text channel's provider prefix is Claude/Codex, not Grok
 *   - that free-tier and credit-balance copy must not fire either detector
 *   - a skip that becomes the lock the moment a real capture fills
 *     {@link GROK_SUBSCRIPTION_EXHAUSTION_CAPTURE}
 */
describe("Grok exhaustion channels (planning#453)", () => {
  it("does not treat free-tier or credit-balance copy as a spent subscription", () => {
    for (const message of GROK_NON_SUBSCRIPTION_COPY) {
      expect(detectHardExhaustion(message), `error channel: ${message}`).toBeNull();
      expect(detectHardExhaustionInTurnText(message), `text channel: ${message}`).toBeNull();
    }
  });

  // Item 3 of planning#453, answered from the code: the error channel is
  // unanchored `EXHAUSTION_PATTERNS`; the text channel is anchored
  // `TURN_TEXT_NOTICE_PATTERNS` and is only asked when there is no error.
  // A provider prefix on the text channel is Claude's and Codex's own
  // notice grammar — `grok` is not in it. Bare `usage limit reached` still
  // matches both (the prefix is optional; the error pattern is a substring).
  // Current behaviour, expected to move if a capture arrives as
  // "Grok usage limit reached" on the text channel — not an invariant.
  it("the text channel's provider prefix names Claude and Codex, not Grok", () => {
    expect(detectHardExhaustion("Grok usage limit reached")).not.toBeNull();
    expect(detectHardExhaustion("usage limit reached")).not.toBeNull();
    expect(detectHardExhaustionInTurnText("usage limit reached")).not.toBeNull();
    expect(detectHardExhaustionInTurnText("Claude usage limit reached")).not.toBeNull();
    expect(detectHardExhaustionInTurnText("Codex usage limit reached")).not.toBeNull();
    expect(detectHardExhaustionInTurnText("Grok usage limit reached")).toBeNull();
    expect(detectHardExhaustionInTurnText("Grok Build usage limit reached")).toBeNull();
  });

  // `out of credits` is already in EXHAUSTION_PATTERNS (API-error language).
  // The text channel deliberately drops it: that is how an API reports a
  // spent *balance*, and admitting it is how "The Vercel deploy failed
  // because your account is out of credits" benches a healthy subscription.
  it("keeps generic credit language on the error channel and off the text channel", () => {
    expect(detectHardExhaustion("out of credits")).not.toBeNull();
    expect(detectHardExhaustionInTurnText("out of credits")).toBeNull();
  });

  // TUI pager copy that *looks* like SuperGrok weekly-limit wording. It
  // currently matches neither channel (`you'?ve` requires the contraction;
  // `weekly usage limit` requires the word `usage`). Left unmatched on
  // purpose: it has never been seen on the headless wire, and loosening
  // `you've` to `you hit` is exactly how the free-tier string above would
  // start to look tempting. When a capture fills the fixture, this case
  // moves — it is not a negative we are committed to.
  it("does not yet match the unverified TUI weekly-limit wording", () => {
    const tuiWeekly = "You hit your weekly limit.";
    expect(detectHardExhaustion(tuiWeekly)).toBeNull();
    expect(detectHardExhaustionInTurnText(tuiWeekly)).toBeNull();
  });

  // The grok adapter's last-resort wording, for a turn that died saying
  // nothing at all. It must stay unmatched — it describes a dead process, not
  // a spent plan. (It is no longer what a *refused* turn reports: the adapter
  // now forwards the provider's own text from `errors[]` and from a fatal
  // event's `message`. The case below is the other half of that.)
  it("does not fire on the grok adapter's synthesized fatal-error result", () => {
    expect(detectHardExhaustion("Grok exited with code 1 before producing a result")).toBeNull();
    expect(
      detectHardExhaustionInTurnText("Grok exited with code 1 before producing a result"),
    ).toBeNull();
  });

  /**
   * planning#453 — the two halves joined, against a real capture.
   *
   * The text is read out of the grok adapter's own vendored fixture rather
   * than retyped, so the pair cannot drift: if the adapter's capture changes,
   * this asserts the matcher against whatever it changed to. The fixture is
   * CLI 1.0.1 driven at a local HTTP recorder answering 429 (no plan spent) —
   * see `session/agents/grok/adapter.test.ts` for its provenance.
   *
   * What it locks is the finding, not a new pattern: `EXHAUSTION_PATTERNS`
   * already covered this wording. The list was never the binding constraint —
   * the adapter was dropping the text before the classifier could see it.
   */
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
    // And NOT on the text channel: generic credit language is dropped there on
    // purpose, and a Grok refusal never reaches it anyway (the turn ends with
    // no assistant text). Both facts, one assertion.
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
