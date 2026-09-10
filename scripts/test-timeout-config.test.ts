import { describe, it, expect, TestRunner } from "vitest";

describe("vitest testTimeout — tooling project", () => {
  it("resolves well above the 5000ms default rather than silently falling back to it", () => {
    expect(TestRunner.getCurrentTest()?.timeout).toBeGreaterThanOrEqual(20_000);
  });
});
