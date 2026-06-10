import { describe, expect, it } from "vitest";
import { labelDotColor, labelHue } from "./issue-label-color.js";

describe("labelHue", () => {
  it("is deterministic for the same name", () => {
    expect(labelHue("bug")).toBe(labelHue("bug"));
    expect(labelHue("design")).toBe(labelHue("design"));
  });

  it("differentiates distinct names", () => {
    expect(labelHue("bug")).not.toBe(labelHue("feature"));
  });

  it("always returns a hue in [0, 360)", () => {
    for (const name of ["", "a", "infra", "needs triage", "P0", "🚀 launch"]) {
      const hue = labelHue(name);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });
});

describe("labelDotColor", () => {
  it("wraps the hue in a stable hsl() string", () => {
    expect(labelDotColor("bug")).toBe(`hsl(${labelHue("bug")} 60% 55%)`);
  });
});
