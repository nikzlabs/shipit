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

describe("markMergedAndPruneExcess — no longer archives excess", () => {
  // docs/161: demotion of excess merged sessions out of the sidebar is now a
  // pure listing concern (`SessionManager.list()` → `filterVisibleInSidebar`),
  // NOT an archive/disk operation. `markMergedAndPruneExcess` must therefore
  // leave every other merged session untouched: no `archived` flag, no disk
  // eviction, no runner disposal. The per-repo top-N cap is exercised directly
  // against the predicate in `sessions.test.ts`.
  it("does not archive any merged session even when far beyond the per-repo cap", async () => {
    // Seed six already-merged sessions in the same repo — well past the cap.
    const seeded: { id: string; mergedAt: string }[] = [];
    for (let i = 0; i < 6; i++) {
      const id = trackMergedSession({});
      const mergedAt = `2024-01-01 09:0${i}:00`;
      dbManager.db.prepare("UPDATE sessions SET merged_at = ? WHERE id = ?").run(mergedAt, id);
      seeded.push({ id, mergedAt });
    }

    const triggerId = trackMergedSession({});

    const disposeSpy = vi.fn();
    runnerRegistry = {
      get: () => undefined,
      dispose: disposeSpy,
    } as unknown as SessionRunnerRegistry;

    await markMergedAndPruneExcess(
      sessionManager,
      runnerRegistry,
      getBareCacheDir,
      triggerId,
    );

    // Nothing got archived; no runner was disposed.
    for (const s of seeded) {
      expect(sessionManager.get(s.id)?.archived).toBeFalsy();
      expect(sessionManager.get(s.id)?.diskTier).toBe("hot");
    }
    expect(sessionManager.get(triggerId)?.archived).toBeFalsy();
    expect(disposeSpy).not.toHaveBeenCalled();
  });

  it("does not invoke pruneVolumes for excess merged sessions", async () => {
    for (let i = 0; i < 5; i++) {
      const id = trackMergedSession({});
      dbManager.db
        .prepare("UPDATE sessions SET merged_at = ? WHERE id = ?")
        .run(`2024-01-01 09:0${i}:00`, id);
    }
    const triggerId = trackMergedSession({});

    const pruneVolumes = vi.fn().mockResolvedValue(undefined);
    await markMergedAndPruneExcess(
      sessionManager,
      runnerRegistry,
      getBareCacheDir,
      triggerId,
      pruneVolumes,
    );

    expect(pruneVolumes).not.toHaveBeenCalled();
  });
});
