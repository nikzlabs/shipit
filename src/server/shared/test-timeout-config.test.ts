import { describe, it, expect, TestRunner } from "vitest";

// Vitest projects do not inherit the root timeout. Cold imports exceeded 15 seconds.
describe("vitest testTimeout — server project", () => {
  it("resolves well above the 5000ms default rather than silently falling back to it", () => {
    expect(TestRunner.getCurrentTest()?.timeout).toBeGreaterThanOrEqual(20_000);
  });
});
