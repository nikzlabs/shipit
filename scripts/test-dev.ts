#!/usr/bin/env tsx
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { listChangedFiles, listUntrackedFiles } from "./changed-files.js";

const SMOKE_TESTS = [
  "src/server/orchestrator/integration_tests/connection.test.ts",
  "src/server/orchestrator/integration_tests/http-bootstrap.test.ts",
  "src/server/shared/git-core.test.ts",
  "src/client/components/MessageList.test.tsx",
];

const ROOT = path.resolve(import.meta.dirname, "..");

function isSourceFile(file: string): boolean {
  return /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file);
}

function coLocatedTests(file: string): string[] {
  const base = file.replace(/\.(ts|tsx)$/, "");
  return [`${base}.test.ts`, `${base}.test.tsx`];
}

function findUncoveredNewSources(): string[] {
  return listUntrackedFiles(ROOT)
    .filter(isSourceFile)
    .filter((file) => !coLocatedTests(file).some((t) => existsSync(path.resolve(ROOT, t))));
}

function getAffectedTests(changedFiles: string[]): string[] {
  const tests = new Set<string>();

  for (const file of changedFiles) {
    if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;

    const abs = path.resolve(ROOT, file);

    if (file.match(/\.test\.tsx?$/)) {
      if (existsSync(abs)) tests.add(file);
      continue;
    }

    for (const testFile of coLocatedTests(file)) {
      if (existsSync(path.resolve(ROOT, testFile))) {
        tests.add(testFile);
      }
    }

    if (file.includes("src/server/shared/") || file.includes("src/server/orchestrator/services/")) {
      for (const smoke of SMOKE_TESTS) {
        if (existsSync(path.resolve(ROOT, smoke))) tests.add(smoke);
      }
    }
  }

  return [...tests];
}

const args = process.argv.slice(2);
const smokeOnly = args.includes("--smoke");
const listOnly = args.includes("--list");

const testsToRun = new Set<string>();

const uncoveredNewSources = smokeOnly ? [] : findUncoveredNewSources();

if (!smokeOnly) {
  const changed = listChangedFiles(ROOT);
  if (changed.length > 0) {
    const affected = getAffectedTests(changed);
    for (const t of affected) testsToRun.add(t);
  }
}

for (const smoke of SMOKE_TESTS) {
  if (existsSync(path.resolve(ROOT, smoke))) {
    testsToRun.add(smoke);
  }
}

const testFiles = [...testsToRun].sort();

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

const result = spawnSync("npx", ["vitest", "run", ...testFiles], {
  cwd: ROOT,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
