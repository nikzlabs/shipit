import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { archiveSession } from "./session.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { DatabaseManager } from "../../shared/database.js";
import { createTestDatabaseManager } from "../integration_tests/test-helpers.js";
import { initGlobalGitConfig, setGitIdentity } from "../git-config.js";
import type { SessionRunnerRegistry } from "../session-runner.js";

// Archiving deletes a repo-backed checkout because the remote can re-create it. These
// cover the commits the remote does NOT have, which the disk janitor's eviction pass
// has always refused to delete (`blocked-by-push`).

let tmpDir: string;
let dbManager: DatabaseManager;
let sessionManager: SessionManager;
let runnerRegistry: SessionRunnerRegistry;
let origGitConfigGlobal: string | undefined;

const createGitManager = (dir: string) => new GitManager(dir);

function commit(dir: string, file: string, body: string): void {
  fs.writeFileSync(path.join(dir, file), body);
  execSync(`git add -A && git commit -m "add ${file}"`, { cwd: dir, stdio: "pipe" });
}

/** Leave the checkout in an unresolved merge, which git refuses to auto-commit. */
function conflict(dir: string): void {
  execSync("git checkout -b side", { cwd: dir, stdio: "pipe" });
  fs.writeFileSync(path.join(dir, "clash.txt"), "side");
  execSync("git add -A && git commit -m side", { cwd: dir, stdio: "pipe" });
  execSync("git checkout shipit/test-branch", { cwd: dir, stdio: "pipe" });
  fs.writeFileSync(path.join(dir, "clash.txt"), "branch");
  execSync("git add -A && git commit -m branch", { cwd: dir, stdio: "pipe" });
  execSync("git merge side || true", { cwd: dir, stdio: "pipe" });
}

/** A session workspace that is a real clone of a real (bare) remote. */
function makeClonedSession(id: string, remoteDir: string): { workspaceDir: string } {
  const sessionRoot = path.join(tmpDir, id);
  const workspaceDir = path.join(sessionRoot, "workspace");
  fs.mkdirSync(sessionRoot, { recursive: true });
  execSync(`git clone ${remoteDir} workspace`, { cwd: sessionRoot, stdio: "pipe" });
  execSync("git checkout -b shipit/test-branch", { cwd: workspaceDir, stdio: "pipe" });
  sessionManager.track(id, "Archive test", workspaceDir);
  sessionManager.setRemoteUrl(id, remoteDir);
  sessionManager.setBranch(id, "shipit/test-branch");
  return { workspaceDir };
}

function makeRemote(name: string): string {
  const remoteDir = path.join(tmpDir, name);
  fs.mkdirSync(remoteDir, { recursive: true });
  execSync("git init --bare -b main", { cwd: remoteDir, stdio: "pipe" });
  // A bare repo must have one commit before it can be cloned.
  const seed = path.join(tmpDir, `${name}-seed`);
  fs.mkdirSync(seed, { recursive: true });
  execSync("git init -b main", { cwd: seed, stdio: "pipe" });
  commit(seed, "README.md", "seed");
  execSync(`git remote add origin ${remoteDir} && git push -u origin main`, { cwd: seed, stdio: "pipe" });
  return remoteDir;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-archive-unpushed-"));
  origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  initGlobalGitConfig(path.join(tmpDir, "credentials"));
  setGitIdentity("Test", "test@test.com");
  dbManager = createTestDatabaseManager();
  sessionManager = new SessionManager(dbManager);
  runnerRegistry = {
    get: () => undefined,
    dispose: vi.fn(() => undefined),
  } as unknown as SessionRunnerRegistry;
});

afterEach(() => {
  if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
  else delete process.env.GIT_CONFIG_GLOBAL;
  dbManager.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("archiveSession: commits that are on no remote", () => {
  it("pushes an unpushed branch, then removes the checkout", async () => {
    const remoteDir = makeRemote("remote-a");
    const { workspaceDir } = makeClonedSession("sess-push", remoteDir);
    commit(workspaceDir, "work.txt", "unpushed work");
    const head = execSync("git rev-parse HEAD", { cwd: workspaceDir }).toString().trim();

    const result = await archiveSession(
      sessionManager, runnerRegistry, (_url: string) => path.join(tmpDir, "cache"),
      "sess-push", undefined, undefined, undefined, createGitManager,
    );

    const onRemote = execSync("git rev-parse refs/heads/shipit/test-branch", { cwd: remoteDir })
      .toString().trim();
    expect(onRemote).toBe(head);
    expect(fs.existsSync(workspaceDir)).toBe(false);
    expect(result.checkoutsRetained).toBeUndefined();
    expect(sessionManager.get("sess-push")?.diskTier).toBe("evicted");
  });

  it("keeps the checkout when the branch cannot be pushed", async () => {
    const remoteDir = makeRemote("remote-b");
    const { workspaceDir } = makeClonedSession("sess-keep", remoteDir);
    commit(workspaceDir, "work.txt", "unpushed work");
    // The remote is gone: the push fails and these commits exist nowhere else.
    fs.rmSync(remoteDir, { recursive: true, force: true });

    const result = await archiveSession(
      sessionManager, runnerRegistry, (_url: string) => path.join(tmpDir, "cache"),
      "sess-keep", undefined, undefined, undefined, createGitManager,
    );

    expect(fs.existsSync(path.join(workspaceDir, "work.txt"))).toBe(true);
    expect(result.checkoutsRetained?.[0].sessionId).toBe("sess-keep");
    expect(result.checkoutsRetained?.[0].message).toContain("shipit/test-branch");
    // The session is still archived, and the tier says a checkout is there so the disk
    // janitor comes back and retries the push.
    expect(sessionManager.get("sess-keep")?.archived).toBe(true);
    expect(sessionManager.get("sess-keep")?.diskTier).toBe("light");
  });

  it("commits uncommitted work before pushing it", async () => {
    const remoteDir = makeRemote("remote-c");
    const { workspaceDir } = makeClonedSession("sess-dirty", remoteDir);
    fs.writeFileSync(path.join(workspaceDir, "scratch.txt"), "never committed");

    await archiveSession(
      sessionManager, runnerRegistry, (_url: string) => path.join(tmpDir, "cache"),
      "sess-dirty", undefined, undefined, undefined, createGitManager,
    );

    const files = execSync("git ls-tree -r --name-only refs/heads/shipit/test-branch", { cwd: remoteDir })
      .toString();
    expect(files).toContain("scratch.txt");
    expect(fs.existsSync(workspaceDir)).toBe(false);
  });

  it("removes the checkout when the tip is already on origin, without reaching the remote", async () => {
    const remoteDir = makeRemote("remote-d");
    const { workspaceDir } = makeClonedSession("sess-synced", remoteDir);
    commit(workspaceDir, "work.txt", "pushed work");
    execSync("git push -u origin shipit/test-branch", { cwd: workspaceDir, stdio: "pipe" });
    // The tracking ref answers the question; an unreachable remote must not block.
    fs.rmSync(remoteDir, { recursive: true, force: true });

    const result = await archiveSession(
      sessionManager, runnerRegistry, (_url: string) => path.join(tmpDir, "cache"),
      "sess-synced", undefined, undefined, undefined, createGitManager,
    );

    expect(fs.existsSync(workspaceDir)).toBe(false);
    expect(result.checkoutsRetained).toBeUndefined();
  });

  it("still removes an Ops session's checkout — archiving is the only way it is reclaimed", async () => {
    const remoteDir = makeRemote("remote-e");
    const { workspaceDir } = makeClonedSession("sess-ops", remoteDir);
    sessionManager.setKind("sess-ops", "ops");
    commit(workspaceDir, "work.txt", "unpushed work");
    fs.rmSync(remoteDir, { recursive: true, force: true });

    const result = await archiveSession(
      sessionManager, runnerRegistry, (_url: string) => path.join(tmpDir, "cache"),
      "sess-ops", undefined, undefined, undefined, createGitManager,
    );

    expect(fs.existsSync(workspaceDir)).toBe(false);
    expect(result.checkoutsRetained).toBeUndefined();
  });

  it("keeps a checkout whose tree git refuses to commit, even when the remote is reachable", async () => {
    // An unresolved merge is not just uncommittable edits: MERGE_HEAD names the other
    // side, whose commits are routinely local-only. Pushing the current branch saves
    // none of them, so the checkout cannot be deleted on the strength of that push.
    const remoteDir = makeRemote("remote-g");
    const { workspaceDir } = makeClonedSession("sess-conflicted", remoteDir);
    conflict(workspaceDir);
    const sideCommit = execSync("git rev-parse side", { cwd: workspaceDir }).toString().trim();

    const result = await archiveSession(
      sessionManager, runnerRegistry, (_url: string) => path.join(tmpDir, "cache"),
      "sess-conflicted", undefined, undefined, undefined, createGitManager,
    );

    expect(result.checkoutsRetained?.[0].sessionId).toBe("sess-conflicted");
    // The side of the merge that exists nowhere else is still reachable.
    const stillHere = execSync(`git cat-file -e ${sideCommit} && echo yes`, { cwd: workspaceDir })
      .toString().trim();
    expect(stillHere).toBe("yes");
    expect(sessionManager.get("sess-conflicted")?.diskTier).toBe("light");
  });

  it("keeps a checkout it cannot even read — 'cannot tell' is not permission to delete", async () => {
    // A workspace path that stats with an error rather than an absence. The point is the
    // error, not this particular errno: an unreadable workspace says nothing about what
    // is inside it.
    const unreadable = path.join(tmpDir, "x".repeat(400));
    sessionManager.track("sess-unreadable", "Unreadable", unreadable);
    sessionManager.setRemoteUrl("sess-unreadable", path.join(tmpDir, "nowhere.git"));

    const result = await archiveSession(
      sessionManager, runnerRegistry, (_url: string) => path.join(tmpDir, "cache"),
      "sess-unreadable", undefined, undefined, undefined, createGitManager,
    );

    expect(result.checkoutsRetained?.[0].sessionId).toBe("sess-unreadable");
    expect(sessionManager.get("sess-unreadable")?.diskTier).toBe("light");
  });

  it("reports a CHILD's retained checkout to the caller that archived the parent", async () => {
    const parentRemote = makeRemote("remote-parent");
    makeClonedSession("sess-parent", parentRemote);
    const childRemote = makeRemote("remote-child");
    const { workspaceDir: childWs } = makeClonedSession("sess-child", childRemote);
    sessionManager.setParentSession("sess-child", "sess-parent");
    commit(childWs, "work.txt", "unpushed work");
    fs.rmSync(childRemote, { recursive: true, force: true });

    const result = await archiveSession(
      sessionManager, runnerRegistry, (_url: string) => path.join(tmpDir, "cache"),
      "sess-parent", undefined, undefined, undefined, createGitManager,
    );

    expect(result.checkoutsRetained?.map((r) => r.sessionId)).toEqual(["sess-child"]);
    expect(fs.existsSync(path.join(childWs, "work.txt"))).toBe(true);
  });

  it("archives an already-evicted session whose workspace is gone", async () => {
    const remoteDir = makeRemote("remote-f");
    const { workspaceDir } = makeClonedSession("sess-evicted", remoteDir);
    fs.rmSync(workspaceDir, { recursive: true, force: true });

    const result = await archiveSession(
      sessionManager, runnerRegistry, (_url: string) => path.join(tmpDir, "cache"),
      "sess-evicted", undefined, undefined, undefined, createGitManager,
    );

    expect(result.checkoutsRetained).toBeUndefined();
    expect(sessionManager.get("sess-evicted")?.diskTier).toBe("evicted");
  });
});
