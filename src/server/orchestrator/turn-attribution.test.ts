import { describe, it, expect } from "vitest";
import { costFromRates, resolveTurnCost, selectionOf, turnAttributionFor } from "./turn-attribution.js";
import type { TurnAttribution } from "./usage.js";

const RATES = { input: 10, output: 20, cacheRead: 1, cacheWrite: 12.5 };

function attribution(over: Partial<TurnAttribution> = {}): TurnAttribution {
  return { serviceId: "deepseek", billingMode: "key", rates: RATES, ...over };
}

describe("turnAttributionFor", () => {
  it("carries the catalogue's rates for a real row", () => {
    const attr = turnAttributionFor({
      serviceId: "deepseek",
      billingMode: "key",
      modelId: "deepseek-v4-flash",
    });
    expect(attr?.serviceId).toBe("deepseek");
    expect(attr?.billingMode).toBe("key");
    expect(attr?.rates.input).toBeGreaterThan(0);
  });

  it("is absent — a `legacy` row — when the triple names no catalogue row", () => {
    // Guessing here would produce a confidently wrong split of real money, which
    // is exactly what the legacy bucket exists to avoid.
    expect(turnAttributionFor(undefined)).toBeUndefined();
    expect(
      turnAttributionFor({ serviceId: "nope", billingMode: "key", modelId: "whatever" }),
    ).toBeUndefined();
    expect(
      turnAttributionFor({ serviceId: "anthropic", billingMode: "sub", modelId: "ghost-model" }),
    ).toBeUndefined();
  });
});

describe("costFromRates", () => {
  it("prices each token class independently, per million", () => {
    // 1M input at $10 + 0.5M output at $20 + 2M cache reads at $1 = 10 + 10 + 2.
    expect(
      costFromRates(RATES, { input: 1_000_000, output: 500_000, cacheRead: 2_000_000 }),
    ).toBeCloseTo(22, 10);
  });

  it("treats an absent class as zero rather than as missing data", () => {
    expect(costFromRates(RATES, {})).toBe(0);
  });
});

describe("resolveTurnCost — the column has ONE meaning: money that left the account", () => {
  it("a subscription turn costs zero, whatever the harness reported", () => {
    // The harness's figure on a subscription turn describes a turn where nothing
    // was billed. It is not metered spend and it is not an at-API-rates
    // valuation either — nothing establishes it is one.
    const resolved = resolveTurnCost({
      harnessId: "claude",
      attribution: attribution({ serviceId: "anthropic", billingMode: "sub" }),
      reportedCostUsd: 4.2,
      tokens: { input: 1_000_000 },
    });
    expect(resolved).toEqual({ costUsd: 0, costSource: "per-turn" });
  });

  it("a metered turn on the harness's OWN vendor keeps the harness's figure, still cumulative", () => {
    // The one cell where an existing accuracy claim holds (`usage.ts` calls its
    // delta "the true session bill"), so the design is not entitled to replace a
    // genuinely-billed number with a four-rate approximation.
    const resolved = resolveTurnCost({
      harnessId: "claude",
      attribution: attribution({ serviceId: "anthropic", billingMode: "key" }),
      reportedCostUsd: 4.2,
      tokens: { input: 1_000_000 },
    });
    expect(resolved).toEqual({ costUsd: 4.2, costSource: "cumulative" });
  });

  it("a metered turn on the harness's own vendor that reported NOTHING is priced from the rates", () => {
    // Codex declares `nativeService: "openai"` and emits no dollar figure at
    // all. Reading "reported nothing" as "cost nothing" is what made every
    // metered OpenAI turn look free — the one column req 16 exists to make
    // honest.
    const resolved = resolveTurnCost({
      harnessId: "codex",
      attribution: attribution({ serviceId: "openai", billingMode: "key" }),
      reportedCostUsd: undefined,
      tokens: { input: 1_000_000 },
    });
    expect(resolved).toEqual({ costUsd: 10, costSource: "per-turn" });
  });

  it("a redirected metered turn ignores the harness's figure and uses the rates", () => {
    // The figure comes from a CLI that was never told which vendor it is talking
    // to, so whatever it means, it is not that vendor's price.
    const resolved = resolveTurnCost({
      harnessId: "claude",
      attribution: attribution({ serviceId: "deepseek", billingMode: "key" }),
      reportedCostUsd: 4.2,
      tokens: { input: 1_000_000, output: 1_000_000 },
    });
    expect(resolved).toEqual({ costUsd: 30, costSource: "per-turn" });
  });

  it("with no attribution it reproduces today's behaviour exactly", () => {
    expect(
      resolveTurnCost({
        harnessId: "claude",
        attribution: undefined,
        reportedCostUsd: 4.2,
        tokens: { input: 1_000_000 },
      }),
    ).toEqual({ costUsd: 4.2, costSource: "cumulative" });
    expect(
      resolveTurnCost({
        harnessId: "claude",
        attribution: undefined,
        reportedCostUsd: undefined,
        tokens: {},
      }),
    ).toEqual({ costUsd: 0, costSource: "cumulative" });
  });

  it("a consult on a metered key that reported NOTHING is priced from the rates, not free", () => {
    // The sub-agent runner starts `costUsd` at 0 and only assigns on a reported
    // figure, so a caller that forwards it blindly tells this rule "the harness
    // said $0". Codex reports no dollar figure at all, so every metered OpenAI
    // consult would have been recorded as free — `services/sub-agent.ts` passes
    // `undefined` unless `costReported` is set.
    expect(
      resolveTurnCost({
        harnessId: "codex",
        attribution: attribution({ serviceId: "openai", billingMode: "key" }),
        reportedCostUsd: undefined,
        reportedCostSource: "per-turn",
        tokens: { input: 1_000_000 },
      }),
    ).toEqual({ costUsd: 10, costSource: "per-turn" });
  });

  it("a one-shot consult says its figure is per-turn rather than letting it be inferred", () => {
    expect(
      resolveTurnCost({
        harnessId: "codex",
        attribution: attribution({ serviceId: "openai", billingMode: "key" }),
        reportedCostUsd: 0.5,
        reportedCostSource: "per-turn",
        tokens: {},
      }),
    ).toEqual({ costUsd: 0.5, costSource: "per-turn" });
  });
});

describe("selectionOf", () => {
  it("needs all three elements — a partial row is not a selection", () => {
    expect(selectionOf({ model: "m", serviceId: "s", billingMode: "key" })).toEqual({
      serviceId: "s",
      billingMode: "key",
      modelId: "m",
    });
    expect(selectionOf({ model: "m", serviceId: "s" })).toBeUndefined();
    expect(selectionOf({ model: "m" })).toBeUndefined();
    expect(selectionOf(undefined)).toBeUndefined();
  });
});

describe("the delta chain across a billing-mode switch", () => {
  // Documented here rather than in `usage.test.ts` because the SHAPE of the bug
  // belongs to this rule: it exists only because `cost_usd` stopped always
  // coming from the harness's running total.
  it("a subscription turn takes zero for the column and still carries the snapshot", () => {
    const resolved = resolveTurnCost({
      harnessId: "claude",
      attribution: turnAttributionFor({
        serviceId: "anthropic",
        billingMode: "sub",
        modelId: "claude-opus-5",
      }),
      reportedCostUsd: 7.5,
      tokens: {},
    });
    // The column: nothing was billed.
    expect(resolved.costUsd).toBe(0);
    // The chain: `agent-listeners` passes the reported 7.5 as
    // `cumulativeSnapshot` regardless, so a later metered turn of the same
    // resumed conversation diffs against it instead of recording the whole
    // conversation as one turn's spend.
    expect(resolved.costSource).toBe("per-turn");
  });
});
