#!/usr/bin/env tsx
/**
 * Progressive test runner for development.
 *
 * Instead of running all 145+ test files, this script runs:
 * 1. Tests affected by current changes (uncommitted + staged)
 * 2. A small set of smoke tests (critical-path sanity checks)
 *
 * Usage:
 *   npx tsx scripts/test-dev.ts          # affected + smoke
 *   npx tsx scripts/test-dev.ts --smoke  # smoke tests only
 *   npx tsx scripts/test-dev.ts --list   # show which tests would run (dry run)
 */
import { execSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Smoke tests — critical-path tests that always run regardless of changes.
// Keep this list small for speed. These cover core connectivity, HTTP
// bootstrap, basic git operations, and one representative client component.
// ---------------------------------------------------------------------------
const SMOKE_TESTS = [
  "src/server/orchestrator/integration_tests/connection.test.ts",
  "src/server/orchestrator/integration_tests/http-bootstrap.test.ts",
  "src/server/shared/git-core.test.ts",
  "src/client/components/MessageList.test.tsx",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const ROOT = path.resolve(import.meta.dirname, "..");

function git(cmd: string): string {
  try {
    return execSync(`git ${cmd}`, { cwd: ROOT, encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

/** Return de-duplicated list of files changed in the working tree + index. */
function getChangedFiles(): string[] {
  const unstaged = git("diff --name-only");
  const staged = git("diff --staged --name-only");
  const all = `${unstaged}\n${staged}`.split("\n").filter(Boolean);
  return [...new Set(all)];
}

/**
 * Given a list of changed source files, find test files that should run.
 *
 * Strategy:
 * - If a test file itself changed → include it directly.
 * - For source files, check for a co-located test (foo.ts → foo.test.ts).
 * - For shared modules (types, utils), include integration smoke tests
 *   since many consumers may be affected.
 */
function getAffectedTests(changedFiles: string[]): string[] {
  const tests = new Set<string>();

  for (const file of changedFiles) {
    // Skip non-TS files
    if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;

    const abs = path.resolve(ROOT, file);

    // If it's already a test file, include it directly
    if (file.match(/\.test\.tsx?$/)) {
      if (existsSync(abs)) tests.add(file);
      continue;
    }

    // Look for co-located test file (foo.ts → foo.test.ts)
    const base = file.replace(/\.(ts|tsx)$/, "");
    for (const ext of [".test.ts", ".test.tsx"]) {
      const testFile = base + ext;
      if (existsSync(path.resolve(ROOT, testFile))) {
        tests.add(testFile);
      }
    }

    // If a shared type/util changed, include integration smoke tests
    // because many modules may import from shared/
    if (file.includes("src/server/shared/") || file.includes("src/server/orchestrator/services/")) {
      for (const smoke of SMOKE_TESTS) {
        if (existsSync(path.resolve(ROOT, smoke))) tests.add(smoke);
      }
    }
  }

  return [...tests];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const smokeOnly = args.includes("--smoke");
const listOnly = args.includes("--list");

// Collect test files to run
const testsToRun = new Set<string>();

if (!smokeOnly) {
  const changed = getChangedFiles();
  if (changed.length > 0) {
    const affected = getAffectedTests(changed);
    for (const t of affected) testsToRun.add(t);
  }
}

// Always include smoke tests
for (const smoke of SMOKE_TESTS) {
  if (existsSync(path.resolve(ROOT, smoke))) {
    testsToRun.add(smoke);
  }
}

const testFiles = [...testsToRun].sort();

if (testFiles.length === 0) {
  console.log("No test files to run.");
  process.exit(0);
}

if (listOnly) {
  console.log(`Would run ${testFiles.length} test file(s):\n`);
  for (const f of testFiles) console.log(`  ${f}`);
  process.exit(0);
}

console.log(`Running ${testFiles.length} test file(s) (progressive mode):\n`);
for (const f of testFiles) console.log(`  ${f}`);
console.log();

// Run vitest with the selected files
const result = spawnSync("npx", ["vitest", "run", ...testFiles], {
  cwd: ROOT,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
