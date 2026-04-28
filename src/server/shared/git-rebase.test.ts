import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { GitManager } from "./git.js";
import { initGlobalGitConfig, setGitIdentity } from "../orchestrator/git-config.js";

/**
 * Helper: create a bare repo and a working clone with initial commit.
 * Returns { bareDir, workDir, git }.
 */
async function setupRepoWithRemote(tmpDir: string) {
  const bareDir = path.join(tmpDir, "bare.git");
  const workDir = path.join(tmpDir, "work");
  fs.mkdirSync(bareDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });

  // Create bare repo
  execSync("git init --bare -b main", { cwd: bareDir, stdio: "pipe" });

  // Clone into working dir
  execSync(`git clone ${bareDir} .`, { cwd: workDir, stdio: "pipe" });

  // Create initial commit
  fs.writeFileSync(path.join(workDir, "initial.txt"), "initial content\n");
  execSync("git add -A && git commit -m 'Initial commit'", { cwd: workDir, stdio: "pipe" });
  execSync("git push", { cwd: workDir, stdio: "pipe" });

  const git = new GitManager(workDir);
  return { bareDir, workDir, git };
}

/**
 * Create a diverged state: base branch has new commits, feature branch has its own commits.
 * Returns the feature branch name.
 */
async function createDivergence(bareDir: string, workDir: string) {
  // Create feature branch from current state
  execSync("git checkout -b feature-branch", { cwd: workDir, stdio: "pipe" });

  // Add feature commit
  fs.writeFileSync(path.join(workDir, "feature.txt"), "feature content\n");
  execSync("git add -A && git commit -m 'Feature commit'", { cwd: workDir, stdio: "pipe" });
  execSync("git push -u origin feature-branch", { cwd: workDir, stdio: "pipe" });

  // Now simulate main moving forward by pushing directly to bare repo from a temp clone
  const tempClone = path.join(path.dirname(workDir), "temp-clone");
  fs.mkdirSync(tempClone, { recursive: true });
  execSync(`git clone ${bareDir} .`, { cwd: tempClone, stdio: "pipe" });
  execSync("git checkout main", { cwd: tempClone, stdio: "pipe" });
  fs.writeFileSync(path.join(tempClone, "upstream.txt"), "upstream content\n");
  execSync("git add -A && git commit -m 'Upstream commit'", { cwd: tempClone, stdio: "pipe" });
  execSync("git push", { cwd: tempClone, stdio: "pipe" });
  fs.rmSync(tempClone, { recursive: true, force: true });

  // Fetch in work dir so origin/main is updated
  execSync("git fetch origin", { cwd: workDir, stdio: "pipe" });

  return "feature-branch";
}

describe("GitManager: rebase operations", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-rebase-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(path.join(tmpDir, "credentials"));
    setGitIdentity("Test User", "test@test.com");
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---- isAncestor ----

  it("isAncestor returns true when ref is an ancestor", async () => {
    const { git, workDir } = await setupRepoWithRemote(tmpDir);
    const firstHash = execSync("git rev-parse HEAD", { cwd: workDir, encoding: "utf-8" }).trim();

    // Add another commit
    fs.writeFileSync(path.join(workDir, "second.txt"), "second\n");
    execSync("git add -A && git commit -m 'Second commit'", { cwd: workDir, stdio: "pipe" });

    expect(await git.isAncestor(firstHash, "HEAD")).toBe(true);
  });

  it("isAncestor returns false when ref is not an ancestor", async () => {
    const { git, workDir, bareDir } = await setupRepoWithRemote(tmpDir);

    // Create a branch, add commits, then make main diverge
    execSync("git checkout -b diverged-branch", { cwd: workDir, stdio: "pipe" });
    fs.writeFileSync(path.join(workDir, "diverged.txt"), "diverged\n");
    execSync("git add -A && git commit -m 'Diverged commit'", { cwd: workDir, stdio: "pipe" });

    // Push a different commit to main via temp clone
    const tempClone = path.join(tmpDir, "temp-ancestor");
    fs.mkdirSync(tempClone, { recursive: true });
    execSync(`git clone ${bareDir} .`, { cwd: tempClone, stdio: "pipe" });
    fs.writeFileSync(path.join(tempClone, "main-only.txt"), "main only\n");
    execSync("git add -A && git commit -m 'Main only commit'", { cwd: tempClone, stdio: "pipe" });
    execSync("git push", { cwd: tempClone, stdio: "pipe" });
    fs.rmSync(tempClone, { recursive: true, force: true });

    // Fetch to get the updated origin/main
    execSync("git fetch origin", { cwd: workDir, stdio: "pipe" });

    // origin/main now has commits that HEAD doesn't — it's NOT an ancestor of HEAD
    const originMainHash = execSync("git rev-parse origin/main", { cwd: workDir, encoding: "utf-8" }).trim();
    const headHash = execSync("git rev-parse HEAD", { cwd: workDir, encoding: "utf-8" }).trim();
    // Sanity: they should be different
    expect(originMainHash).not.toBe(headHash);

    expect(await git.isAncestor(originMainHash, "HEAD")).toBe(false);
  });

  // ---- rebase (clean) ----

  it("clean rebase onto updated base — no conflicts", async () => {
    const { git, workDir, bareDir } = await setupRepoWithRemote(tmpDir);
    await createDivergence(bareDir, workDir);

    const result = await git.rebase("origin/main");
    expect(result.status).toBe("clean");

    // Verify linear history: feature commit is now on top of upstream commit
    const log = execSync("git log --oneline", { cwd: workDir, encoding: "utf-8" });
    expect(log).toContain("Feature commit");
    expect(log).toContain("Upstream commit");

    // Verify both files exist
    expect(fs.existsSync(path.join(workDir, "feature.txt"))).toBe(true);
    expect(fs.existsSync(path.join(workDir, "upstream.txt"))).toBe(true);
  });

  // ---- rebase (conflicts) ----

  it("rebase with conflicts returns conflict file list with markers", async () => {
    const { git, workDir, bareDir } = await setupRepoWithRemote(tmpDir);

    // Create feature branch
    execSync("git checkout -b feature-branch", { cwd: workDir, stdio: "pipe" });

    // Modify the same file on feature branch
    fs.writeFileSync(path.join(workDir, "initial.txt"), "feature version\n");
    execSync("git add -A && git commit -m 'Feature change'", { cwd: workDir, stdio: "pipe" });

    // Modify the same file on main via temp clone
    const tempClone = path.join(tmpDir, "temp-clone2");
    fs.mkdirSync(tempClone, { recursive: true });
    execSync(`git clone ${bareDir} .`, { cwd: tempClone, stdio: "pipe" });
    fs.writeFileSync(path.join(tempClone, "initial.txt"), "upstream version\n");
    execSync("git add -A && git commit -m 'Upstream change'", { cwd: tempClone, stdio: "pipe" });
    execSync("git push", { cwd: tempClone, stdio: "pipe" });
    fs.rmSync(tempClone, { recursive: true, force: true });

    // Fetch upstream
    execSync("git fetch origin", { cwd: workDir, stdio: "pipe" });

    const result = await git.rebase("origin/main");
    expect(result.status).toBe("conflicts");
    if (result.status === "conflicts") {
      expect(result.conflicts.length).toBeGreaterThan(0);
      expect(result.conflicts[0].path).toBe("initial.txt");
      expect(result.conflicts[0].content).toContain("<<<<<<<");
      expect(result.conflicts[0].content).toContain(">>>>>>>");
    }
  });

  // ---- rebaseContinue ----

  it("rebase continue after resolution completes cleanly", async () => {
    const { git, workDir, bareDir } = await setupRepoWithRemote(tmpDir);

    // Create conflict scenario
    execSync("git checkout -b feature-branch", { cwd: workDir, stdio: "pipe" });
    fs.writeFileSync(path.join(workDir, "initial.txt"), "feature version\n");
    execSync("git add -A && git commit -m 'Feature change'", { cwd: workDir, stdio: "pipe" });

    const tempClone = path.join(tmpDir, "temp-clone3");
    fs.mkdirSync(tempClone, { recursive: true });
    execSync(`git clone ${bareDir} .`, { cwd: tempClone, stdio: "pipe" });
    fs.writeFileSync(path.join(tempClone, "initial.txt"), "upstream version\n");
    execSync("git add -A && git commit -m 'Upstream change'", { cwd: tempClone, stdio: "pipe" });
    execSync("git push", { cwd: tempClone, stdio: "pipe" });
    fs.rmSync(tempClone, { recursive: true, force: true });

    execSync("git fetch origin", { cwd: workDir, stdio: "pipe" });

    // Start rebase — should get conflicts
    const result = await git.rebase("origin/main");
    expect(result.status).toBe("conflicts");

    // Resolve conflict
    fs.writeFileSync(path.join(workDir, "initial.txt"), "resolved version\n");
    await git.stageAll();

    // Continue rebase
    const continueResult = await git.rebaseContinue();
    expect(continueResult.status).toBe("clean");

    // Verify resolution
    const content = fs.readFileSync(path.join(workDir, "initial.txt"), "utf-8");
    expect(content).toBe("resolved version\n");
  });

  // ---- rebaseAbort ----

  it("rebase abort restores pre-rebase state", async () => {
    const { git, workDir, bareDir } = await setupRepoWithRemote(tmpDir);

    // Create conflict scenario
    execSync("git checkout -b feature-branch", { cwd: workDir, stdio: "pipe" });
    fs.writeFileSync(path.join(workDir, "initial.txt"), "feature version\n");
    execSync("git add -A && git commit -m 'Feature change'", { cwd: workDir, stdio: "pipe" });
    const preRebaseHash = execSync("git rev-parse HEAD", { cwd: workDir, encoding: "utf-8" }).trim();

    const tempClone = path.join(tmpDir, "temp-clone4");
    fs.mkdirSync(tempClone, { recursive: true });
    execSync(`git clone ${bareDir} .`, { cwd: tempClone, stdio: "pipe" });
    fs.writeFileSync(path.join(tempClone, "initial.txt"), "upstream version\n");
    execSync("git add -A && git commit -m 'Upstream change'", { cwd: tempClone, stdio: "pipe" });
    execSync("git push", { cwd: tempClone, stdio: "pipe" });
    fs.rmSync(tempClone, { recursive: true, force: true });

    execSync("git fetch origin", { cwd: workDir, stdio: "pipe" });

    // Start rebase — conflicts
    const result = await git.rebase("origin/main");
    expect(result.status).toBe("conflicts");

    // Abort
    await git.rebaseAbort();

    // Should be back to pre-rebase state
    const currentHash = execSync("git rev-parse HEAD", { cwd: workDir, encoding: "utf-8" }).trim();
    expect(currentHash).toBe(preRebaseHash);

    // File should have feature version
    const content = fs.readFileSync(path.join(workDir, "initial.txt"), "utf-8");
    expect(content).toBe("feature version\n");
  });

  // ---- isRebaseInProgress ----

  it("isRebaseInProgress returns true during rebase", async () => {
    const { git, workDir, bareDir } = await setupRepoWithRemote(tmpDir);

    // Create conflict scenario
    execSync("git checkout -b feature-branch", { cwd: workDir, stdio: "pipe" });
    fs.writeFileSync(path.join(workDir, "initial.txt"), "feature version\n");
    execSync("git add -A && git commit -m 'Feature change'", { cwd: workDir, stdio: "pipe" });

    const tempClone = path.join(tmpDir, "temp-clone5");
    fs.mkdirSync(tempClone, { recursive: true });
    execSync(`git clone ${bareDir} .`, { cwd: tempClone, stdio: "pipe" });
    fs.writeFileSync(path.join(tempClone, "initial.txt"), "upstream version\n");
    execSync("git add -A && git commit -m 'Upstream change'", { cwd: tempClone, stdio: "pipe" });
    execSync("git push", { cwd: tempClone, stdio: "pipe" });
    fs.rmSync(tempClone, { recursive: true, force: true });

    execSync("git fetch origin", { cwd: workDir, stdio: "pipe" });

    expect(await git.isRebaseInProgress()).toBe(false);

    await git.rebase("origin/main");

    expect(await git.isRebaseInProgress()).toBe(true);

    await git.rebaseAbort();

    expect(await git.isRebaseInProgress()).toBe(false);
  });

  // ---- forcePush ----

  it("force push with lease succeeds after rebase", async () => {
    const { git, workDir, bareDir } = await setupRepoWithRemote(tmpDir);
    await createDivergence(bareDir, workDir);

    // Rebase
    const result = await git.rebase("origin/main");
    expect(result.status).toBe("clean");

    // Force push
    const msg = await git.forcePush();
    expect(msg).toContain("Force pushed to origin/");
  });

  // ---- fetch ----

  it("fetch updates remote tracking branches", async () => {
    const { git, workDir, bareDir } = await setupRepoWithRemote(tmpDir);

    // Add commit to bare via temp clone
    const tempClone = path.join(tmpDir, "temp-clone6");
    fs.mkdirSync(tempClone, { recursive: true });
    execSync(`git clone ${bareDir} .`, { cwd: tempClone, stdio: "pipe" });
    fs.writeFileSync(path.join(tempClone, "new.txt"), "new content\n");
    execSync("git add -A && git commit -m 'New commit'", { cwd: tempClone, stdio: "pipe" });
    execSync("git push", { cwd: tempClone, stdio: "pipe" });
    fs.rmSync(tempClone, { recursive: true, force: true });

    // Before fetch, origin/main is stale
    const beforeFetch = execSync("git rev-parse origin/main", { cwd: workDir, encoding: "utf-8" }).trim();

    await git.fetch();

    const afterFetch = execSync("git rev-parse origin/main", { cwd: workDir, encoding: "utf-8" }).trim();
    expect(afterFetch).not.toBe(beforeFetch);
  });
});
