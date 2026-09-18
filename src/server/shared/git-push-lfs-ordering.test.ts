import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { initGlobalGitConfig, setGitIdentity } from "../orchestrator/git-config.js";

// Stub only the upload to observe whether the real remote already has the ref.
const hooks = vi.hoisted(() => ({
  observations: [] as { remote: string; branch: string; remoteHadBranch: boolean }[],
  probeRemote: null as null | (() => boolean),
  outcome: { status: "pushed" } as { status: string; detail?: string },
}));

vi.mock("./git-lfs-push.js", () => ({
  lfsDeclarationGrepArgs: (ref = "HEAD") => ["grep", ref],
  pushLfsObjects: vi.fn(async (_git: unknown, remote: string, branch: string) => {
    hooks.observations.push({ remote, branch, remoteHadBranch: hooks.probeRemote?.() ?? false });
    return hooks.outcome;
  }),
}));

const { GitManager } = await import("./git.js");

describe("orchestrator push paths upload LFS objects before the ref", () => {
  let root: string;
  let bareDir: string;
  let workDir: string;
  let origGitConfigGlobal: string | undefined;

  const run = (cmd: string, cwd: string): string =>
    execSync(cmd, { cwd, stdio: ["pipe", "pipe", "pipe"] }).toString();

  const remoteHasBranch = (branch: string): boolean => {
    try {
      run(`git rev-parse refs/heads/${branch}`, bareDir);
      return true;
    } catch {
      return false;
    }
  };

  beforeEach(() => {
    hooks.observations.length = 0;
    hooks.outcome = { status: "pushed" };
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-lfs-order-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(path.join(root, "credentials"));
    setGitIdentity("Test", "test@test.com");

    bareDir = path.join(root, "bare.git");
    workDir = path.join(root, "work");
    fs.mkdirSync(bareDir);
    fs.mkdirSync(workDir);
    run("git init --bare -b main", bareDir);
    run("git init -b main", workDir);
    run(`git remote add origin ${bareDir}`, workDir);
    fs.writeFileSync(path.join(workDir, "readme.md"), "hello\n");
    run("git add -A && git commit -m init", workDir);

    hooks.probeRemote = () => remoteHasBranch("main");
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("uploads for the branch the plain push is about to publish", async () => {
    await new GitManager(workDir).push("origin", "main");

    expect(hooks.observations).toEqual([
      { remote: "origin", branch: "main", remoteHadBranch: false },
    ]);
    expect(remoteHasBranch("main")).toBe(true);
  });

  it("uploads for a force push too — rewritten history can reference new objects", async () => {
    run("git push origin main", workDir);
    hooks.observations.length = 0;

    fs.writeFileSync(path.join(workDir, "readme.md"), "rewritten\n");
    run("git add -A && git commit --amend -m rewritten", workDir);

    const tip = run("git rev-parse refs/heads/main", bareDir).trim();
    await new GitManager(workDir).forcePushWithLease("origin", "main", tip);

    expect(hooks.observations).toHaveLength(1);
    expect(hooks.observations[0]).toMatchObject({ remote: "origin", branch: "main" });
    expect(run("git rev-parse refs/heads/main", bareDir).trim())
      .toBe(run("git rev-parse HEAD", workDir).trim());
  });

  it("pushes the ref even when the upload failed", async () => {
    hooks.outcome = { status: "failed", detail: "LFS: connection refused" };

    await expect(new GitManager(workDir).push("origin", "main")).resolves.toContain("Pushed to");
    expect(remoteHasBranch("main")).toBe(true);
  });
});
