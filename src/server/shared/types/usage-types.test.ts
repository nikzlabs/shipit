import { describe, it, expect } from "vitest";
import {
  EMPTY_USAGE_TOTALS,
  compareSessionsBySpend,
  sessionRunningFigure,
  usageTotalsFrom,
  type SessionUsage,
  type UsageGroup,
  type UsageTotals,
} from "./usage-types.js";

const totals = (over: Partial<UsageTotals> = {}): UsageTotals => ({ ...EMPTY_USAGE_TOTALS, ...over });

const group = (over: Partial<UsageGroup> & Pick<UsageGroup, "key" | "kind">): UsageGroup => ({
  models: [], turns: 1, tokens: 0, costUsd: 0, atApiRatesUsd: 0, ...over,
});

const session = (sessionId: string, over: Partial<UsageTotals>): SessionUsage => ({
  sessionId, totalDurationMs: 0, turnCount: 1, totals: totals(over),
});

describe("usageTotalsFrom (docs/252 req 16)", () => {
  it("never adds money to allowance, and keeps legacy out of both", () => {
    const out = usageTotalsFrom([
      group({ key: "anthropic:sub", kind: "sub", tokens: 1000, atApiRatesUsd: 5 }),
      group({ key: "deepseek:key", kind: "key", tokens: 200, costUsd: 0.4 }),
      // A legacy row's dollar figure is real money of unknown provenance. It
      // must not join either headline, or the column req 16 exists to make
      // honest gains a number nobody can account for.
      group({ key: "legacy", kind: "legacy", tokens: 90, costUsd: 12 }),
    ]);
    expect(out.meteredCostUsd).toBe(0.4);
    expect(out.atApiRatesUsd).toBe(5);
    expect(out.legacyCostUsd).toBe(12);
    expect(out.includedTokens).toBe(1000);
    expect(out.meteredTokens).toBe(200);
    expect(out.legacyTokens).toBe(90);
  });

  it("ignores a key group's at-API-rates value, which is an audit figure only", () => {
    // Every attributed row carries recomputed rates, including metered ones —
    // that is what makes a harness-reported figure auditable. Summing it into
    // the comparison column would double-count the metered half.
    const out = usageTotalsFrom([
      group({ key: "deepseek:key", kind: "key", costUsd: 0.4, atApiRatesUsd: 0.39 }),
    ]);
    expect(out.atApiRatesUsd).toBe(0);
  });
});

describe("sessionRunningFigure (docs/252 req 16)", () => {
  it("shows the at-API-rates estimate for a subscription session, not a zero", () => {
    expect(sessionRunningFigure(totals({ atApiRatesUsd: 2.1, includedTurns: 9 })))
      .toEqual({ usd: 2.1, kind: "at-api-rates" });
  });

  it("shows money when money moved, with the estimate left to the popover", () => {
    expect(sessionRunningFigure(totals({ meteredCostUsd: 0.42, atApiRatesUsd: 6.9 })))
      .toEqual({ usd: 0.42, kind: "metered" });
  });

  it("keeps a pre-feature session's total visible rather than dropping it to nothing", () => {
    expect(sessionRunningFigure(totals({ legacyCostUsd: 5 })))
      .toEqual({ usd: 5, kind: "earlier" });
  });

  it("says nothing at all when there is nothing to say", () => {
    expect(sessionRunningFigure(totals())).toBeNull();
  });
});

describe("compareSessionsBySpend (docs/252 req 16)", () => {
  it("ranks by money, then by the estimate, then by tokens", () => {
    // The tiebreak is the point: under the split most sessions are legitimately
    // $0, so spend alone leaves the tail in insertion order.
    const ranked = [
      session("quiet", { includedTokens: 10 }),
      session("busy-plan", { atApiRatesUsd: 9, includedTokens: 900 }),
      session("paid", { meteredCostUsd: 0.01 }),
      session("mid-plan", { atApiRatesUsd: 2, includedTokens: 200 }),
    ].sort(compareSessionsBySpend);
    expect(ranked.map((s) => s.sessionId)).toEqual(["paid", "busy-plan", "mid-plan", "quiet"]);
  });

  it("is total, so a list of equals does not reshuffle between renders", () => {
    const a = session("a", {});
    const b = session("b", {});
    expect(compareSessionsBySpend(a, b)).toBeLessThan(0);
    expect(compareSessionsBySpend(b, a)).toBeGreaterThan(0);
  });

  it("counts a pre-feature total as money for ranking", () => {
    const ranked = [session("plan", { atApiRatesUsd: 50 }), session("old", { legacyCostUsd: 1 })]
      .sort(compareSessionsBySpend);
    expect(ranked.map((s) => s.sessionId)).toEqual(["old", "plan"]);
  });
});
