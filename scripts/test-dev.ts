#!/usr/bin/env tsx
/**
 * Progressive test runner for development.
 *
 * Instead of running all 145+ test files, this script runs:
 * 1. Tests affected by current changes (uncommitted + staged + untracked)
 * 2. A small set of smoke tests (critical-path sanity checks)
 *
 * Untracked files count as changed (see `changed-files.ts`): an agent's newly
 * created file is untracked for its whole turn, so leaving it out meant a new
 * test file never ran in the turn that wrote it.
 *
 * Usage:
 *   npx tsx scripts/test-dev.ts          # affected + smoke
 *   npx tsx scripts/test-dev.ts --smoke  # smoke tests only
 *   npx tsx scripts/test-dev.ts --list   # show which tests would run (dry run)
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { listChangedFiles, listUntrackedFiles } from "./changed-files.js";

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

function isSourceFile(file: string): boolean {
  return /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file);
}

/** Co-located test candidates for a source file (foo.ts → foo.test.ts / .tsx). */
function coLocatedTests(file: string): string[] {
  const base = file.replace(/\.(ts|tsx)$/, "");
  return [`${base}.test.ts`, `${base}.test.tsx`];
}

/**
 * New source files that no test file covers.
 *
 * A brand-new source file with no co-located test contributes nothing to the
 * affected-test set, so the run is green without having exercised it at all.
 * That's the correct *selection* (there is nothing to run), but reporting it
 * as an unqualified pass is what made the gap invisible — so we surface it and
 * let the always-on smoke tests stand as the only coverage.
 */
function findUncoveredNewSources(): string[] {
  return listUntrackedFiles(ROOT)
    .filter(isSourceFile)
    .filter((file) => !coLocatedTests(file).some((t) => existsSync(path.resolve(ROOT, t))));
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
    for (const testFile of coLocatedTests(file)) {
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

const uncoveredNewSources = smokeOnly ? [] : findUncoveredNewSources();

if (!smokeOnly) {
  const changed = listChangedFiles(ROOT);
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

/** Warn that new source files are covered by smoke tests only, not by a test of their own. */
function reportUncovered(): void {
  if (uncoveredNewSources.length === 0) return;
  console.log(`\nNote: ${uncoveredNewSources.length} new file(s) have no co-located test — only smoke tests cover them:`);
  for (const f of uncoveredNewSources) console.log(`  ${f}`);
}

if (testFiles.length === 0) {
  console.log("No test files to run.");
  reportUncovered();
  process.exit(0);
}

if (listOnly) {
  console.log(`Would run ${testFiles.length} test file(s):\n`);
  for (const f of testFiles) console.log(`  ${f}`);
  reportUncovered();
  process.exit(0);
}

console.log(`Running ${testFiles.length} test file(s) (progressive mode):\n`);
for (const f of testFiles) console.log(`  ${f}`);
reportUncovered();
console.log();

// Run vitest with the selected files
const result = spawnSync("npx", ["vitest", "run", ...testFiles], {
  cwd: ROOT,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
