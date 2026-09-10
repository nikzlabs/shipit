#!/usr/bin/env tsx
import { spawnSync } from "node:child_process";
import path from "node:path";
import { findMergeBase, isLintableSource, listChangedFiles } from "./changed-files.js";

const ROOT = path.resolve(import.meta.dirname, "..");

const MAX_INCREMENTAL_FILES = 250;

function runFullLint(): never {
  const result = spawnSync("npm", ["run", "lint"], { cwd: ROOT, stdio: "inherit" });
  process.exit(result.status ?? 1);
}

const args = process.argv.slice(2);
const listOnly = args.includes("--list");
const forceAll = args.includes("--all");

if (forceAll || findMergeBase(ROOT) === null) {
  if (!forceAll) {
    console.warn("No merge base against main found — falling back to full lint.");
  }
  runFullLint();
}

const files = listChangedFiles(ROOT, { mergeBase: findMergeBase(ROOT) }).filter(isLintableSource);

if (files.length > MAX_INCREMENTAL_FILES) {
  console.warn(`${files.length} changed files exceeds the incremental threshold (${MAX_INCREMENTAL_FILES}) — falling back to full lint.`);
  if (listOnly) process.exit(0);
  runFullLint();
}

if (files.length === 0) {
  console.log("No changed TS/TSX files under src/. Skipping lint.");
  process.exit(0);
}

if (listOnly) {
  console.log(`Would lint ${files.length} file(s):\n`);
  for (const f of files) console.log(`  ${f}`);
  process.exit(0);
}

console.log(`Linting ${files.length} changed file(s):\n`);
for (const f of files) console.log(`  ${f}`);
console.log();

const env = {
  ...process.env,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=3072`.trim(),
};

const result = spawnSync(
  "npx",
  ["eslint", "--cache", "--cache-location", "node_modules/.cache/eslint/", ...files],
  { cwd: ROOT, stdio: "inherit", env },
);
process.exit(result.status ?? 1);
