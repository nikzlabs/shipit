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
      costFromRates(RATES, { input: 1_000_000, output: 500_000, cacheRead: 2_000_000 }),
    ).toBeCloseTo(22, 10);
  });

  it("treats an absent class as zero rather than as missing data", () => {
    expect(costFromRates(RATES, {})).toBe(0);
  });
});

describe("resolveTurnCost — the column has ONE meaning: money that left the account", () => {
  it("a subscription turn costs zero, whatever the harness reported", () => {
    const resolved = resolveTurnCost({
      harnessId: "claude",
      attribution: attribution({ serviceId: "anthropic", billingMode: "sub" }),
      reportedCostUsd: 4.2,
      tokens: { input: 1_000_000 },
    });
    expect(resolved).toEqual({ costUsd: 0, costSource: "per-turn" });
  });

  it("a metered turn on the harness's OWN vendor keeps the harness's figure, still cumulative", () => {
    const resolved = resolveTurnCost({
      harnessId: "claude",
      attribution: attribution({ serviceId: "anthropic", billingMode: "key" }),
      reportedCostUsd: 4.2,
      tokens: { input: 1_000_000 },
    });
    expect(resolved).toEqual({ costUsd: 4.2, costSource: "cumulative" });
  });

  it("a metered turn on the harness's own vendor that reported NOTHING is priced from the rates", () => {
    const resolved = resolveTurnCost({
      harnessId: "codex",
      attribution: attribution({ serviceId: "openai", billingMode: "key" }),
      reportedCostUsd: undefined,
      tokens: { input: 1_000_000 },
    });
    expect(resolved).toEqual({ costUsd: 10, costSource: "per-turn" });
  });

  it("a redirected metered turn ignores the harness's figure and uses the rates", () => {
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
    expect(resolved.costUsd).toBe(0);
    expect(resolved.costSource).toBe("per-turn");
  });
});
