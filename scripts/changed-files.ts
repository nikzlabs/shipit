/**
 * Shared file selection for the dev-loop scripts (`lint-dev.ts`, `test-dev.ts`).
 *
 * The load-bearing invariant: **an untracked file counts as changed.** ShipIt
 * auto-commits only *after* an agent's turn ends, so every file an agent
 * creates is untracked for the entire turn in which that agent runs
 * `npm run lint:dev` / `npm run test:dev`. A selection built purely from
 * `git diff` (which only ever reports *tracked* files) therefore reports a
 * green result for checks that ran on neither the new source file nor its
 * co-located test — the breakage surfaces later as a CI round-trip on the full
 * `npm run lint` / `npm test`.
 *
 * `git ls-files --others --exclude-standard` is the missing source:
 * `--others` lists untracked paths, `--exclude-standard` applies the normal
 * ignore rules so `node_modules/`, `dist/`, and friends stay out. Callers still
 * apply their own path/extension filters afterwards.
 *
 * The mirror-image invariant: **a deleted file does not count as changed.**
 * `git diff --name-only` reports deletions too, and handing a path that no
 * longer exists to ESLint is not a skipped file but a hard failure ("No files
 * matching the pattern …"), which takes down the whole dev-loop run over a file
 * there is nothing left to check. Extant-path filtering lives here rather than
 * in each caller because every consumer wants the same thing.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/** Run a git command in `root`, returning trimmed stdout ("" on any failure). */
export function gitOutput(root: string, cmd: string): string {
  try {
    return execSync(`git ${cmd}`, { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/**
 * Resolve the merge base against main. Prefers `origin/main` (matches CI),
 * falls back to local `main`. Returns null when neither exists.
 */
export function findMergeBase(root: string): string | null {
  for (const ref of ["origin/main", "main"]) {
    const base = gitOutput(root, `merge-base ${ref} HEAD`);
    if (base) return base;
  }
  return null;
}

/** Untracked, non-ignored files (the ones `git diff` can never report). */
export function listUntrackedFiles(root: string): string[] {
  return splitLines(gitOutput(root, "ls-files --others --exclude-standard"));
}

export interface ChangedFilesOptions {
  /**
   * When set, also include everything that differs from this commit
   * (i.e. the whole branch's diff, matching what a reviewer sees in the PR).
   * Pass null/undefined to scope to the working tree + index only.
   */
  mergeBase?: string | null;
}

/**
 * Every file that differs from a pristine checkout of the base: branch diff
 * (optional), unstaged edits, staged edits, and untracked files. De-duplicated,
 * order-stable. Paths are repo-relative, as git reports them.
 */
export function listChangedFiles(root: string, options: ChangedFilesOptions = {}): string[] {
  const sources: string[][] = [];
  if (options.mergeBase) sources.push(splitLines(gitOutput(root, `diff --name-only ${options.mergeBase}...HEAD`)));
  sources.push(splitLines(gitOutput(root, "diff --name-only")));
  sources.push(splitLines(gitOutput(root, "diff --staged --name-only")));
  sources.push(listUntrackedFiles(root));
  return [...new Set(sources.flat())].filter((file) => existsSync(path.join(root, file)));
}

/** True for files this repo's TS tooling cares about: `src/**` `.ts` / `.tsx`. */
export function isLintableSource(file: string): boolean {
  return file.startsWith("src/") && /\.(ts|tsx)$/.test(file);
}

function splitLines(output: string): string[] {
  return output.split("\n").filter(Boolean);
}
