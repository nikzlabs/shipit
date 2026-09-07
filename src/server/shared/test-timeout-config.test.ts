import { describe, it, expect, TestRunner } from "vitest";

/**
 * Guards the `testTimeout` raise in `vitest.config.ts`, once per Vitest
 * project, because reverting it is SILENT: Vitest 4 does not inherit the root
 * `test` block's options into `projects`, so moving `testTimeout` up one level
 * during a refactor drops every test back to the 5000ms default with no error
 * anywhere — only a full suite that starts failing a different file each run
 * on a loaded host. That is the exact trap this asserts against, and it is
 * asserted per project because each project carries its own copy of the key.
 *
 * Scope, precisely: this reads the deadline Vitest resolved for a running
 * test, so it fails if the key is misplaced, dropped, or set too low to
 * matter. It is NOT a claim that the suite is reliable under load — tests
 * impose their own shorter deadlines (`waitFor` helpers, Testing Library's
 * per-call default) that this neither sees nor changes.
 *
 * The bound is the measured cold cost rather than the configured number: a
 * file that does `vi.resetModules()` + `await import(...)` in the test body
 * pays the whole transitive module graph in its first test, measured at 15.6s
 * under load. Leaving it as a range keeps a deliberate retune of the number
 * from having to touch three test files.
 */
describe("vitest testTimeout — server project", () => {
  it("resolves well above the 5000ms default rather than silently falling back to it", () => {
    expect(TestRunner.getCurrentTest()?.timeout).toBeGreaterThanOrEqual(20_000);
  });
});
