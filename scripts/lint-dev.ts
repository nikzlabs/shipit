#!/usr/bin/env tsx
/**
 * Progressive lint runner for development.
 *
 * `npm run lint` (full type-aware lint over all 697 TS files) peaks at
 * ~2.85 GiB RSS and ~50 s wall time because typescript-eslint's
 * `strictTypeChecked` loads the whole TS program. This script lints only
 * files that differ from `origin/main` plus any uncommitted/staged changes —
 * the same scope a reviewer would see in the PR. ~50 s → ~8 s typical.
 *
 * Caveats vs full lint:
 * - Type-aware rules can flag *unchanged* files when their dependencies
 *   change (e.g. renaming a deprecated helper trips `no-deprecated` in
 *   callers). This script will miss those — CI still runs the full lint
 *   as the source of truth.
 * - Peak memory is only ~25% lower than a full lint (the TS program load
 *   dominates), so `--max-old-space-size` is still required to avoid OOM.
 *
 * Usage:
 *   npx tsx scripts/lint-dev.ts          # lint changed files
 *   npx tsx scripts/lint-dev.ts --list   # show which files would be linted
 *   npx tsx scripts/lint-dev.ts --all    # fall through to full lint
 */
import { execSync, spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

function git(cmd: string): string {
  try {
    return execSync(`git ${cmd}`, { cwd: ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/**
 * Resolve the merge base against main. Prefers `origin/main` (matches CI),
 * falls back to local `main`. Returns null when neither exists, in which
 * case we fall through to a full lint — better safe than silently skipping.
 */
function findMergeBase(): string | null {
  for (const ref of ["origin/main", "main"]) {
    const base = git(`merge-base ${ref} HEAD`);
    if (base) return base;
  }
  return null;
}

function getChangedFiles(): string[] {
  const sources: string[] = [];
  const base = findMergeBase();
  if (base) sources.push(git(`diff --name-only ${base}...HEAD`));
  sources.push(git("diff --name-only"));
  sources.push(git("diff --staged --name-only"));
  const all = sources.join("\n").split("\n").filter(Boolean);
  return [...new Set(all)]
    .filter((f) => f.startsWith("src/") && /\.(ts|tsx)$/.test(f));
}

const args = process.argv.slice(2);
const listOnly = args.includes("--list");
const forceAll = args.includes("--all");

if (forceAll || findMergeBase() === null) {
  if (!forceAll) {
    console.warn("No merge base against main found — falling back to full lint.");
  }
  const result = spawnSync("npm", ["run", "lint"], { cwd: ROOT, stdio: "inherit" });
  process.exit(result.status ?? 1);
}

const files = getChangedFiles();

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
