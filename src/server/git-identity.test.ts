import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitManager } from "./git.js";
import { initGlobalGitConfig, getGitIdentity, setGitIdentity } from "./git-config.js";

describe("GitManager: getCurrentBranch + global git config", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-identity-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    // Point global git config at a temp file so tests don't interfere
    initGlobalGitConfig(tmpDir);
    setGitIdentity("Test User", "test@test.com");
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) {
      process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    } else {
      delete process.env.GIT_CONFIG_GLOBAL;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---- getCurrentBranch ----

  it("returns the current branch name", async () => {
    const git = new GitManager(tmpDir);
    await git.init();

    const branch = await git.getCurrentBranch();
    // Default branch name could be "main" or "master" depending on git config
    expect(typeof branch).toBe("string");
    expect(branch.length).toBeGreaterThan(0);
  });

  // ---- global git config identity ----

  it("getGitIdentity returns the stored identity", () => {
    const identity = getGitIdentity();
    expect(identity).toEqual({ name: "Test User", email: "test@test.com" });
  });

  it("getGitIdentity returns null when no identity is set", () => {
    // Point at an empty dir with no .gitconfig
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-empty-"));
    process.env.GIT_CONFIG_GLOBAL = path.join(emptyDir, ".gitconfig");
    try {
      expect(getGitIdentity()).toBeNull();
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("autoCommit succeeds with global identity", async () => {
    const git = new GitManager(tmpDir);
    await git.init();

    fs.writeFileSync(path.join(tmpDir, "file.txt"), "content");
    const hash = await git.autoCommit("Test commit");
    expect(hash).toBeTruthy();
  });
});
