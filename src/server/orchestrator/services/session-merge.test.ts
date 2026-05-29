/**
 * Unit tests for `markMergedAndPruneExcess` — focused on the branch-cleanup
 * side effect added so feature branches don't linger on GitHub after the PR
 * merges.
 *
 * Integration coverage of the poller → callback wiring lives in
 * `integration_tests/pr-merge.test.ts`. This file exercises the service
 * function directly with stub dependencies.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import crypto from "node:crypto";
import { markMergedAndPruneExcess } from "./session.js";
import { SessionManager } from "../sessions.js";
import { DatabaseManager } from "../../shared/database.js";
import {
  StubGitHubAuthManager,
  createTestDatabaseManager,
} from "../integration_tests/test-helpers.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { RepoGit } from "../repo-git.js";

let tmpDir: string;
let dbManager: DatabaseManager;
let sessionManager: SessionManager;
let runnerRegistry: SessionRunnerRegistry;
const remoteUrl = "https://github.com/test-user/test-repo.git";
const cacheDir = "/fake/repo-cache/abc123";

beforeEach(() => {
  tmpDir = fs.mkdtempSync("/tmp/shipit-session-merge-test-");
  dbManager = createTestDatabaseManager();
  sessionManager = new SessionManager(dbManager);
  // Runner registry stub — markMergedAndPruneExcess only calls .get / .dispose
  // during the excess-prune path, and only when we actually have excess
  // sessions to archive. The tests below either don't trip that path or
  // accept the no-op behaviour from a registry with no live runners.
  runnerRegistry = {
    get: () => undefined,
    dispose: () => undefined,
  } as unknown as SessionRunnerRegistry;
});

afterEach(() => {
  dbManager.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function getBareCacheDir(_url: string) {
  return cacheDir;
}

function trackMergedSession(opts: { branch?: string; remoteUrl?: string | null }) {
  const id = crypto.randomUUID();
  sessionManager.track(id, "Test session", `${tmpDir}/${id}`);
  if (opts.remoteUrl !== null) {
    sessionManager.setRemoteUrl(id, opts.remoteUrl ?? remoteUrl);
  }
  if (opts.branch) sessionManager.setBranch(id, opts.branch);
  return id;
}

describe("markMergedAndPruneExcess — branch cleanup", () => {
  it("deletes the remote branch on the bare cache after marking merged", async () => {
    const sessionId = trackMergedSession({ branch: "shipit/test-feature" });

    const deleteBranch = vi.fn().mockResolvedValue(undefined);
    const setRemoteUrl = vi.fn().mockResolvedValue(undefined);
    const fakeRepoGit = { deleteBranch, setRemoteUrl } as unknown as RepoGit;
    const createRepoGit = vi.fn().mockReturnValue(fakeRepoGit);

    const githubAuth = new StubGitHubAuthManager();
    await githubAuth.setToken("test-token"); // authenticated → refresh path runs

    await markMergedAndPruneExcess(
      sessionManager,
      runnerRegistry,
      getBareCacheDir,
      sessionId,
      undefined, // pruneVolumes
      createRepoGit,
      githubAuth as any,
    );

    expect(createRepoGit).toHaveBeenCalledWith(cacheDir);
    expect(setRemoteUrl).toHaveBeenCalledOnce(); // creds refreshed pre-push
    expect(deleteBranch).toHaveBeenCalledWith("shipit/test-feature");
    // Confirm the session was still marked merged (deletion happens after).
    expect(sessionManager.get(sessionId)?.mergedAt).toBeTruthy();
  });

  it("does not refresh credentials when GitHub auth is unauthenticated", async () => {
    const sessionId = trackMergedSession({ branch: "shipit/test-feature" });

    const deleteBranch = vi.fn().mockResolvedValue(undefined);
    const setRemoteUrl = vi.fn().mockResolvedValue(undefined);
    const fakeRepoGit = { deleteBranch, setRemoteUrl } as unknown as RepoGit;
    const createRepoGit = vi.fn().mockReturnValue(fakeRepoGit);

    const githubAuth = new StubGitHubAuthManager();
    // Not calling setToken — stays unauthenticated.

    await markMergedAndPruneExcess(
      sessionManager,
      runnerRegistry,
      getBareCacheDir,
      sessionId,
      undefined,
      createRepoGit,
      githubAuth as any,
    );

    expect(setRemoteUrl).not.toHaveBeenCalled();
    expect(deleteBranch).toHaveBeenCalledWith("shipit/test-feature");
  });

  it("swallows deletion errors so post-merge handling continues", async () => {
    const sessionId = trackMergedSession({ branch: "shipit/broken" });

    const deleteBranch = vi.fn().mockRejectedValue(new Error("network down"));
    const fakeRepoGit = {
      deleteBranch,
      setRemoteUrl: vi.fn().mockResolvedValue(undefined),
    } as unknown as RepoGit;
    const createRepoGit = vi.fn().mockReturnValue(fakeRepoGit);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Should not throw.
    await expect(
      markMergedAndPruneExcess(
        sessionManager,
        runnerRegistry,
        getBareCacheDir,
        sessionId,
        undefined,
        createRepoGit,
        undefined,
      ),
    ).resolves.toBeDefined();

    expect(deleteBranch).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    expect(sessionManager.get(sessionId)?.mergedAt).toBeTruthy();
  });

  it("skips branch deletion entirely when createRepoGit is not provided", async () => {
    // Mirrors the old call signature — defensive: callers that omit the new
    // deps (e.g. legacy test harnesses) still get the original behavior with
    // no surprise side effects.
    const sessionId = trackMergedSession({ branch: "shipit/legacy" });

    const result = await markMergedAndPruneExcess(
      sessionManager,
      runnerRegistry,
      getBareCacheDir,
      sessionId,
    );

    expect(result.sessions.find((s) => s.id === sessionId)?.mergedAt).toBeTruthy();
  });

  it("skips branch deletion when the session has no branch recorded", async () => {
    const sessionId = trackMergedSession({ branch: undefined });

    const deleteBranch = vi.fn().mockResolvedValue(undefined);
    const fakeRepoGit = {
      deleteBranch,
      setRemoteUrl: vi.fn().mockResolvedValue(undefined),
    } as unknown as RepoGit;
    const createRepoGit = vi.fn().mockReturnValue(fakeRepoGit);

    await markMergedAndPruneExcess(
      sessionManager,
      runnerRegistry,
      getBareCacheDir,
      sessionId,
      undefined,
      createRepoGit,
      undefined,
    );

    expect(createRepoGit).not.toHaveBeenCalled();
    expect(deleteBranch).not.toHaveBeenCalled();
  });

  it("returns early without invoking branch deletion when remoteUrl is missing (defensive)", async () => {
    const sessionId = trackMergedSession({ branch: "shipit/local", remoteUrl: null });

    const deleteBranch = vi.fn().mockResolvedValue(undefined);
    const fakeRepoGit = {
      deleteBranch,
      setRemoteUrl: vi.fn().mockResolvedValue(undefined),
    } as unknown as RepoGit;
    const createRepoGit = vi.fn().mockReturnValue(fakeRepoGit);

    await markMergedAndPruneExcess(
      sessionManager,
      runnerRegistry,
      getBareCacheDir,
      sessionId,
      undefined,
      createRepoGit,
      undefined,
    );

    expect(createRepoGit).not.toHaveBeenCalled();
    expect(deleteBranch).not.toHaveBeenCalled();
  });
});

describe("markMergedAndPruneExcess — subsession guard", () => {
  it("does not auto-archive merged sessions that have live child sessions", async () => {
    // Seed four already-merged sessions in the same repo with explicit
    // merged_at timestamps so the sort order is deterministic. `parentId`
    // is the oldest (so it would normally be pruned), and `secondOldestId`
    // is the next oldest (so it should still be pruned).
    const seeded: { id: string; mergedAt: string }[] = [
      { id: trackMergedSession({}), mergedAt: "2024-01-01 09:00:00" }, // parent — oldest
      { id: trackMergedSession({}), mergedAt: "2024-01-01 09:30:00" }, // second oldest
      { id: trackMergedSession({}), mergedAt: "2024-01-01 09:45:00" }, // kept
      { id: trackMergedSession({}), mergedAt: "2024-01-01 09:50:00" }, // kept
    ];
    for (const s of seeded) {
      dbManager.db.prepare("UPDATE sessions SET merged_at = ? WHERE id = ?").run(s.mergedAt, s.id);
    }
    const [parentId, secondOldestId] = seeded.map((s) => s.id);

    // Give the parent a non-archived child session.
    const childId = crypto.randomUUID();
    sessionManager.track(childId, "Child session", `${tmpDir}/${childId}`);
    sessionManager.setParentSession(childId, parentId);

    // Mark a fifth session merged — this triggers the prune. With five
    // merged sessions in the repo and a limit of three, the two oldest are
    // candidates for archive.
    const triggerId = trackMergedSession({});

    await markMergedAndPruneExcess(
      sessionManager,
      runnerRegistry,
      getBareCacheDir,
      triggerId,
    );

    // Parent stayed alive (has a live child); second-oldest was archived.
    expect(sessionManager.get(parentId)?.archived).toBeFalsy();
    expect(sessionManager.get(secondOldestId)?.archived).toBe(true);
  });

  it("does not auto-archive a merged session that is itself a child of another session", async () => {
    // Five merged sessions in the repo; the oldest is a CHILD of some parent.
    // Without the child guard, the oldest would be archived (limit 3). With
    // it, the child is skipped and the next-oldest (a regular session) is
    // archived instead.
    const seeded: { id: string; mergedAt: string }[] = [
      { id: trackMergedSession({}), mergedAt: "2024-01-01 09:00:00" }, // oldest — will be marked child
      { id: trackMergedSession({}), mergedAt: "2024-01-01 09:30:00" }, // next-oldest — should be archived
      { id: trackMergedSession({}), mergedAt: "2024-01-01 09:45:00" },
      { id: trackMergedSession({}), mergedAt: "2024-01-01 09:50:00" },
    ];
    for (const s of seeded) {
      dbManager.db.prepare("UPDATE sessions SET merged_at = ? WHERE id = ?").run(s.mergedAt, s.id);
    }
    const [childId, nextOldestId] = seeded.map((s) => s.id);

    // Mark the oldest as a child of some other (independent) session.
    const parentId = crypto.randomUUID();
    sessionManager.track(parentId, "Parent session", `${tmpDir}/${parentId}`);
    sessionManager.setParentSession(childId, parentId);

    const triggerId = trackMergedSession({});

    await markMergedAndPruneExcess(
      sessionManager,
      runnerRegistry,
      getBareCacheDir,
      triggerId,
    );

    // The child stayed alive; the next-oldest was archived in its place.
    expect(sessionManager.get(childId)?.archived).toBeFalsy();
    expect(sessionManager.get(nextOldestId)?.archived).toBe(true);
  });

  it("still auto-archives a merged session whose only children are already archived", async () => {
    const seeded: { id: string; mergedAt: string }[] = [
      { id: trackMergedSession({}), mergedAt: "2024-01-01 09:00:00" },
      { id: trackMergedSession({}), mergedAt: "2024-01-01 09:30:00" },
      { id: trackMergedSession({}), mergedAt: "2024-01-01 09:45:00" },
      { id: trackMergedSession({}), mergedAt: "2024-01-01 09:50:00" },
    ];
    for (const s of seeded) {
      dbManager.db.prepare("UPDATE sessions SET merged_at = ? WHERE id = ?").run(s.mergedAt, s.id);
    }
    const oldestId = seeded[0].id;

    // Child exists but is archived → parent is not "blocked" anymore.
    const childId = crypto.randomUUID();
    sessionManager.track(childId, "Child session", `${tmpDir}/${childId}`);
    sessionManager.setParentSession(childId, oldestId);
    sessionManager.archive(childId);

    const triggerId = trackMergedSession({});

    await markMergedAndPruneExcess(
      sessionManager,
      runnerRegistry,
      getBareCacheDir,
      triggerId,
    );

    expect(sessionManager.get(oldestId)?.archived).toBe(true);
  });
});
