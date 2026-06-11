import { describe, it, expect } from "vitest";
import { getModelBilling } from "./model-billing.js";

describe("getModelBilling", () => {
  it("returns no billing metadata for subscription-covered models", () => {
    expect(getModelBilling("claude-opus-4-8")).toBeUndefined();
    expect(getModelBilling("sonnet")).toBeUndefined();
    expect(getModelBilling("haiku")).toBeUndefined();
    expect(getModelBilling("gpt-5.5")).toBeUndefined();
  });

  it("shows the included-until pill for Fable 5 during the promo window", () => {
    const billing = getModelBilling("claude-fable-5", new Date("2026-06-11T00:00:00Z"));
    expect(billing?.tone).toBe("included");
    expect(billing?.badge).toBe("Free until Jun 22");
    expect(billing?.tooltip).toContain("through June 22, 2026");
  });

  it("still included on the last day of the window (June 22)", () => {
    const billing = getModelBilling("claude-fable-5", new Date("2026-06-22T23:59:59Z"));
    expect(billing?.tone).toBe("included");
  });

  it("flips to a metered warning pill once the window closes (June 23+)", () => {
    const billing = getModelBilling("claude-fable-5", new Date("2026-06-23T00:00:00Z"));
    expect(billing?.tone).toBe("metered");
    expect(billing?.badge).toBe("Metered");
    expect(billing?.tooltip).toContain("Not included in your subscription");
  });
});
