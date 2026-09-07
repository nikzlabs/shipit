import { describe, it, expect, TestRunner } from "vitest";

/**
 * The tooling half of the `testTimeout` guard — see the sibling
 * `src/server/shared/test-timeout-config.test.ts` for why reverting the raise
 * is silent, what this does and does not claim, and why the assertion is a
 * range rather than the configured number.
 *
 * No `scripts/` test has been observed to flake. It is covered anyway because
 * the three projects each hold their own copy of the key, and a guard covering
 * two of the three leaves the uncovered one silently revertible — which is the
 * entire failure mode being guarded against.
 */
describe("vitest testTimeout — tooling project", () => {
  it("resolves well above the 5000ms default rather than silently falling back to it", () => {
    expect(TestRunner.getCurrentTest()?.timeout).toBeGreaterThanOrEqual(20_000);
  });
});
