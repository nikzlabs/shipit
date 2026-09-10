import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { GitManager } from "./git.js";
import { initGlobalGitConfig, setGitIdentity } from "../orchestrator/git-config.js";

async function setupRepoWithRemote(tmpDir: string) {
  const bareDir = path.join(tmpDir, "bare.git");
  const workDir = path.join(tmpDir, "work");
  fs.mkdirSync(bareDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });

  execSync("git init --bare -b main", { cwd: bareDir, stdio: "pipe" });

  execSync(`git clone ${bareDir} .`, { cwd: workDir, stdio: "pipe" });

  fs.writeFileSync(path.join(workDir, "initial.txt"), "initial content\n");
  execSync("git add -A && git commit -m 'Initial commit'", { cwd: workDir, stdio: "pipe" });
  execSync("git push", { cwd: workDir, stdio: "pipe" });

  const git = new GitManager(workDir);
  return { bareDir, workDir, git };
}

async function createDivergence(bareDir: string, workDir: string) {
  execSync("git checkout -b feature-branch", { cwd: workDir, stdio: "pipe" });

  fs.writeFileSync(path.join(workDir, "feature.txt"), "feature content\n");
  execSync("git add -A && git commit -m 'Feature commit'", { cwd: workDir, stdio: "pipe" });
  execSync("git push -u origin feature-branch", { cwd: workDir, stdio: "pipe" });

  const tempClone = path.join(path.dirname(workDir), "temp-clone");
  fs.mkdirSync(tempClone, { recursive: true });
  execSync(`git clone ${bareDir} .`, { cwd: tempClone, stdio: "pipe" });
  execSync("git checkout main", { cwd: tempClone, stdio: "pipe" });
  fs.writeFileSync(path.join(tempClone, "upstream.txt"), "upstream content\n");
  execSync("git add -A && git commit -m 'Upstream commit'", { cwd: tempClone, stdio: "pipe" });
  execSync("git push", { cwd: tempClone, stdio: "pipe" });
  fs.rmSync(tempClone, { recursive: true, force: true });

  execSync("git fetch origin", { cwd: workDir, stdio: "pipe" });

  return "feature-branch";
}

describe("GitManager: rebase operations", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;
  let origGitEditor: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-rebase-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    origGitEditor = process.env.GIT_EDITOR;
    initGlobalGitConfig(path.join(tmpDir, "credentials"));
    setGitIdentity("Test User", "test@test.com");
    process.env.GIT_EDITOR = "true";
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    if (origGitEditor !== undefined) process.env.GIT_EDITOR = origGitEditor;
    else delete process.env.GIT_EDITOR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("isAncestor returns true when ref is an ancestor", async () => {
    const { git, workDir } = await setupRepoWithRemote(tmpDir);
    const firstHash = execSync("git rev-parse HEAD", { cwd: workDir, encoding: "utf-8" }).trim();

    fs.writeFileSync(path.join(workDir, "second.txt"), "second\n");
    execSync("git add -A && git commit -m 'Second commit'", { cwd: workDir, stdio: "pipe" });

    expect(await git.isAncestor(firstHash, "HEAD")).toBe(true);
  });

  it("isAncestor returns false when ref is not an ancestor", async () => {
    const { git, workDir, bareDir } = await setupRepoWithRemote(tmpDir);

    execSync("git checkout -b diverged-branch", { cwd: workDir, stdio: "pipe" });
    fs.writeFileSync(path.join(workDir, "diverged.txt"), "diverged\n");
    execSync("git add -A && git commit -m 'Diverged commit'", { cwd: workDir, stdio: "pipe" });

    const tempClone = path.join(tmpDir, "temp-ancestor");
    fs.mkdirSync(tempClone, { recursive: true });
    execSync(`git clone ${bareDir} .`, { cwd: tempClone, stdio: "pipe" });
    fs.writeFileSync(path.join(tempClone, "main-only.txt"), "main only\n");
    execSync("git add -A && git commit -m 'Main only commit'", { cwd: tempClone, stdio: "pipe" });
    execSync("git push", { cwd: tempClone, stdio: "pipe" });
    fs.rmSync(tempClone, { recursive: true, force: true });

    execSync("git fetch origin", { cwd: workDir, stdio: "pipe" });

    const originMainHash = execSync("git rev-parse origin/main", { cwd: workDir, encoding: "utf-8" }).trim();
    const headHash = execSync("git rev-parse HEAD", { cwd: workDir, encoding: "utf-8" }).trim();
    expect(originMainHash).not.toBe(headHash);

    expect(await git.isAncestor(originMainHash, "HEAD")).toBe(false);
  });

  it("clean rebase onto updated base — no conflicts", async () => {
    const { git, workDir, bareDir } = await setupRepoWithRemote(tmpDir);
    await createDivergence(bareDir, workDir);

    const result = await git.rebase("origin/main");
    expect(result.status).toBe("clean");

    const log = execSync("git log --oneline", { cwd: workDir, encoding: "utf-8" });
    expect(log).toContain("Feature commit");
    expect(log).toContain("Upstream commit");

    expect(fs.existsSync(path.join(workDir, "feature.txt"))).toBe(true);
    expect(fs.existsSync(path.join(workDir, "upstream.txt"))).toBe(true);
  });

  it("rebase with conflicts returns conflict file list with markers", async () => {
    const { git, workDir, bareDir } = await setupRepoWithRemote(tmpDir);

    execSync("git checkout -b feature-branch", { cwd: workDir, stdio: "pipe" });

    fs.writeFileSync(path.join(workDir, "initial.txt"), "feature version\n");
    execSync("git add -A && git commit -m 'Feature change'", { cwd: workDir, stdio: "pipe" });

    const tempClone = path.join(tmpDir, "temp-clone2");
    fs.mkdirSync(tempClone, { recursive: true });
    execSync(`git clone ${bareDir} .`, { cwd: tempClone, stdio: "pipe" });
    fs.writeFileSync(path.join(tempClone, "initial.txt"), "upstream version\n");
    execSync("git add -A && git commit -m 'Upstream change'", { cwd: tempClone, stdio: "pipe" });
    execSync("git push", { cwd: tempClone, stdio: "pipe" });
    fs.rmSync(tempClone, { recursive: true, force: true });

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

  it("rebase continue after resolution completes cleanly", async () => {
    const { git, workDir, bareDir } = await setupRepoWithRemote(tmpDir);

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

    const result = await git.rebase("origin/main");
    expect(result.status).toBe("conflicts");

    fs.writeFileSync(path.join(workDir, "initial.txt"), "resolved version\n");
    await git.stageAll();

    const continueResult = await git.rebaseContinue();
    expect(continueResult.status).toBe("clean");

    const content = fs.readFileSync(path.join(workDir, "initial.txt"), "utf-8");
    expect(content).toBe("resolved version\n");
  });

  it("rebase abort restores pre-rebase state", async () => {
    const { git, workDir, bareDir } = await setupRepoWithRemote(tmpDir);

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

    const result = await git.rebase("origin/main");
    expect(result.status).toBe("conflicts");

    await git.rebaseAbort();

    const currentHash = execSync("git rev-parse HEAD", { cwd: workDir, encoding: "utf-8" }).trim();
    expect(currentHash).toBe(preRebaseHash);

    const content = fs.readFileSync(path.join(workDir, "initial.txt"), "utf-8");
    expect(content).toBe("feature version\n");
  });

  it("isRebaseInProgress returns true during rebase", async () => {
    const { git, workDir, bareDir } = await setupRepoWithRemote(tmpDir);

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

  it("force push with lease succeeds after rebase", async () => {
    const { git, workDir, bareDir } = await setupRepoWithRemote(tmpDir);
    await createDivergence(bareDir, workDir);

    const result = await git.rebase("origin/main");
    expect(result.status).toBe("clean");

    const msg = await git.forcePush();
    expect(msg).toContain("Force pushed to origin/");
  });

  it("fetch updates remote tracking branches", async () => {
    const { git, workDir, bareDir } = await setupRepoWithRemote(tmpDir);

    const tempClone = path.join(tmpDir, "temp-clone6");
    fs.mkdirSync(tempClone, { recursive: true });
    execSync(`git clone ${bareDir} .`, { cwd: tempClone, stdio: "pipe" });
    fs.writeFileSync(path.join(tempClone, "new.txt"), "new content\n");
    execSync("git add -A && git commit -m 'New commit'", { cwd: tempClone, stdio: "pipe" });
    execSync("git push", { cwd: tempClone, stdio: "pipe" });
    fs.rmSync(tempClone, { recursive: true, force: true });

    const beforeFetch = execSync("git rev-parse origin/main", { cwd: workDir, encoding: "utf-8" }).trim();

    await git.fetch();

    const afterFetch = execSync("git rev-parse origin/main", { cwd: workDir, encoding: "utf-8" }).trim();
    expect(afterFetch).not.toBe(beforeFetch);
  });
});
