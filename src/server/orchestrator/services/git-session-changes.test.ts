import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { GitManager } from "../../shared/git.js";
import { initGlobalGitConfig, setGitIdentity } from "../git-config.js";
import { getSessionChangedPaths } from "./git.js";

/**
 * `getSessionChangedPaths` is the authoritative "what did the agent touch this
 * session" signal that replaced the unreliable file-mtime heuristic. It is the
 * committed merge-base diff vs the base branch — the SAME set the PR card's
 * notable-files strip uses, so the Docs panel and the card show exactly the
 * same documents. Uncommitted working-tree edits are intentionally NOT included
 * (they aren't in the PR; the per-turn auto-commit closes the gap). A
 * `git checkout` that merely rewrites mtimes must NOT show up.
 */
describe("getSessionChangedPaths", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-session-changes-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(path.join(tmpDir, "credentials"));
    setGitIdentity("Test", "test@test.com");
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function makeRepoWithBranch(): Promise<{ work: string; git: GitManager }> {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-work-"));
    execSync("git init -b main", { cwd: work, stdio: "pipe" });
    fs.writeFileSync(path.join(work, "base.md"), "base\n");
    execSync("git add -A && git commit -m base", { cwd: work, stdio: "pipe" });
    // Branch off main, the way a session does.
    execSync("git checkout -b session-branch", { cwd: work, stdio: "pipe" });
    return { work, git: new GitManager(work) };
  }

  it("includes files committed on the branch since it diverged from main", async () => {
    const { work, git } = await makeRepoWithBranch();
    try {
      fs.writeFileSync(path.join(work, "feature.md"), "feature\n");
      execSync("git add -A && git commit -m feature", { cwd: work, stdio: "pipe" });

      const changed = await getSessionChangedPaths(git);
      expect(changed.has("feature.md")).toBe(true);
      // A file that only existed before the branch point is not "changed".
      expect(changed.has("base.md")).toBe(false);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  it("excludes uncommitted working-tree edits (committed PR scope only)", async () => {
    const { work, git } = await makeRepoWithBranch();
    try {
      // An uncommitted edit isn't in the PR yet, so it must NOT be flagged —
      // this keeps the Docs panel in lockstep with the PR card's strip. The
      // per-turn auto-commit then makes it appear in both at once.
      fs.writeFileSync(path.join(work, "scratch.md"), "scratch\n");
      const changed = await getSessionChangedPaths(git);
      expect(changed.has("scratch.md")).toBe(false);

      // Once committed, it shows up.
      execSync("git add -A && git commit -m scratch", { cwd: work, stdio: "pipe" });
      const afterCommit = await getSessionChangedPaths(git);
      expect(afterCommit.has("scratch.md")).toBe(true);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  it("does not flag a file merely re-checked-out (mtime bumped, content unchanged)", async () => {
    const { work, git } = await makeRepoWithBranch();
    try {
      // Rewriting base.md's mtime via a no-op checkout must not flag it — this
      // is exactly the false positive the old mtime heuristic produced.
      execSync("git checkout HEAD -- base.md", { cwd: work, stdio: "pipe" });
      const changed = await getSessionChangedPaths(git);
      expect(changed.has("base.md")).toBe(false);
      expect(changed.size).toBe(0);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  it("returns an empty set when the base branch cannot be resolved", async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-nobase-"));
    try {
      execSync("git init -b feature-only", { cwd: work, stdio: "pipe" });
      fs.writeFileSync(path.join(work, "a.md"), "a\n");
      execSync("git add -A && git commit -m a", { cwd: work, stdio: "pipe" });
      const git = new GitManager(work);
      const changed = await getSessionChangedPaths(git);
      // No main/master ref → the committed change set can't be scoped, so we
      // degrade to flagging nothing rather than everything.
      expect(changed.size).toBe(0);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
});
