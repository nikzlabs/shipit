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
 * session" signal that replaced the unreliable file-mtime heuristic. These
 * tests pin its two inputs: committed changes since branch divergence from the
 * base, and uncommitted working-tree edits. A `git checkout` that merely
 * rewrites mtimes must NOT show up.
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

  it("includes uncommitted working-tree edits", async () => {
    const { work, git } = await makeRepoWithBranch();
    try {
      fs.writeFileSync(path.join(work, "scratch.md"), "scratch\n");
      const changed = await getSessionChangedPaths(git);
      expect(changed.has("scratch.md")).toBe(true);
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
      // No main/master ref → committed changes can't be scoped; only
      // uncommitted edits would appear, and there are none.
      expect(changed.size).toBe(0);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
});
