import { describe, it, expect } from "vitest";
import { atApiRatesFor, costFromRates, resolveTurnCost, selectionOf, turnAttributionFor } from "./turn-attribution.js";
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
      modelId: "deepseek-flash",
    });
    expect(attr?.serviceId).toBe("deepseek");
    expect(attr?.billingMode).toBe("key");
    expect(attr?.rates.input).toBeGreaterThan(0);
  });

  it("is absent — a `legacy` row — when the triple names no catalogue row", () => {
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
    expect(
      costFromRates(RATES, { tokens: { input: 1_000_000, output: 500_000, cacheRead: 2_000_000 } }),
    ).toBeCloseTo(22, 10);
  });

  it("treats an absent class as zero rather than as missing data", () => {
    expect(costFromRates(RATES, { tokens: {} })).toBe(0);
  });

  it("ignores requests and context size for a model with one flat rate", () => {
    expect(
      costFromRates(RATES, {
        tokens: { input: 1_000_000 },
        requests: [{ input: 500_000_000 }],
        contextTokens: 900_000,
      }),
    ).toBeCloseTo(10, 10);
  });
});

describe("costFromRates — a long-prompt tier (docs/329-tiered-model-pricing)", () => {
  // Every rate 5x above 100K, the shape Haiku 5.5 publishes.
  const TIERED = {
    input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25,
    longPrompt: { aboveTokens: 100_000, input: 5, output: 10, cacheRead: 0.5, cacheWrite: 6.25 },
  };

  it("prices each listed request at the tier its own prompt selects (req 4)", () => {
    const usd = costFromRates(TIERED, {
      tokens: { input: 50_000 + 150_000, output: 1_000 + 2_000 },
      requests: [
        { input: 50_000, output: 1_000 },
        { input: 150_000, output: 2_000 },
      ],
    });
    expect(usd).toBeCloseTo((50_000 * 1 + 1_000 * 2 + 150_000 * 5 + 2_000 * 10) / 1e6, 12);
  });

  it("counts cache reads and writes in a request's prompt size", () => {
    const usd = costFromRates(TIERED, {
      tokens: { input: 10, cacheRead: 90_000, cacheWrite: 10_000 },
      requests: [{ input: 10, cacheRead: 90_000, cacheWrite: 10_000 }],
    });
    expect(usd).toBeCloseTo((10 * 5 + 90_000 * 0.5 + 10_000 * 6.25) / 1e6, 12);
  });

  it("keeps a prompt of exactly the limit on the lower tier", () => {
    const usd = costFromRates(TIERED, { tokens: { input: 100_000 }, requests: [{ input: 100_000 }] });
    expect(usd).toBeCloseTo(0.1, 12);
  });

  it("prices what the list leaves out at the tier the last request's prompt selects", () => {
    // Claude's shape: prompt fields per request, output only in the totals.
    const usd = costFromRates(TIERED, {
      tokens: { input: 200_000, output: 3_000 },
      requests: [{ input: 60_000 }, { input: 140_000 }],
      contextTokens: 140_000,
    });
    expect(usd).toBeCloseTo((60_000 * 1 + 140_000 * 5 + 3_000 * 10) / 1e6, 12);
  });

  it("prices a turn with no list wholly at the tier its context size selects", () => {
    expect(costFromRates(TIERED, { tokens: { input: 120_000, output: 1_000 }, contextTokens: 120_000 }))
      .toBeCloseTo((120_000 * 5 + 1_000 * 10) / 1e6, 12);
    expect(costFromRates(TIERED, { tokens: { input: 120_000, output: 1_000 }, contextTokens: 40_000 }))
      .toBeCloseTo((120_000 * 1 + 1_000 * 2) / 1e6, 12);
  });

  it("falls back to the lower tier when neither a list nor a context size is known", () => {
    expect(costFromRates(TIERED, { tokens: { input: 300_000 } })).toBeCloseTo(0.3, 12);
  });

  it("never prices a negative remainder when a list exceeds the totals", () => {
    const usd = costFromRates(TIERED, {
      tokens: { input: 1_000 },
      requests: [{ input: 2_000 }],
      contextTokens: 200_000,
    });
    expect(usd).toBeCloseTo(2_000 / 1e6, 12);
  });
});

describe("atApiRatesFor", () => {
  it("prices a subscription row and nothing else", () => {
    const usage = { tokens: { input: 1_000_000 } };
    expect(atApiRatesFor(attribution({ billingMode: "sub" }), usage)).toBeCloseTo(10, 10);
    expect(atApiRatesFor(attribution({ billingMode: "key" }), usage)).toBeUndefined();
    expect(atApiRatesFor(undefined, usage)).toBeUndefined();
  });

  it("prices Haiku 5.5's long prompts from the catalogue at 5x (req 3)", () => {
    const haiku = turnAttributionFor({ serviceId: "anthropic", billingMode: "sub", modelId: "claude-haiku-5-5" });
    const short = atApiRatesFor(haiku, { tokens: { input: 100_000 }, requests: [{ input: 100_000 }] });
    const long = atApiRatesFor(haiku, { tokens: { input: 100_001 }, requests: [{ input: 100_001 }] });
    expect(short).toBeCloseTo(0.01, 12);
    expect(long).toBeCloseTo(100_001 * 0.5 / 1e6, 12);
  });
});

describe("resolveTurnCost — the column has ONE meaning: money that left the account", () => {
  it("a subscription turn costs zero, whatever the harness reported", () => {
    const resolved = resolveTurnCost({
      harnessId: "claude",
      attribution: attribution({ serviceId: "anthropic", billingMode: "sub" }),
      reportedCostUsd: 4.2,
      usage: { tokens: { input: 1_000_000 } },
    });
    expect(resolved).toEqual({ costUsd: 0, costSource: "per-turn" });
  });

  it("a metered turn on the harness's OWN vendor keeps the harness's figure, still cumulative", () => {
    const resolved = resolveTurnCost({
      harnessId: "claude",
      attribution: attribution({ serviceId: "anthropic", billingMode: "key" }),
      reportedCostUsd: 4.2,
      usage: { tokens: { input: 1_000_000 } },
    });
    expect(resolved).toEqual({ costUsd: 4.2, costSource: "cumulative" });
  });

  it("a metered turn on the harness's own vendor that reported NOTHING is priced from the rates", () => {
    const resolved = resolveTurnCost({
      harnessId: "codex",
      attribution: attribution({ serviceId: "openai", billingMode: "key" }),
      reportedCostUsd: undefined,
      usage: { tokens: { input: 1_000_000 } },
    });
    expect(resolved).toEqual({ costUsd: 10, costSource: "per-turn" });
  });

  it("prices a metered turn's long prompts with its requests and context size", () => {
    const resolved = resolveTurnCost({
      harnessId: "opencode",
      attribution: turnAttributionFor({ serviceId: "anthropic", billingMode: "key", modelId: "claude-haiku-5-5" }),
      reportedCostUsd: undefined,
      usage: { tokens: { input: 150_000, output: 1_000 }, requests: [{ input: 150_000, output: 1_000 }] },
    });
    expect(resolved.costUsd).toBeCloseTo((150_000 * 0.5 + 1_000 * 2.5) / 1e6, 12);
  });

  it("a redirected metered turn ignores the harness's figure and uses the rates", () => {
    const resolved = resolveTurnCost({
      harnessId: "claude",
      attribution: attribution({ serviceId: "deepseek", billingMode: "key" }),
      reportedCostUsd: 4.2,
      usage: { tokens: { input: 1_000_000, output: 1_000_000 } },
    });
    expect(resolved).toEqual({ costUsd: 30, costSource: "per-turn" });
  });

  it("with no attribution it reproduces today's behaviour exactly", () => {
    expect(
      resolveTurnCost({
        harnessId: "claude",
        attribution: undefined,
        reportedCostUsd: 4.2,
        usage: { tokens: { input: 1_000_000 } },
      }),
    ).toEqual({ costUsd: 4.2, costSource: "cumulative" });
    expect(
      resolveTurnCost({
        harnessId: "claude",
        attribution: undefined,
        reportedCostUsd: undefined,
        usage: { tokens: {} },
      }),
    ).toEqual({ costUsd: 0, costSource: "cumulative" });
  });

  it("a consult on a metered key that reported NOTHING is priced from the rates, not free", () => {
    expect(
      resolveTurnCost({
        harnessId: "codex",
        attribution: attribution({ serviceId: "openai", billingMode: "key" }),
        reportedCostUsd: undefined,
        reportedCostSource: "per-turn",
        usage: { tokens: { input: 1_000_000 } },
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
        usage: { tokens: {} },
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
  it("a subscription turn takes zero for the column and still carries the snapshot", () => {
    const resolved = resolveTurnCost({
      harnessId: "claude",
      attribution: turnAttributionFor({
        serviceId: "anthropic",
        billingMode: "sub",
        modelId: "claude-opus-5",
      }),
      reportedCostUsd: 7.5,
      usage: { tokens: {} },
    });
    expect(resolved.costUsd).toBe(0);
    expect(resolved.costSource).toBe("per-turn");
  });
});
