/**
 * Custom Vitest reporter optimized for LLM consumption.
 *
 * Design goals:
 * - Minimal output for passing tests (single summary line)
 * - Concise failure details: test name, error message, and source context
 * - Clear summary line for quick pass/fail determination
 * - No ANSI color codes, no progress bars, no durations for passing tests
 */
import type { TestModule, TestCase, TestRunEndReason } from "vitest/reporters";
import type { SerializedError, TestError } from "@vitest/utils";
import { readFileSync } from "node:fs";

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

/** Read source lines around a failure location, returning formatted context. */
function getCodeContext(
  filePath: string,
  line: number,
  column: number,
  contextLines = 3,
): string | null {
  try {
    const source = readFileSync(filePath, "utf-8");
    const lines = source.split("\n");
    const start = Math.max(0, line - 1 - contextLines);
    const end = Math.min(lines.length, line + contextLines);
    const gutterWidth = String(end).length;
    const result: string[] = [];
    for (let i = start; i < end; i++) {
      const lineNum = String(i + 1).padStart(gutterWidth);
      const marker = i === line - 1 ? ">" : " ";
      result.push(`    ${marker} ${lineNum} | ${lines[i]}`);
      // Add column indicator on the failure line
      if (i === line - 1 && column > 0) {
        const padding = " ".repeat(gutterWidth + column);
        result.push(`      ${padding}^`);
      }
    }
    return result.join("\n");
  } catch {
    return null;
  }
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
    diff = "\n    Diff:\n" + stripAnsi(error.diff);
  }

  // Extract code context from the first in-project stack frame
  let context = "";
  if (error.stacks && error.stacks.length > 0) {
    for (const frame of error.stacks) {
      // Skip node_modules frames, find the first project source frame
      if (frame.file && !frame.file.includes("node_modules")) {
        const code = getCodeContext(frame.file, frame.line, frame.column);
        if (code) {
          context = `\n    at ${frame.file.replace(/^.*?\/src\//, "src/")}:${frame.line}:${frame.column}\n${code}`;
        }
        break;
      }
    }
  }

  return truncated + diff + context;
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
        if (err.stack) {
          for (const line of err.stack.split("\n")) {
            output.push(`    ${line}`);
          }
        }
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
