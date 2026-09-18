import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { GitManager } from "../../shared/git.js";
import { initGlobalGitConfig, setGitIdentity } from "../git-config.js";
import { getSessionChangedPaths } from "./git.js";

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
    execSync("git checkout -b session-branch", { cwd: work, stdio: "pipe" });
    return { work, git: new GitManager(work) };
  }

  it("includes files committed on the branch since it diverged from main", async () => {
    const { work, git } = await makeRepoWithBranch();
    try {
      fs.writeFileSync(path.join(work, "feature.md"), "feature\n");
      execSync("git add -A && git commit -m feature", { cwd: work, stdio: "pipe" });

      const changed = await getSessionChangedPaths(git, "main");
      expect(changed.has("feature.md")).toBe(true);
      expect(changed.has("base.md")).toBe(false);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  it("excludes uncommitted working-tree edits (committed PR scope only)", async () => {
    const { work, git } = await makeRepoWithBranch();
    try {
      fs.writeFileSync(path.join(work, "scratch.md"), "scratch\n");
      const changed = await getSessionChangedPaths(git, "main");
      expect(changed.has("scratch.md")).toBe(false);

      execSync("git add -A && git commit -m scratch", { cwd: work, stdio: "pipe" });
      const afterCommit = await getSessionChangedPaths(git, "main");
      expect(afterCommit.has("scratch.md")).toBe(true);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  it("does not flag a file merely re-checked-out (mtime bumped, content unchanged)", async () => {
    const { work, git } = await makeRepoWithBranch();
    try {
      execSync("git checkout HEAD -- base.md", { cwd: work, stdio: "pipe" });
      const changed = await getSessionChangedPaths(git, "main");
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
      const changed = await getSessionChangedPaths(git, "main");
      expect(changed.size).toBe(0);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
});
