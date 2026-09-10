import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { unarchiveSession } from "./session.js";
import { computeResetBlocker } from "./pre-turn-reset.js";
import type { GitManager } from "../../shared/git.js";
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

function advanceRemote(content: string): string {
  fs.writeFileSync(path.join(seedDir, "README.md"), content);
  execSync("git add . && git commit -m advance --no-gpg-sign", { cwd: seedDir, stdio: "ignore" });
  execSync(`git push ${remoteUrl} HEAD:main --force`, { cwd: seedDir, stdio: "ignore" });
  return execSync("git rev-parse HEAD", { cwd: seedDir }).toString().trim();
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-restore-fresh-"));
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

describe("unarchiveSession restore freshness (docs/161)", () => {
  it("restores an evicted session's branch from current origin/main, not a stale cache", async () => {
    const id = "sess-1";
    const workspaceDir = path.join(tmpDir, "workspace");
    sessionManager.track(id, "Restore me", workspaceDir);
    sessionManager.setRemoteUrl(id, remoteUrl);
    dbManager.db.prepare("UPDATE sessions SET disk_tier = 'evicted' WHERE id = ?").run(id);

    const advancedHead = advanceRemote("# advanced after cache\n");

    const { session } = await unarchiveSession(
      sessionManager,
      createRepoGit,
      () => cacheDir,
      githubAuthManager,
      repoStore,
      id,
    );

    expect(session.diskTier).toBe("hot");

    const branchTip = execSync("git rev-parse HEAD", { cwd: workspaceDir }).toString().trim();
    const originMain = execSync("git rev-parse origin/main", { cwd: workspaceDir }).toString().trim();
    expect(branchTip).toBe(advancedHead);
    expect(originMain).toBe(advancedHead);
  });
});

describe("unarchiveSession drops the previous pull request", () => {
  function seedMergedArchivedSession(id: string, workspaceDir: string): void {
    sessionManager.track(id, "Merged then archived", workspaceDir);
    sessionManager.setRemoteUrl(id, remoteUrl);
    sessionManager.setBranch(id, "shipit/old");
    sessionManager.markMerged(id);
    sessionManager.setMergedHeadSha(id, "0000000000000000000000000000000000000000");
    sessionManager.setPrStatus(id, {
      sessionId: id, prNumber: 2483, prUrl: "https://github.com/o/r/pull/2483",
      prTitle: "Shipped", prBody: "", prState: "merged",
      baseBranch: "main", headBranch: "shipit/old",
      insertions: 1, deletions: 0,
      checks: { state: "none", total: 0, passed: 0, failed: 0, pending: 0 },
      mergeable: "unknown", reviewDecision: "none", autoMergeEnabled: false,
    });
    dbManager.db.prepare("UPDATE sessions SET user_archived = 1, disk_tier = 'evicted' WHERE id = ?").run(id);
  }

  it("leaves no merge record, no anchor, no breadcrumb and no snapshot", async () => {
    const id = "sess-merged";
    const workspaceDir = path.join(tmpDir, "workspace-merged");
    seedMergedArchivedSession(id, workspaceDir);

    const cleared: string[] = [];
    const { session } = await unarchiveSession(
      sessionManager, createRepoGit, () => cacheDir, githubAuthManager, repoStore, id,
      { clearPersisted: (s) => { cleared.push(s); sessionManager.setPrStatus(s, null); } },
    );

    expect(session.mergedAt).toBeUndefined();
    expect(session.mergedHeadSha).toBeUndefined();
    expect(session.previousMergedPr).toBeUndefined();
    expect(cleared).toEqual([id]);

    const row = dbManager.db
      .prepare("SELECT merged_at, merged_head_sha, previous_merged_pr, pr_status FROM sessions WHERE id = ?")
      .get(id) as Record<string, unknown>;
    expect(row).toEqual({
      merged_at: null, merged_head_sha: null, previous_merged_pr: null, pr_status: null,
    });
  });

  it("makes the docs/218 gate report not-merged instead of no-base-branch", async () => {
    const id = "sess-gate";
    const workspaceDir = path.join(tmpDir, "workspace-gate");
    seedMergedArchivedSession(id, workspaceDir);

    const before = await computeResetBlocker(
      sessionManager.get(id), null, {} as unknown as GitManager,
    );
    expect(before).toMatchObject({ clause: "no-base-branch" });

    const { session } = await unarchiveSession(
      sessionManager, createRepoGit, () => cacheDir, githubAuthManager, repoStore, id,
      { clearPersisted: () => {} },
    );

    const after = await computeResetBlocker(session, null, {} as unknown as GitManager);
    expect(after).toMatchObject({ clause: "not-merged" });
  });

  it("clears the snapshot of a session archived while its PR was still open", async () => {
    const id = "sess-open";
    const workspaceDir = path.join(tmpDir, "workspace-open");
    sessionManager.track(id, "Open PR, then archived", workspaceDir);
    sessionManager.setRemoteUrl(id, remoteUrl);
    sessionManager.setBranch(id, "shipit/old");
    sessionManager.setPrStatus(id, {
      sessionId: id, prNumber: 2484, prUrl: "https://github.com/o/r/pull/2484",
      prTitle: "In flight", prBody: "", prState: "open",
      baseBranch: "main", headBranch: "shipit/old",
      insertions: 1, deletions: 0,
      checks: { state: "none", total: 0, passed: 0, failed: 0, pending: 0 },
      mergeable: "unknown", reviewDecision: "none", autoMergeEnabled: false,
    });
    dbManager.db.prepare("UPDATE sessions SET user_archived = 1 WHERE id = ?").run(id);

    const { session } = await unarchiveSession(
      sessionManager, createRepoGit, () => cacheDir, githubAuthManager, repoStore, id,
      { clearPersisted: (s) => sessionManager.setPrStatus(s, null) },
    );

    expect(sessionManager.getPrStatus(id)).toBeNull();
    expect(await computeResetBlocker(session, null, {} as unknown as GitManager))
      .toMatchObject({ clause: "not-merged" });
  });

  it("clears a breadcrumb from a session re-armed before it was archived", async () => {
    const id = "sess-rearmed";
    const workspaceDir = path.join(tmpDir, "workspace-rearmed");
    seedMergedArchivedSession(id, workspaceDir);
    sessionManager.clearMerged(id, {
      number: 2483, url: "https://github.com/o/r/pull/2483", title: "Shipped", baseBranch: "main",
    });
    expect(sessionManager.get(id)?.previousMergedPr).toBeTruthy();

    const { session } = await unarchiveSession(
      sessionManager, createRepoGit, () => cacheDir, githubAuthManager, repoStore, id,
      { clearPersisted: () => {} },
    );

    expect(session.previousMergedPr).toBeUndefined();
    expect(await computeResetBlocker(session, null, {} as unknown as GitManager))
      .toMatchObject({ clause: "not-merged" });
  });
});
