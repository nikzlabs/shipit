import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { restoreSessionWorkspace } from "./session.js";
import { ServiceError } from "./types.js";
import { RepoGit } from "../repo-git.js";
import { SessionManager } from "../sessions.js";
import { DatabaseManager } from "../../shared/database.js";
import { createTestDatabaseManager, StubGitHubAuthManager } from "../integration_tests/test-helpers.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { RepoStore } from "../repo-store.js";

let tmpDir: string;
let seedDir: string;
let remoteDir: string;
let remoteUrl: string;
let cacheDir: string;
let dbManager: DatabaseManager;
let sessionManager: SessionManager;

const githubAuthManager = new StubGitHubAuthManager() as unknown as GitHubAuthManager;
const repoStore = { add() {}, setReady() {} } as unknown as RepoStore;

function createRepoGit(dir: string): RepoGit {
  return new RepoGit(dir);
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-restore-ws-"));
  seedDir = path.join(tmpDir, "seed");
  fs.mkdirSync(seedDir, { recursive: true });
  execSync("git init -b main", { cwd: seedDir, stdio: "ignore" });
  execSync("git config user.email test@example.com", { cwd: seedDir, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: seedDir, stdio: "ignore" });
  fs.writeFileSync(path.join(seedDir, "README.md"), "# test\n");
  execSync("git add . && git commit -m init --no-gpg-sign", { cwd: seedDir, stdio: "ignore" });
  remoteDir = path.join(tmpDir, "remote.git");
  execSync(`git clone --bare ${seedDir} ${remoteDir}`, { stdio: "ignore" });
  remoteUrl = `file://${remoteDir}`;

  cacheDir = path.join(tmpDir, "cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  await createRepoGit(cacheDir).cloneBare(remoteUrl);

  dbManager = createTestDatabaseManager();
  sessionManager = new SessionManager(dbManager);
});

afterEach(() => {
  dbManager.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function pushBranch(branch: string, content: string): string {
  execSync(`git checkout -b ${branch}`, { cwd: seedDir, stdio: "ignore" });
  fs.writeFileSync(path.join(seedDir, "FEATURE.md"), content);
  execSync("git add . && git commit -m feature --no-gpg-sign", { cwd: seedDir, stdio: "ignore" });
  const head = execSync("git rev-parse HEAD", { cwd: seedDir }).toString().trim();
  execSync(`git push ${remoteUrl} ${branch}:${branch} --force`, { cwd: seedDir, stdio: "ignore" });
  execSync("git checkout main", { cwd: seedDir, stdio: "ignore" });
  return head;
}

describe("restoreSessionWorkspace (planning#181)", () => {
  it("re-clones a missing evicted workspace and checks out the COMMITTED branch", async () => {
    const branch = "shipit/feature-abc";
    const branchHead = pushBranch(branch, "# committed feature work\n");

    const id = "sess-1";
    const workspaceDir = path.join(tmpDir, "workspace");
    sessionManager.track(id, "Restore me", workspaceDir);
    sessionManager.setRemoteUrl(id, remoteUrl);
    sessionManager.setBranch(id, branch);
    dbManager.db.prepare("UPDATE sessions SET disk_tier = 'evicted' WHERE id = ?").run(id);
    expect(fs.existsSync(workspaceDir)).toBe(false);

    const restored = await restoreSessionWorkspace(
      sessionManager, createRepoGit, () => cacheDir, githubAuthManager, repoStore, id,
    );

    expect(restored).toBe(true);
    expect(fs.existsSync(path.join(workspaceDir, ".git"))).toBe(true);
    const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: workspaceDir }).toString().trim();
    expect(currentBranch).toBe(branch);
    const head = execSync("git rev-parse HEAD", { cwd: workspaceDir }).toString().trim();
    expect(head).toBe(branchHead);
    expect(fs.existsSync(path.join(workspaceDir, "FEATURE.md"))).toBe(true);
    expect(sessionManager.get(id)?.diskTier).toBe("hot");
  });

  it("recreates the branch off the default branch when it was never pushed", async () => {
    const id = "sess-2";
    const workspaceDir = path.join(tmpDir, "workspace2");
    sessionManager.track(id, "Lost branch", workspaceDir);
    sessionManager.setRemoteUrl(id, remoteUrl);
    sessionManager.setBranch(id, "shipit/never-pushed");
    dbManager.db.prepare("UPDATE sessions SET disk_tier = 'evicted' WHERE id = ?").run(id);

    const restored = await restoreSessionWorkspace(
      sessionManager, createRepoGit, () => cacheDir, githubAuthManager, repoStore, id,
    );

    expect(restored).toBe(true);
    const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: workspaceDir }).toString().trim();
    expect(currentBranch).toBe("shipit/never-pushed");
    expect(sessionManager.get(id)?.diskTier).toBe("hot");
  });

  it("is a no-op when the workspace is present and the session is not evicted", async () => {
    const id = "sess-3";
    const workspaceDir = path.join(tmpDir, "workspace3");
    await createRepoGit(cacheDir).cloneFromCache(workspaceDir, remoteUrl);
    sessionManager.track(id, "Healthy", workspaceDir);
    sessionManager.setRemoteUrl(id, remoteUrl);

    const restored = await restoreSessionWorkspace(
      sessionManager, createRepoGit, () => cacheDir, githubAuthManager, repoStore, id,
    );

    expect(restored).toBe(false);
  });

  it("flips an evicted session back to hot without re-cloning when the checkout survived", async () => {
    const id = "sess-4";
    const workspaceDir = path.join(tmpDir, "workspace4");
    await createRepoGit(cacheDir).cloneFromCache(workspaceDir, remoteUrl);
    sessionManager.track(id, "Survived eviction rm", workspaceDir);
    sessionManager.setRemoteUrl(id, remoteUrl);
    dbManager.db.prepare("UPDATE sessions SET disk_tier = 'evicted' WHERE id = ?").run(id);

    const restored = await restoreSessionWorkspace(
      sessionManager, createRepoGit, () => cacheDir, githubAuthManager, repoStore, id,
    );

    expect(restored).toBe(false);
    expect(sessionManager.get(id)?.diskTier).toBe("hot");
  });

  it("de-dupes concurrent restores onto one clone (no rm/clone race)", async () => {
    const branch = "shipit/concurrent";
    const branchHead = pushBranch(branch, "# concurrent restore\n");

    const id = "sess-concurrent";
    const workspaceDir = path.join(tmpDir, "workspace-concurrent");
    sessionManager.track(id, "Concurrent", workspaceDir);
    sessionManager.setRemoteUrl(id, remoteUrl);
    sessionManager.setBranch(id, branch);
    dbManager.db.prepare("UPDATE sessions SET disk_tier = 'evicted' WHERE id = ?").run(id);

    const [a, b] = await Promise.all([
      restoreSessionWorkspace(sessionManager, createRepoGit, () => cacheDir, githubAuthManager, repoStore, id),
      restoreSessionWorkspace(sessionManager, createRepoGit, () => cacheDir, githubAuthManager, repoStore, id),
    ]);

    expect(a).toBe(b);
    expect(fs.existsSync(path.join(workspaceDir, ".git"))).toBe(true);
    const head = execSync("git rev-parse HEAD", { cwd: workspaceDir }).toString().trim();
    expect(head).toBe(branchHead);
  });

  it("throws a terminal ServiceError when a no-remote session's workspace is gone", async () => {
    const id = "sess-5";
    const workspaceDir = path.join(tmpDir, "workspace5");
    sessionManager.track(id, "No remote", workspaceDir);

    await expect(
      restoreSessionWorkspace(
        sessionManager, createRepoGit, () => cacheDir, githubAuthManager, repoStore, id,
      ),
    ).rejects.toBeInstanceOf(ServiceError);
  });
});
