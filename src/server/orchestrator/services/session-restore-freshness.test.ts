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

/**
 * Regression — an unarchive left the MERGE record behind while nulling the PR
 * snapshot, so a restored session carried `merged_at` + `merged_head_sha` from
 * the pre-archive PR on a branch that had never had one. The docs/218 pre-turn
 * auto-reset then refused every turn with `no-base-branch`
 * (`computeResetBlocker` passes its `mergedAt` clause, `resolveResetBase`
 * declines the breadcrumb while `mergedAt` is set), and the stale record went on
 * to mislabel the session's NEXT pull request as merged.
 *
 * The correct post-unarchive state is "this session has no pull request at
 * all": every column gone, and the gate reporting `not-merged`.
 */
describe("unarchiveSession drops the previous pull request", () => {
  /** Seed a user-archived session that had merged a PR before being archived. */
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
      // Stands in for `PrStatusPoller.clearPersisted`, whose DB half is exactly
      // this (the rest is poller memory + an SSE removal).
      { clearPersisted: (s) => { cleared.push(s); sessionManager.setPrStatus(s, null); } },
    );

    expect(session.mergedAt).toBeUndefined();
    expect(session.mergedHeadSha).toBeUndefined();
    expect(session.previousMergedPr).toBeUndefined();
    // The poller half runs from inside the service now, not from the route.
    expect(cleared).toEqual([id]);

    // Both halves are DB-backed, so a fresh read (a restart) sees the same.
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

    // Before: the gate finds a merge record but no base, and refuses with a
    // clause the user can do nothing about.
    const before = await computeResetBlocker(
      sessionManager.get(id), null, {} as unknown as GitManager,
    );
    expect(before).toMatchObject({ clause: "no-base-branch" });

    const { session } = await unarchiveSession(
      sessionManager, createRepoGit, () => cacheDir, githubAuthManager, repoStore, id,
      { clearPersisted: () => {} },
    );

    // After: no merged PR, so the gate short-circuits on its first clause and
    // the pre-turn hook stays silent (`not-merged` builds no notice).
    const after = await computeResetBlocker(session, null, {} as unknown as GitManager);
    expect(after).toMatchObject({ clause: "not-merged" });
  });

  it("clears the snapshot of a session archived while its PR was still open", async () => {
    // The clear is UNCONDITIONAL, which has to be right for a session that never
    // merged too: the new branch is not the branch that PR was opened from, so
    // its snapshot no longer describes this session either.
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
    // Never merged, nothing to un-merge — the gate is quiet either way.
    expect(await computeResetBlocker(session, null, {} as unknown as GitManager))
      .toMatchObject({ clause: "not-merged" });
  });

  it("clears a breadcrumb from a session re-armed before it was archived", async () => {
    const id = "sess-rearmed";
    const workspaceDir = path.join(tmpDir, "workspace-rearmed");
    seedMergedArchivedSession(id, workspaceDir);
    // docs/202 re-arm: merged_at gone, breadcrumb written — then archived. A
    // guarded `clearMerged` would no-op here and leave the breadcrumb standing.
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
