/**
 * Restoring replaces the checkout with a fresh clone on a new branch. That is right
 * when everything is on the remote, and it destroys the session's work when it is not
 * — which is precisely the state archiving keeps a checkout for. So a checkout holding
 * commits that reached no remote is restored where it stands.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { unarchiveSession } from "./session.js";
import { GitManager } from "../../shared/git.js";
import { RepoGit } from "../repo-git.js";
import { SessionManager } from "../sessions.js";
import { DatabaseManager } from "../../shared/database.js";
import { createTestDatabaseManager, StubGitHubAuthManager } from "../integration_tests/test-helpers.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { RepoStore } from "../repo-store.js";

let tmpDir: string;
let remoteDir: string;
let workspaceDir: string;
let dbManager: DatabaseManager;
let sessionManager: SessionManager;

const githubAuthManager = new StubGitHubAuthManager() as unknown as GitHubAuthManager;
const repoStore = { add() {}, setReady() {} } as unknown as RepoStore;
const createRepoGit = (dir: string): RepoGit => new RepoGit(dir);
const createGitManager = (dir: string) => new GitManager(dir);

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-restore-in-place-"));
  const seed = path.join(tmpDir, "seed");
  fs.mkdirSync(seed, { recursive: true });
  execSync("git init -b main", { cwd: seed, stdio: "ignore" });
  execSync("git config user.email test@example.com && git config user.name Test", { cwd: seed, stdio: "ignore" });
  fs.writeFileSync(path.join(seed, "README.md"), "seed");
  execSync("git add -A && git commit -m init --no-gpg-sign", { cwd: seed, stdio: "ignore" });
  remoteDir = path.join(tmpDir, "remote.git");
  execSync(`git clone --bare ${seed} ${remoteDir}`, { stdio: "ignore" });

  workspaceDir = path.join(tmpDir, "session", "workspace");
  fs.mkdirSync(path.dirname(workspaceDir), { recursive: true });
  execSync(`git clone ${remoteDir} workspace`, { cwd: path.dirname(workspaceDir), stdio: "ignore" });
  execSync("git config user.email test@example.com && git config user.name Test", { cwd: workspaceDir, stdio: "ignore" });
  execSync("git checkout -b shipit/kept", { cwd: workspaceDir, stdio: "ignore" });

  dbManager = createTestDatabaseManager();
  sessionManager = new SessionManager(dbManager);
});

afterEach(() => {
  dbManager.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("unarchiveSession with a checkout that is on no remote", () => {
  it("restores onto the existing checkout instead of replacing it", async () => {
    fs.writeFileSync(path.join(workspaceDir, "work.txt"), "only here");
    execSync("git add -A && git commit -m local --no-gpg-sign", { cwd: workspaceDir, stdio: "ignore" });
    const kept = execSync("git rev-parse HEAD", { cwd: workspaceDir }).toString().trim();
    // The remote is unreachable, so the rescue push cannot succeed.
    fs.rmSync(remoteDir, { recursive: true, force: true });

    const id = "sess-keep";
    sessionManager.track(id, "Kept", workspaceDir);
    sessionManager.setRemoteUrl(id, remoteDir);
    sessionManager.setBranch(id, "shipit/kept");
    sessionManager.archive(id, { keepCheckout: true });

    const { session } = await unarchiveSession(
      sessionManager, createRepoGit, () => path.join(tmpDir, "cache"),
      githubAuthManager, repoStore, id, undefined, createGitManager,
    );

    expect(session.diskTier).toBe("hot");
    expect(session.archived).toBeFalsy();
    // The session opens exactly as it was left: same branch, same commits, same files.
    expect(fs.existsSync(path.join(workspaceDir, "work.txt"))).toBe(true);
    expect(session.branch).toBe("shipit/kept");
    const head = execSync("git rev-parse HEAD", { cwd: workspaceDir }).toString().trim();
    expect(head).toBe(kept);
  });

  it("restores in place over an unresolved merge, which is one reason a checkout is kept", async () => {
    fs.writeFileSync(path.join(workspaceDir, "clash.txt"), "branch");
    execSync("git add -A && git commit -m branch --no-gpg-sign", { cwd: workspaceDir, stdio: "ignore" });
    const kept = execSync("git rev-parse HEAD", { cwd: workspaceDir }).toString().trim();
    execSync("git checkout -b side HEAD~1", { cwd: workspaceDir, stdio: "ignore" });
    fs.writeFileSync(path.join(workspaceDir, "clash.txt"), "side");
    execSync("git add -A && git commit -m side --no-gpg-sign", { cwd: workspaceDir, stdio: "ignore" });
    execSync("git checkout shipit/kept", { cwd: workspaceDir, stdio: "ignore" });
    execSync("git merge side || true", { cwd: workspaceDir, stdio: "pipe" });
    fs.rmSync(remoteDir, { recursive: true, force: true });

    const id = "sess-conflicted";
    sessionManager.track(id, "Conflicted", workspaceDir);
    sessionManager.setRemoteUrl(id, remoteDir);
    sessionManager.setBranch(id, "shipit/kept");
    sessionManager.archive(id, { keepCheckout: true });

    const mergeHead = execSync("git rev-parse MERGE_HEAD", { cwd: workspaceDir }).toString().trim();

    const { session } = await unarchiveSession(
      sessionManager, createRepoGit, () => path.join(tmpDir, "cache"),
      githubAuthManager, repoStore, id, undefined, createGitManager,
    );

    // The merge is still a merge: `git checkout -b` would have cleared MERGE_HEAD,
    // leaving conflicted files that can no longer be aborted or completed as one.
    expect(execSync("git rev-parse MERGE_HEAD", { cwd: workspaceDir }).toString().trim())
      .toBe(mergeHead);
    expect(session.branch).toBe("shipit/kept");
    expect(execSync("git rev-parse --abbrev-ref HEAD", { cwd: workspaceDir }).toString().trim())
      .toBe("shipit/kept");
    const head = execSync("git rev-parse HEAD", { cwd: workspaceDir }).toString().trim();
    expect(head).toBe(kept);
    expect(fs.existsSync(path.join(workspaceDir, "clash.txt"))).toBe(true);
  });

  it("still re-clones when everything is on the remote", async () => {
    const id = "sess-fresh";
    sessionManager.track(id, "Fresh", workspaceDir);
    sessionManager.setRemoteUrl(id, remoteDir);
    sessionManager.setBranch(id, "shipit/kept");
    sessionManager.archive(id);
    fs.writeFileSync(path.join(workspaceDir, "stale.txt"), "from the old checkout");

    await unarchiveSession(
      sessionManager, createRepoGit, () => path.join(tmpDir, "cache"),
      githubAuthManager, repoStore, id, undefined, createGitManager,
    );

    expect(fs.existsSync(path.join(workspaceDir, "stale.txt"))).toBe(false);
  });
});
