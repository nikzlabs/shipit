/**
 * Custom Vitest reporter optimized for LLM consumption.
 *
 * Design goals:
 * - Minimal output for passing tests (single summary line)
 * - Concise failure details (test name + error message, truncated stacks)
 * - Clear summary line for quick pass/fail determination
 * - No ANSI color codes, no progress bars, no durations for passing tests
 */
import type { TestModule, TestCase, TestRunEndReason } from "vitest/reporters";
import type { SerializedError, TestError } from "@vitest/utils";

function collectTests(
  mod: TestModule,
): { passed: number; failed: TestCase[]; skipped: number } {
  let passed = 0;
  const failed: TestCase[] = [];
  let skipped = 0;
  for (const test of mod.children.allTests()) {
    const result = test.result();
    if (result.state === "passed") {
      passed++;
    } else if (result.state === "failed") {
      failed.push(test);
    } else if (result.state === "skipped") {
      skipped++;
    }
  }
  return { passed, failed, skipped };
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "");
}

function formatError(error: TestError | SerializedError): string {
  const message = stripAnsi(error.message || "Unknown error");
  // Truncate long error messages to first 5 lines
  const lines = message.split("\n");
  const truncated =
    lines.length > 5
      ? lines.slice(0, 5).join("\n") + `\n... (${lines.length - 5} more lines)`
      : message;

  // Include diff if present (useful for assertion failures)
  let diff = "";
  if ("diff" in error && error.diff) {
    diff = "\nDiff:\n" + stripAnsi(error.diff);
  }

  return truncated + diff;
}

export default class LLMReporter {
  onTestRunEnd(
    testModules: ReadonlyArray<TestModule>,
    unhandledErrors: ReadonlyArray<SerializedError>,
    reason: TestRunEndReason,
  ): void {
    const output: string[] = [];
    let totalPassed = 0;
    let totalFailed = 0;
    let totalSkipped = 0;
    let filesPassed = 0;
    let filesFailed = 0;

    const failedModules: {
      moduleId: string;
      tests: { name: string; error: string }[];
      collectionErrors: string[];
    }[] = [];

    for (const mod of testModules) {
      const { passed, failed, skipped } = collectTests(mod);
      totalPassed += passed;
      totalFailed += failed.length;
      totalSkipped += skipped;

      const collectionErrors = mod.errors();

      if (failed.length > 0 || collectionErrors.length > 0) {
        filesFailed++;
        const failedTests = failed.map((test) => {
          const result = test.result();
          const errors =
            result.state === "failed" && result.errors
              ? result.errors.map(formatError).join("\n")
              : "Unknown error";
          return { name: test.fullName, error: errors };
        });
        failedModules.push({
          moduleId: mod.relativeModuleId,
          tests: failedTests,
          collectionErrors: collectionErrors.map((e) => e.message),
        });
      } else {
        filesPassed++;
      }
    }

    // Output failed modules with details
    if (failedModules.length > 0) {
      output.push("FAILURES:");
      output.push("");
      for (const mod of failedModules) {
        if (mod.collectionErrors.length > 0) {
          output.push(`  ${mod.moduleId} (collection error)`);
          for (const err of mod.collectionErrors) {
            output.push(`    ${err}`);
          }
        }
        for (const test of mod.tests) {
          output.push(`  FAIL ${mod.moduleId} > ${test.name}`);
          // Indent error message
          for (const line of test.error.split("\n")) {
            output.push(`    ${line}`);
          }
          output.push("");
        }
      }
    }

    // Unhandled errors
    if (unhandledErrors.length > 0) {
      output.push("UNHANDLED ERRORS:");
      for (const err of unhandledErrors) {
        output.push(`  ${err.message}`);
      }
      output.push("");
    }

    // Summary
    const status = totalFailed > 0 || reason === "failed" ? "FAIL" : "PASS";
    const parts = [`${totalPassed} passed`];
    if (totalFailed > 0) parts.push(`${totalFailed} failed`);
    if (totalSkipped > 0) parts.push(`${totalSkipped} skipped`);
    output.push(
      `${status} | Files: ${filesPassed + filesFailed} (${filesPassed} passed, ${filesFailed} failed) | Tests: ${parts.join(", ")}`,
    );

    process.stdout.write(output.join("\n") + "\n");
  }
}
