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
 * The bound is the measured cold cost, not the configured number: a file that
 * does `vi.resetModules()` + `await import(...)` in the test body pays the
 * whole transitive module graph in its first test, measured at 15.6s under
 * load. Anything at or below that is back to failing on host load rather than
 * on the code. Leaving it as a range keeps a deliberate retune of the number
 * from having to touch three test files.
 */
describe("vitest testTimeout — server project", () => {
  it("resolves well above the 5000ms default, so a loaded host cannot fail a passing test", () => {
    expect(TestRunner.getCurrentTest()?.timeout).toBeGreaterThanOrEqual(20_000);
  });
});
