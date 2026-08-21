import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { initGlobalGitConfig, setGitIdentity } from "../orchestrator/git-config.js";

/**
 * The ordering half of the 2026-08-18 LFS incident.
 *
 * Uploading the objects is only a fix if it happens BEFORE the ref that
 * references them reaches the remote — that is the whole reason git-lfs hangs
 * its upload off `pre-push` rather than `post-push`. A push that sends the ref
 * first is rejected with `GH008` and the upload afterwards is wasted work.
 *
 * `pushLfsObjects` is stubbed here (its own behaviour is covered against real
 * git in `git-lfs-push.test.ts`) so the stub can observe the *remote's* state at
 * the moment it is called. Everything else — the repo, the bare origin, the
 * push — is real.
 */
const hooks = vi.hoisted(() => ({
  /** Whether the bare remote already had the branch when the upload ran. */
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
    // Seed the remote so the force push has something to replace.
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
    // Invariant 2: the post-turn push may not gain a new way to fail. A failed
    // upload is a degraded push; a thrown one would be a lost commit.
    hooks.outcome = { status: "failed", detail: "LFS: connection refused" };

    await expect(new GitManager(workDir).push("origin", "main")).resolves.toContain("Pushed to");
    expect(remoteHasBranch("main")).toBe(true);
  });
});
