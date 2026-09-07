import { describe, it, expect, TestRunner } from "vitest";

/**
 * The client half of the `testTimeout` guard — see the sibling
 * `src/server/shared/test-timeout-config.test.ts` for why reverting the raise
 * is silent, what this does and does not claim, and why the assertion is a
 * range rather than the configured number.
 *
 * This project needs its own copy because each Vitest project carries its own
 * `testTimeout` key, so a server-side assertion cannot see a client-side
 * revert. The client is not merely symmetric here: it flaked in its own right
 * (`RolesTab.test.tsx`), where a test chaining several `user-event`
 * interactions reached ~2s in isolation at load average 94 and has the whole
 * suite's workers competing with it in a full run.
 */
describe("vitest testTimeout — client project", () => {
  it("resolves well above the 5000ms default rather than silently falling back to it", () => {
    expect(TestRunner.getCurrentTest()?.timeout).toBeGreaterThanOrEqual(20_000);
  });
});
