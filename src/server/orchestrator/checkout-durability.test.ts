/**
 * The one rule two deletion paths share: the disk janitor's eviction pass and a
 * user-initiated archive both wipe a session's checkout, and neither may do it
 * while work exists nowhere else.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { ensureCheckoutDurable } from "./checkout-durability.js";
import { GitManager } from "../shared/git.js";
import { initGlobalGitConfig, setGitIdentity } from "./git-config.js";

let tmpDir: string;
let remoteDir: string;
let workDir: string;
let origGitConfigGlobal: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-durability-"));
  origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  initGlobalGitConfig(path.join(tmpDir, "credentials"));
  setGitIdentity("Test", "test@test.com");

  remoteDir = path.join(tmpDir, "remote.git");
  fs.mkdirSync(remoteDir);
  execSync("git init --bare -b main", { cwd: remoteDir, stdio: "pipe" });

  const seed = path.join(tmpDir, "seed");
  fs.mkdirSync(seed);
  execSync("git init -b main", { cwd: seed, stdio: "pipe" });
  fs.writeFileSync(path.join(seed, "README.md"), "seed");
  execSync("git add -A && git commit -m seed", { cwd: seed, stdio: "pipe" });
  execSync(`git remote add origin ${remoteDir} && git push -u origin main`, { cwd: seed, stdio: "pipe" });

  workDir = path.join(tmpDir, "work");
  execSync(`git clone ${remoteDir} work`, { cwd: tmpDir, stdio: "pipe" });
});

afterEach(() => {
  if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
  else delete process.env.GIT_CONFIG_GLOBAL;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("ensureCheckoutDurable", () => {
  it("is durable when the tree is clean and the tip is on origin", async () => {
    const result = await ensureCheckoutDurable(new GitManager(workDir), "test");
    expect(result.state).toBe("durable");
  });

  it("commits uncommitted work and pushes it", async () => {
    fs.writeFileSync(path.join(workDir, "new.txt"), "work");

    const result = await ensureCheckoutDurable(new GitManager(workDir), "test commit");

    expect(result.state).toBe("durable");
    const remoteFiles = execSync("git ls-tree -r --name-only refs/heads/main", { cwd: remoteDir }).toString();
    expect(remoteFiles).toContain("new.txt");
  });

  it("reports blocked-by-push when the branch cannot reach the remote", async () => {
    fs.writeFileSync(path.join(workDir, "new.txt"), "work");
    execSync("git add -A && git commit -m local", { cwd: workDir, stdio: "pipe" });
    fs.rmSync(remoteDir, { recursive: true, force: true });

    const result = await ensureCheckoutDurable(new GitManager(workDir), "test");

    expect(result).toMatchObject({ state: "blocked-by-push", cause: "push-failed" });
  });

  it("reports blocked-by-push for a detached HEAD, whose commits belong to no branch", async () => {
    execSync("git checkout --detach HEAD", { cwd: workDir, stdio: "pipe" });

    const result = await ensureCheckoutDurable(new GitManager(workDir), "test");

    expect(result).toEqual({ state: "blocked-by-push", cause: "detached-head" });
  });

  it("reports blocked-by-dirty while a conflicted merge is unresolved", async () => {
    // Two branches touching the same line, merged without resolution.
    execSync("git checkout -b side", { cwd: workDir, stdio: "pipe" });
    fs.writeFileSync(path.join(workDir, "README.md"), "side");
    execSync("git commit -am side", { cwd: workDir, stdio: "pipe" });
    execSync("git checkout main", { cwd: workDir, stdio: "pipe" });
    fs.writeFileSync(path.join(workDir, "README.md"), "main");
    execSync("git commit -am main", { cwd: workDir, stdio: "pipe" });
    execSync("git merge side || true", { cwd: workDir, stdio: "pipe", shell: "/bin/bash" });

    const result = await ensureCheckoutDurable(new GitManager(workDir), "test");

    expect(result.state).toBe("blocked-by-dirty");
  });
});
