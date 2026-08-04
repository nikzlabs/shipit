import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findMergeBase, isLintableSource, listChangedFiles, listUntrackedFiles } from "./changed-files.js";

/**
 * Regression coverage for the dev-loop file selection.
 *
 * The defect these guard against: `lint-dev` / `test-dev` built their file
 * lists exclusively from `git diff`, which reports only *tracked* files. Since
 * ShipIt auto-commits only after a turn ends, every file an agent creates is
 * untracked while the agent runs the checks — so both scripts reported clean
 * on files they had never looked at, and CI caught it a round-trip later.
 *
 * These run against real temp repos rather than mocked git output: the whole
 * bug was a wrong assumption about what git reports, which a mock would have
 * faithfully reproduced.
 */
let repo: string;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8" }).trim();
}

function write(relPath: string, contents = "export const x = 1;\n"): void {
  const abs = path.join(repo, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "changed-files-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  write("src/base.ts");
  git("add", "-A");
  git("commit", "-qm", "base");
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("listUntrackedFiles", () => {
  it("reports files that were never git added", () => {
    write("src/server/orchestrator/brand-new.ts");
    expect(listUntrackedFiles(repo)).toEqual(["src/server/orchestrator/brand-new.ts"]);
  });

  it("honors .gitignore so build output and deps stay out", () => {
    write(".gitignore", "node_modules/\ndist/\n");
    write("node_modules/pkg/index.ts");
    write("dist/bundle.ts");
    write("src/kept.ts");
    expect(listUntrackedFiles(repo)).toEqual([".gitignore", "src/kept.ts"]);
  });

  it("returns nothing when the tree is clean", () => {
    expect(listUntrackedFiles(repo)).toEqual([]);
  });
});

describe("listChangedFiles", () => {
  it("includes untracked files alongside unstaged and staged changes", () => {
    fs.appendFileSync(path.join(repo, "src/base.ts"), "// edited\n");
    write("src/staged.ts");
    git("add", "src/staged.ts");
    write("src/untracked.ts");

    expect(listChangedFiles(repo).sort()).toEqual(["src/base.ts", "src/staged.ts", "src/untracked.ts"]);
  });

  it("picks up a new source file and its co-located test — the CI-round-trip case", () => {
    write("src/server/orchestrator/feature.ts");
    write("src/server/orchestrator/feature.test.ts");

    const lintable = listChangedFiles(repo, { mergeBase: findMergeBase(repo) }).filter(isLintableSource);
    expect(lintable.sort()).toEqual([
      "src/server/orchestrator/feature.test.ts",
      "src/server/orchestrator/feature.ts",
    ]);
  });

  it("includes committed branch work when given a merge base", () => {
    git("checkout", "-qb", "feature");
    write("src/committed.ts");
    git("add", "-A");
    git("commit", "-qm", "work");
    write("src/also-untracked.ts");

    const base = findMergeBase(repo);
    expect(base).not.toBeNull();
    expect(listChangedFiles(repo, { mergeBase: base }).sort()).toEqual([
      "src/also-untracked.ts",
      "src/committed.ts",
    ]);
  });

  it("omits committed branch work when no merge base is given", () => {
    git("checkout", "-qb", "feature");
    write("src/committed.ts");
    git("add", "-A");
    git("commit", "-qm", "work");

    expect(listChangedFiles(repo)).toEqual([]);
  });

  it("omits a deleted file so ESLint is never handed a missing path", () => {
    // `git diff --name-only` reports deletions, and a nonexistent path makes
    // ESLint fail the entire run ("No files matching the pattern") rather than
    // skip that one file — so deleting a component broke `npm run lint:dev`
    // wholesale until the path was filtered out here.
    fs.rmSync(path.join(repo, "src/base.ts"));
    write("src/replacement.ts");

    expect(listChangedFiles(repo)).toEqual(["src/replacement.ts"]);
  });

  it("omits a file deleted in a committed branch commit", () => {
    git("checkout", "-qb", "feature");
    git("rm", "-q", "src/base.ts");
    git("commit", "-qm", "remove base");

    expect(listChangedFiles(repo, { mergeBase: findMergeBase(repo) })).toEqual([]);
  });

  it("de-duplicates a file that is both staged and edited again", () => {
    write("src/twice.ts");
    git("add", "src/twice.ts");
    fs.appendFileSync(path.join(repo, "src/twice.ts"), "// more\n");

    expect(listChangedFiles(repo)).toEqual(["src/twice.ts"]);
  });
});

describe("findMergeBase", () => {
  it("returns null outside a repo with a main branch", () => {
    const orphan = fs.mkdtempSync(path.join(os.tmpdir(), "no-main-"));
    execFileSync("git", ["init", "-q", "-b", "other"], { cwd: orphan });
    expect(findMergeBase(orphan)).toBeNull();
    fs.rmSync(orphan, { recursive: true, force: true });
  });
});

describe("isLintableSource", () => {
  it("keeps src TS/TSX and drops everything else", () => {
    expect(isLintableSource("src/client/App.tsx")).toBe(true);
    expect(isLintableSource("src/server/x.ts")).toBe(true);
    expect(isLintableSource("scripts/lint-dev.ts")).toBe(false);
    expect(isLintableSource("src/client/styles.css")).toBe(false);
    expect(isLintableSource("docs/240-x/plan.md")).toBe(false);
  });
});
