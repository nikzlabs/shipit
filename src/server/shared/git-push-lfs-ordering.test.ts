import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { initGlobalGitConfig, setGitIdentity } from "../orchestrator/git-config.js";
import type * as LfsPushModule from "./git-lfs-push.js";

// Stub only the upload to observe whether the real remote already has the ref.
const hooks = vi.hoisted(() => ({
  observations: [] as { remote: string; branch: string; remoteHadBranch: boolean }[],
  probeRemote: null as null | (() => boolean),
  outcome: { status: "pushed" } as { status: string; detail?: string },
}));

vi.mock("./git-lfs-push.js", async (importOriginal) => ({
  ...await importOriginal<typeof LfsPushModule>(),
  pushLfsObjects: vi.fn(async (_git: unknown, remote: string, branch: string) => {
    hooks.observations.push({ remote, branch, remoteHadBranch: hooks.probeRemote?.() ?? false });
    return hooks.outcome;
  }),
}));

const { GitManager } = await import("./git.js");
const { LfsUploadError } = await import("./git-lfs-push.js");

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

  it("does not push the ref when the upload failed", async () => {
    hooks.outcome = { status: "failed", detail: "LFS: connection refused" };

    const push = new GitManager(workDir).push("origin", "main");
    await expect(push).rejects.toBeInstanceOf(LfsUploadError);
    await expect(push).rejects.toThrow(/LFS: connection refused/);
    expect(remoteHasBranch("main")).toBe(false);
  });

  it("does not force-push the ref when the upload failed", async () => {
    run("git push origin main", workDir);
    const tip = run("git rev-parse refs/heads/main", bareDir).trim();
    fs.writeFileSync(path.join(workDir, "readme.md"), "rewritten\n");
    run("git add -A && git commit --amend -m rewritten", workDir);
    hooks.outcome = { status: "failed", detail: "LFS: connection refused" };

    await expect(new GitManager(workDir).forcePushWithLease("origin", "main", tip))
      .rejects.toBeInstanceOf(LfsUploadError);
    expect(run("git rev-parse refs/heads/main", bareDir).trim()).toBe(tip);
  });

  it("pushes the ref when the branch tracks nothing with LFS", async () => {
    hooks.outcome = { status: "not-an-lfs-repo" };

    await expect(new GitManager(workDir).push("origin", "main")).resolves.toContain("Pushed to");
    expect(remoteHasBranch("main")).toBe(true);
  });

  it("uploads for a tag before pushing it, and withholds the tag when that fails", async () => {
    const remoteHasTag = (tag: string): boolean => {
      try {
        run(`git rev-parse refs/tags/${tag}`, bareDir);
        return true;
      } catch {
        return false;
      }
    };
    hooks.probeRemote = () => remoteHasTag("v1.0.0-rc.1");

    await new GitManager(workDir).createAndPushTag("v1.0.0-rc.1", "rc");
    expect(hooks.observations).toEqual([
      { remote: "origin", branch: "v1.0.0-rc.1", remoteHadBranch: false },
    ]);
    expect(remoteHasTag("v1.0.0-rc.1")).toBe(true);

    hooks.outcome = { status: "failed", detail: "LFS: connection refused" };
    await expect(new GitManager(workDir).createAndPushTag("v1.0.0-rc.2", "rc"))
      .rejects.toBeInstanceOf(LfsUploadError);
    expect(remoteHasTag("v1.0.0-rc.2")).toBe(false);
    expect(run("git tag --list v1.0.0-rc.2", workDir).trim()).toBe("");
  });
});
