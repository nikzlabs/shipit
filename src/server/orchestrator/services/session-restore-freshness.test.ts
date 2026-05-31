/**
 * docs/161 Part 3 — end-to-end restore freshness for an `evicted` session.
 *
 * Proves that `unarchiveSession` cuts the restored workspace from *current*
 * `origin/main`, not a frozen bare-cache snapshot: it forces a fresh
 * `fetchCache(ttlMs = 0)` before cloning and bases the new branch on the
 * freshly-fetched `origin/<defaultBranch>`. Builds on docs/157's refspec fix
 * (which lets the bare cache's HEAD actually advance on fetch) and extends the
 * guarantee from session-create to the restore path. The RepoGit mechanics are
 * unit-covered in `repo-git.test.ts`; this wires them through the full service.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { unarchiveSession } from "./session.js";
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

// unarchiveSession only touches credentials when authenticated; the default
// stub is unauthenticated, so the local file:// clone needs no git creds.
const githubAuthManager = new StubGitHubAuthManager() as unknown as GitHubAuthManager;
// recovered === false (the cache is pre-created with a HEAD), so these are never
// hit — but the signature requires a RepoStore.
const repoStore = { add() {}, setReady() {} } as unknown as RepoStore;

function createRepoGit(dir: string): RepoGit {
  return new RepoGit(dir);
}

/** Append a commit to the seed clone and push it to the bare remote's main. */
function advanceRemote(content: string): string {
  fs.writeFileSync(path.join(seedDir, "README.md"), content);
  execSync("git add . && git commit -m advance --no-gpg-sign", { cwd: seedDir, stdio: "ignore" });
  execSync(`git push ${remoteUrl} HEAD:main --force`, { cwd: seedDir, stdio: "ignore" });
  return execSync("git rev-parse HEAD", { cwd: seedDir }).toString().trim();
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-restore-fresh-"));
  // Local "remote": a real bare repo with one commit, reachable via file://.
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

  // Pre-create the bare cache via RepoGit.cloneBare (the docs/157 path that
  // configures a fetch refspec) so fetchCache can later advance its HEAD.
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

describe("unarchiveSession restore freshness (docs/161)", () => {
  it("restores an evicted session's branch from current origin/main, not a stale cache", async () => {
    const id = "sess-1";
    const workspaceDir = path.join(tmpDir, "workspace");
    sessionManager.track(id, "Restore me", workspaceDir);
    sessionManager.setRemoteUrl(id, remoteUrl);
    // Disk-idle ladder eviction: workspace reclaimed, but NOT user-hidden.
    dbManager.db.prepare("UPDATE sessions SET disk_tier = 'evicted' WHERE id = ?").run(id);

    // The remote advances AFTER the bare cache was created, so the cache's HEAD
    // is now stale. A restore that skipped the fresh fetch would branch from the
    // old commit.
    const advancedHead = advanceRemote("# advanced after cache\n");

    const { session } = await unarchiveSession(
      sessionManager,
      createRepoGit,
      () => cacheDir,
      githubAuthManager,
      repoStore,
      id,
    );

    // Restored back to hot.
    expect(session.diskTier).toBe("hot");

    // The new branch's tip and its origin/main both equal the *advanced* remote
    // head — i.e. the fresh fetch ran and the branch was cut from current main.
    const branchTip = execSync("git rev-parse HEAD", { cwd: workspaceDir }).toString().trim();
    const originMain = execSync("git rev-parse origin/main", { cwd: workspaceDir }).toString().trim();
    expect(branchTip).toBe(advancedHead);
    expect(originMain).toBe(advancedHead);
  });
});
