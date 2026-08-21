import { describe, it, expect } from "vitest";
import { formatCost, formatEstimate, turnCostDisplay } from "./format-cost.js";
import type { TurnUsage } from "../../server/shared/types.js";

const turn = (over: Partial<TurnUsage>): TurnUsage => ({
  inputTokens: 100, outputTokens: 10, costUsd: 0, timestamp: "2026-08-09T00:00:00Z", ...over,
});

describe("formatCost / formatEstimate (docs/252 req 16)", () => {
  it("keeps a sub-cent figure legible instead of rounding it to zero", () => {
    expect(formatCost(0.005)).toBe("$0.005");
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(1.239)).toBe("$1.24");
  });

  it("marks an estimate with ≈ so it can never read as money spent", () => {
    expect(formatEstimate(2.1)).toBe("≈$2.10");
  });
});

describe("turnCostDisplay (docs/252 req 16)", () => {
  it("prices a subscription turn at API rates rather than reporting it as free", () => {
    // `costUsd` is zero by rule for a `sub` row. Printing it would say the turn
    // cost nothing, when what is true is that it was included.
    expect(turnCostDisplay(turn({ billingMode: "sub", atApiRatesUsd: 0.02 })))
      .toEqual({ text: "≈$0.02", estimated: true });
  });

  it("says 'included' when a subscription turn has no rates to value it with", () => {
    expect(turnCostDisplay(turn({ billingMode: "sub" })))
      .toEqual({ text: "included", estimated: false });
  });

  it("prints money for a metered turn, and for a pre-feature one", () => {
    expect(turnCostDisplay(turn({ billingMode: "key", costUsd: 0.05 })))
      .toEqual({ text: "$0.05", estimated: false });
    // A legacy row's figure is of unknown provenance but is still what the user
    // has already been shown, so it is printed unqualified.
    expect(turnCostDisplay(turn({ costUsd: 2.64 })))
      .toEqual({ text: "$2.64", estimated: false });
  });
});
