import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitManager } from "./git.js";

describe("GitManager: getCurrentBranch, hasIdentity, setIdentity", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-identity-"));
  });

  afterEach(() => {
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

  // ---- hasIdentity ----

  it("returns true after init() sets identity", async () => {
    const git = new GitManager(tmpDir);
    await git.init();

    expect(await git.hasIdentity()).toBe(true);
  });

  it("returns false when repo has no identity configured", async () => {
    const { execSync } = await import("node:child_process");
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: tmpDir };
    execSync("git init", { cwd: tmpDir, env });
    execSync("git config commit.gpgsign false", { cwd: tmpDir, env });
    // Set temporary identity, commit, then unset so the repo has no persistent identity
    execSync("git config user.name tmp", { cwd: tmpDir, env });
    execSync("git config user.email tmp@tmp", { cwd: tmpDir, env });
    execSync('git commit --allow-empty -m "init"', { cwd: tmpDir, env });
    execSync("git config --unset user.name", { cwd: tmpDir, env });
    execSync("git config --unset user.email", { cwd: tmpDir, env });

    // Override process.env so simple-git child processes also ignore global config
    const origHome = process.env.HOME;
    const origNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
    process.env.HOME = tmpDir;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    try {
      const git = new GitManager(tmpDir);
      expect(await git.hasIdentity()).toBe(false);
    } finally {
      process.env.HOME = origHome;
      if (origNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
      else process.env.GIT_CONFIG_NOSYSTEM = origNoSystem;
    }
  });

  // ---- setIdentity ----

  it("configures git identity so hasIdentity returns true", async () => {
    const { execSync } = await import("node:child_process");
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: tmpDir };
    execSync("git init", { cwd: tmpDir, env });
    execSync("git config commit.gpgsign false", { cwd: tmpDir, env });
    // Set temporary identity, commit, then unset so the repo has no persistent identity
    execSync("git config user.name tmp", { cwd: tmpDir, env });
    execSync("git config user.email tmp@tmp", { cwd: tmpDir, env });
    execSync('git commit --allow-empty -m "init"', { cwd: tmpDir, env });
    execSync("git config --unset user.name", { cwd: tmpDir, env });
    execSync("git config --unset user.email", { cwd: tmpDir, env });

    // Override process.env so simple-git child processes also ignore global config
    const origHome = process.env.HOME;
    const origNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
    process.env.HOME = tmpDir;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    try {
      const git = new GitManager(tmpDir);
      expect(await git.hasIdentity()).toBe(false);

      await git.setIdentity("Test User", "test@example.com");
      expect(await git.hasIdentity()).toBe(true);
    } finally {
      process.env.HOME = origHome;
      if (origNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
      else process.env.GIT_CONFIG_NOSYSTEM = origNoSystem;
    }
  });

  it("allows autoCommit to succeed on a repo with no prior identity", async () => {
    const { execSync } = await import("node:child_process");
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: tmpDir };
    execSync("git init", { cwd: tmpDir, env });
    execSync("git config commit.gpgsign false", { cwd: tmpDir, env });
    // Set temporary identity, commit, then unset so the repo has no persistent identity
    execSync("git config user.name tmp", { cwd: tmpDir, env });
    execSync("git config user.email tmp@tmp", { cwd: tmpDir, env });
    execSync('git commit --allow-empty -m "init"', { cwd: tmpDir, env });
    execSync("git config --unset user.name", { cwd: tmpDir, env });
    execSync("git config --unset user.email", { cwd: tmpDir, env });

    const git = new GitManager(tmpDir);
    await git.setIdentity("Test User", "test@example.com");

    fs.writeFileSync(path.join(tmpDir, "file.txt"), "content");
    const hash = await git.autoCommit("Test commit");
    expect(hash).toBeTruthy();
  });
});
