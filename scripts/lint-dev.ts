#!/usr/bin/env tsx
/**
 * Progressive lint runner for development.
 *
 * `npm run lint` (full type-aware lint over all 697 TS files) peaks at
 * ~2.85 GiB RSS and ~50 s wall time because typescript-eslint's
 * `strictTypeChecked` loads the whole TS program. This script lints only
 * files that differ from `origin/main` plus any uncommitted/staged/untracked
 * changes — the same scope a reviewer would see in the PR. ~50 s → ~8 s typical.
 *
 * Untracked files count as changed (see `changed-files.ts`): an agent's newly
 * created file is untracked for its whole turn, so leaving it out reported a
 * green lint for files that were never linted.
 *
 * Caveats vs full lint:
 * - Type-aware rules can flag *unchanged* files when their dependencies
 *   change (e.g. renaming a deprecated helper trips `no-deprecated` in
 *   callers). This script will miss those — CI still runs the full lint
 *   as the source of truth.
 * - Peak memory is only ~25% lower than a full lint (the TS program load
 *   dominates), so `--max-old-space-size` is still required to avoid OOM.
 * - Only `src/` is linted, matching `npm run lint`'s target. Changes to
 *   `scripts/`, config, or docs are not linted by either.
 * - Past MAX_INCREMENTAL_FILES changed files this defers to the full lint:
 *   the incremental path has no advantage once the TS program load dominates,
 *   and a very large untracked tree would otherwise build an unbounded argv.
 *
 * Usage:
 *   npx tsx scripts/lint-dev.ts          # lint changed files
 *   npx tsx scripts/lint-dev.ts --list   # show which files would be linted
 *   npx tsx scripts/lint-dev.ts --all    # fall through to full lint
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { findMergeBase, isLintableSource, listChangedFiles } from "./changed-files.js";

const ROOT = path.resolve(import.meta.dirname, "..");

/**
 * Above this many changed files, the per-file invocation stops paying for
 * itself (the whole-program load dominates either way) and `npm run lint`'s
 * warm cache is the better deal. Also bounds argv against a pathological
 * untracked tree.
 */
const MAX_INCREMENTAL_FILES = 250;

function runFullLint(): never {
  const result = spawnSync("npm", ["run", "lint"], { cwd: ROOT, stdio: "inherit" });
  process.exit(result.status ?? 1);
}

const args = process.argv.slice(2);
const listOnly = args.includes("--list");
const forceAll = args.includes("--all");

// No merge base means we can't scope the diff — fall through to a full lint
// rather than silently skipping files.
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
  // Keep V8 well under the 4 GiB cgroup cap so we get a clean JS heap OOM
  // (recoverable, with a stack trace) instead of SIGKILL from the cgroup.
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=3072`.trim(),
};

const result = spawnSync(
  "npx",
  ["eslint", "--cache", "--cache-location", "node_modules/.cache/eslint/", ...files],
  { cwd: ROOT, stdio: "inherit", env },
);
process.exit(result.status ?? 1);
