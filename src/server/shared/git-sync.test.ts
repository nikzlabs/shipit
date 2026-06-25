import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitManager } from "./git.js";
import { initGlobalGitConfig, setGitIdentity } from "../orchestrator/git-config.js";

describe("GitManager: push and pull", () => {
  let tmpDir: string;
  let bareDir: string;
  let origGitConfigGlobal: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-sync-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(path.join(tmpDir, "credentials"));
    setGitIdentity("Test", "test@test.com");
    bareDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-bare-"));
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(bareDir, { recursive: true, force: true });
  });

  it("push sends commits to a bare remote", async () => {
    // Create a bare repo to act as the remote
    const { execSync } = await import("node:child_process");
    execSync("git init --bare -b main", { cwd: bareDir });

    const git = new GitManager(tmpDir);
    await git.init();

    // Add the bare repo as remote
    await git.addRemote("origin", bareDir);

    // Create a commit to push
    fs.writeFileSync(path.join(tmpDir, "pushed.txt"), "hello");
    await git.autoCommit("Push test");

    const branch = await git.getCurrentBranch();
    const result = await git.push("origin", branch);
    expect(result).toContain("Pushed to origin/");
  });

  it("pull fetches commits from a bare remote", async () => {
    const { execSync } = await import("node:child_process");
    execSync("git init --bare -b main", { cwd: bareDir });

    // Clone into two working copies (use separate dirs, not tmpDir which has git config files)
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-work-"));
    const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-clone-"));
    try {
      execSync(`git clone ${bareDir} .`, { cwd: workDir, stdio: "pipe" });
      execSync(`git clone ${bareDir} .`, { cwd: cloneDir, stdio: "pipe" });

      // Create a commit in the clone and push
      fs.writeFileSync(path.join(cloneDir, "from-clone.txt"), "from clone");
      execSync("git add -A && git commit -m 'From clone'", { cwd: cloneDir, stdio: "pipe" });
      execSync("git push", { cwd: cloneDir, stdio: "pipe" });

      // Pull in the original
      const git = new GitManager(workDir);
      const branch = await git.getCurrentBranch();
      const result = await git.pull("origin", branch);
      expect(result).toContain("Pulled from origin/");
      expect(fs.existsSync(path.join(workDir, "from-clone.txt"))).toBe(true);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(cloneDir, { recursive: true, force: true });
    }
  });
});

describe("GitManager: forceUpdateBranchRef + getRefHash (docs/221)", () => {
  let origGitConfigGlobal: string | undefined;
  let credDir: string;

  beforeEach(() => {
    credDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-ff-cred-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(path.join(credDir, "credentials"));
    setGitIdentity("Test", "test@test.com");
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(credDir, { recursive: true, force: true });
  });

  it("force-moves a non-current branch to another ref WITHOUT switching HEAD", async () => {
    const { execSync } = await import("node:child_process");
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-ff-"));
    try {
      execSync("git init -b main", { cwd: work, stdio: "pipe" });
      fs.writeFileSync(path.join(work, "a.txt"), "c1\n");
      execSync("git add -A && git commit -m c1", { cwd: work, stdio: "pipe" });
      // A second branch one commit ahead of main.
      execSync("git checkout -b feature", { cwd: work, stdio: "pipe" });
      fs.writeFileSync(path.join(work, "a.txt"), "c2\n");
      execSync("git add -A && git commit -m c2", { cwd: work, stdio: "pipe" });

      const git = new GitManager(work);
      const featureSha = await git.getRefHash("feature");
      expect(await git.getRefHash("main")).not.toBe(featureSha);

      // Move main up to feature while staying ON feature.
      await git.forceUpdateBranchRef("main", "feature");

      expect(await git.getCurrentBranch()).toBe("feature"); // HEAD unchanged
      expect(await git.getRefHash("main")).toBe(featureSha); // ref moved
      // Working tree untouched — still feature's content, not a checkout of main.
      expect(fs.readFileSync(path.join(work, "a.txt"), "utf-8")).toBe("c2\n");
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  it("getRefHash returns null for a ref that doesn't resolve", async () => {
    const { execSync } = await import("node:child_process");
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-ref-"));
    try {
      execSync("git init -b main", { cwd: work, stdio: "pipe" });
      fs.writeFileSync(path.join(work, "a.txt"), "c1\n");
      execSync("git add -A && git commit -m c1", { cwd: work, stdio: "pipe" });
      const git = new GitManager(work);
      expect(await git.getRefHash("origin/main")).toBeNull();
      expect(await git.getRefHash("main")).not.toBeNull();
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
});
