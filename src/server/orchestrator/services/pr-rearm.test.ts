import { describe, it, expect, vi } from "vitest";
import { detectAndReArmMergedSession, detectAndReArmResetSession } from "./pr-rearm.js";
import type { SessionManager } from "../sessions.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import type { GitManager } from "../../shared/git.js";
import type { SessionInfo, WsServerMessage } from "../../shared/types.js";
import type { PrStatusSummary } from "../../shared/types/github-types.js";

/**
 * docs/202 — unit tests for the shared re-arm helper called by BOTH post-turn
 * sites. Detection gating (turn-gated, local-git-only) + the clearMerged/reArm/
 * session_list wiring.
 */

function makeSession(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "s1",
    title: "Test",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
    remoteUrl: "https://github.com/o/r.git",
    branch: "shipit/x",
    ...over,
  };
}

function makePrStatus(over: Partial<PrStatusSummary> = {}): PrStatusSummary {
  return {
    sessionId: "s1",
    prNumber: 42,
    prUrl: "https://github.com/o/r/pull/42",
    prTitle: "Old PR",
    prBody: "",
    prState: "merged",
    baseBranch: "main",
    headBranch: "shipit/x",
    insertions: 1,
    deletions: 0,
    checks: { state: "none", total: 0, passed: 0, failed: 0, pending: 0 },
    mergeable: "unknown",
    reviewDecision: "none",
    autoMergeEnabled: false,
    ...over,
  };
}

function harness(opts: {
  session: SessionInfo | undefined;
  priorStatus?: PrStatusSummary;
  advanced?: boolean | (() => Promise<boolean>);
  /** HEAD sha the stub reports — compared against `session.mergedHeadSha`. */
  headSha?: string | null;
  /** Make the base-ref freshening fetch fail. */
  fetchFails?: boolean;
}) {
  const clearMerged = vi.fn();
  const reArm = vi.fn();
  const sseBroadcast = vi.fn();
  const advancedBeyondMergedBase = vi.fn(async () => {
    if (typeof opts.advanced === "function") return opts.advanced();
    return opts.advanced ?? false;
  });
  const fetch = vi.fn(async () => {
    if (opts.fetchFails) throw new Error("fetch failed");
  });
  const getHeadHash = vi.fn(async () => opts.headSha ?? "headsha");
  const createGitManager = vi.fn(
    () => ({ advancedBeyondMergedBase, fetch, getHeadHash }) as unknown as GitManager,
  );

  const sessionManager = {
    get: vi.fn(() => opts.session),
    clearMerged,
    list: vi.fn(() => [opts.session].filter(Boolean) as SessionInfo[]),
  } as unknown as SessionManager;
  const prStatusPoller = {
    getStatus: vi.fn(() => opts.priorStatus),
    reArm,
  } as unknown as PrStatusPoller;

  return {
    run: () =>
      detectAndReArmMergedSession({
        deps: { sessionManager, prStatusPoller, createGitManager, sseBroadcast },
        sessionId: "s1",
        sessionDir: "/ws/s1",
      }),
    clearMerged,
    reArm,
    sseBroadcast,
    createGitManager,
    advancedBeyondMergedBase,
    fetch,
    getHeadHash,
  };
}

describe("detectAndReArmMergedSession (docs/202)", () => {
  it("is a no-op for a non-merged session (no git check, no GitHub/poller work)", async () => {
    const h = harness({ session: makeSession({ mergedAt: undefined }) });
    expect(await h.run()).toBe(false);
    expect(h.createGitManager).not.toHaveBeenCalled();
    expect(h.clearMerged).not.toHaveBeenCalled();
    expect(h.reArm).not.toHaveBeenCalled();
    expect(h.sseBroadcast).not.toHaveBeenCalled();
  });

  it("is a no-op for a merged session with no known prior base", async () => {
    const h = harness({ session: makeSession({ mergedAt: "2026-02-01" }), priorStatus: undefined });
    expect(await h.run()).toBe(false);
    expect(h.advancedBeyondMergedBase).not.toHaveBeenCalled();
    expect(h.clearMerged).not.toHaveBeenCalled();
  });

  it("stays merged (no re-arm) when the branch has not progressed", async () => {
    const h = harness({
      session: makeSession({ mergedAt: "2026-02-01" }),
      priorStatus: makePrStatus(),
      advanced: false,
    });
    expect(await h.run()).toBe(false);
    expect(h.advancedBeyondMergedBase).toHaveBeenCalledWith("main");
    expect(h.clearMerged).not.toHaveBeenCalled();
    expect(h.reArm).not.toHaveBeenCalled();
    expect(h.sseBroadcast).not.toHaveBeenCalled();
  });

  it("re-arms when merged + rebased + progressed", async () => {
    const h = harness({
      session: makeSession({ mergedAt: "2026-02-01" }),
      priorStatus: makePrStatus({ prNumber: 42, baseBranch: "release/v2" }),
      advanced: true,
    });
    expect(await h.run()).toBe(true);
    expect(h.clearMerged).toHaveBeenCalledWith("s1", {
      number: 42,
      url: "https://github.com/o/r/pull/42",
      title: "Old PR",
      baseBranch: "release/v2",
    });
    expect(h.reArm).toHaveBeenCalledWith("s1", 42);
    expect(h.sseBroadcast).toHaveBeenCalledWith("session_list", expect.objectContaining({ sessions: expect.any(Array) }));
  });

  it("uses the prior PR's base branch for detection (not hardcoded main)", async () => {
    const h = harness({
      session: makeSession({ mergedAt: "2026-02-01" }),
      priorStatus: makePrStatus({ baseBranch: "release/v2" }),
      advanced: true,
    });
    await h.run();
    expect(h.advancedBeyondMergedBase).toHaveBeenCalledWith("release/v2");
  });

  it("fails safe (no re-arm) when the local git check throws", async () => {
    const h = harness({
      session: makeSession({ mergedAt: "2026-02-01" }),
      priorStatus: makePrStatus(),
      advanced: () => Promise.reject(new Error("workspace evicted")),
    });
    expect(await h.run()).toBe(false);
    expect(h.clearMerged).not.toHaveBeenCalled();
    expect(h.reArm).not.toHaveBeenCalled();
  });

  /**
   * The detection is base-relative and `origin/<base>` in a session clone only
   * moves when THAT clone fetches — nothing on the merge path does. Deciding off
   * a stale ref reported "progressed" for an untouched merged branch (its
   * merge-base with its own fork point IS the fork point), which un-merged the
   * session on its first committing turn and left a "ready" card with the stale
   * diff + "Create PR" — while also wiping `mergedHeadSha`, permanently
   * disabling the docs/218 auto-advance for that session.
   */
  describe("base-ref freshness (stale origin/<base> false positive)", () => {
    it("fetches origin before evaluating progress", async () => {
      const h = harness({
        session: makeSession({ mergedAt: "2026-02-01", mergedHeadSha: "merged-tip" }),
        priorStatus: makePrStatus(),
        headSha: "moved-past-merge",
        advanced: true,
      });
      expect(await h.run()).toBe(true);
      expect(h.fetch).toHaveBeenCalledWith("origin");
      // Ordering is what matters: the base ref must be current *before* the
      // decision reads it.
      expect(h.fetch.mock.invocationCallOrder[0])
        .toBeLessThan(h.advancedBeyondMergedBase.mock.invocationCallOrder[0]);
    });

    it("stays merged when the freshening fetch fails (no deciding off a stale ref)", async () => {
      const h = harness({
        session: makeSession({ mergedAt: "2026-02-01", mergedHeadSha: "merged-tip" }),
        priorStatus: makePrStatus(),
        headSha: "moved-past-merge",
        advanced: true, // would re-arm if the stale ref were trusted
        fetchFails: true,
      });
      expect(await h.run()).toBe(false);
      expect(h.advancedBeyondMergedBase).not.toHaveBeenCalled();
      expect(h.clearMerged).not.toHaveBeenCalled();
      expect(h.reArm).not.toHaveBeenCalled();
    });

    it("short-circuits with no fetch when HEAD still sits on the merged tip", async () => {
      const h = harness({
        session: makeSession({ mergedAt: "2026-02-01", mergedHeadSha: "merged-tip" }),
        priorStatus: makePrStatus(),
        headSha: "merged-tip",
        advanced: true, // the stale-ref answer — must not be consulted
      });
      expect(await h.run()).toBe(false);
      expect(h.fetch).not.toHaveBeenCalled();
      expect(h.advancedBeyondMergedBase).not.toHaveBeenCalled();
      expect(h.clearMerged).not.toHaveBeenCalled();
    });

    it("falls through to fetch-then-compare when no merged-tip anchor is recorded", async () => {
      const h = harness({
        session: makeSession({ mergedAt: "2026-02-01", mergedHeadSha: undefined }),
        priorStatus: makePrStatus(),
        advanced: true,
      });
      expect(await h.run()).toBe(true);
      expect(h.fetch).toHaveBeenCalledWith("origin");
      expect(h.advancedBeyondMergedBase).toHaveBeenCalledWith("main");
    });
  });
});

function resetHarness(opts: {
  session: SessionInfo | undefined;
  priorStatus?: PrStatusSummary;
  atBase?: boolean | (() => Promise<boolean>);
  headSha?: string | null;
  fetchFails?: boolean;
  skipFetch?: boolean;
}) {
  const clearMerged = vi.fn();
  const reArm = vi.fn();
  const sseBroadcast = vi.fn();
  const emit = vi.fn<(msg: WsServerMessage) => void>();
  const headIsAtBase = vi.fn(async () => {
    if (typeof opts.atBase === "function") return opts.atBase();
    return opts.atBase ?? false;
  });
  const fetch = vi.fn(async () => {
    if (opts.fetchFails) throw new Error("fetch failed");
  });
  const getHeadHash = vi.fn(async () => opts.headSha ?? "headsha");
  const createGitManager = vi.fn(
    () => ({ headIsAtBase, fetch, getHeadHash }) as unknown as GitManager,
  );

  const sessionManager = {
    get: vi.fn(() => opts.session),
    clearMerged,
    list: vi.fn(() => [opts.session].filter(Boolean) as SessionInfo[]),
  } as unknown as SessionManager;
  const prStatusPoller = {
    getStatus: vi.fn(() => opts.priorStatus),
    reArm,
  } as unknown as PrStatusPoller;

  return {
    run: () =>
      detectAndReArmResetSession({
        deps: { sessionManager, prStatusPoller, createGitManager, sseBroadcast },
        sessionId: "s1",
        sessionDir: "/ws/s1",
        emit,
        ...(opts.skipFetch !== undefined ? { skipFetch: opts.skipFetch } : {}),
      }),
    clearMerged,
    reArm,
    sseBroadcast,
    createGitManager,
    headIsAtBase,
    emit,
    fetch,
    getHeadHash,
  };
}

describe("detectAndReArmResetSession (docs/216)", () => {
  it("is a no-op for a non-merged session (no git check)", async () => {
    const h = resetHarness({ session: makeSession({ mergedAt: undefined }) });
    expect(await h.run()).toBe(false);
    expect(h.createGitManager).not.toHaveBeenCalled();
    expect(h.clearMerged).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("is a no-op for a merged session with no known prior base", async () => {
    const h = resetHarness({ session: makeSession({ mergedAt: "2026-02-01" }), priorStatus: undefined });
    expect(await h.run()).toBe(false);
    expect(h.headIsAtBase).not.toHaveBeenCalled();
    expect(h.clearMerged).not.toHaveBeenCalled();
  });

  it("stays merged (no re-arm, no card) when the branch is NOT at the base", async () => {
    const h = resetHarness({
      session: makeSession({ mergedAt: "2026-02-01" }),
      priorStatus: makePrStatus(),
      atBase: false,
    });
    expect(await h.run()).toBe(false);
    expect(h.headIsAtBase).toHaveBeenCalledWith("main");
    expect(h.clearMerged).not.toHaveBeenCalled();
    expect(h.reArm).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("re-arms + emits a clean ready card when merged + branch reset to the base", async () => {
    const h = resetHarness({
      session: makeSession({ mergedAt: "2026-02-01", branch: "shipit/x" }),
      priorStatus: makePrStatus({ prNumber: 42, baseBranch: "release/v2" }),
      atBase: true,
    });
    expect(await h.run()).toBe(true);
    expect(h.headIsAtBase).toHaveBeenCalledWith("release/v2");
    expect(h.clearMerged).toHaveBeenCalledWith("s1", {
      number: 42,
      url: "https://github.com/o/r/pull/42",
      title: "Old PR",
      baseBranch: "release/v2",
    });
    expect(h.reArm).toHaveBeenCalledWith("s1", 42);
    expect(h.sseBroadcast).toHaveBeenCalledWith("session_list", expect.objectContaining({ sessions: expect.any(Array) }));
    // The card carries previousMergedPr so it overrides the active viewer's
    // stale terminal merged card, with a 0-diff "ready" phase (no auto-create).
    expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "pr_lifecycle_update",
      sessionId: "s1",
      cardId: "pr-card-s1",
      phase: "ready",
      headBranch: "shipit/x",
      totalInsertions: 0,
      totalDeletions: 0,
      previousMergedPr: expect.objectContaining({ number: 42, baseBranch: "release/v2" }),
    }));
  });

  it("fails safe (no re-arm) when the local git check throws", async () => {
    const h = resetHarness({
      session: makeSession({ mergedAt: "2026-02-01" }),
      priorStatus: makePrStatus(),
      atBase: () => Promise.reject(new Error("workspace evicted")),
    });
    expect(await h.run()).toBe(false);
    expect(h.clearMerged).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
  });

  describe("base-ref freshness", () => {
    it("fetches origin before comparing HEAD to the base", async () => {
      const h = resetHarness({
        session: makeSession({ mergedAt: "2026-02-01", mergedHeadSha: "merged-tip" }),
        priorStatus: makePrStatus(),
        headSha: "at-the-base",
        atBase: true,
      });
      expect(await h.run()).toBe(true);
      expect(h.fetch).toHaveBeenCalledWith("origin");
      expect(h.fetch.mock.invocationCallOrder[0])
        .toBeLessThan(h.headIsAtBase.mock.invocationCallOrder[0]);
    });

    it("stays merged when the freshening fetch fails", async () => {
      const h = resetHarness({
        session: makeSession({ mergedAt: "2026-02-01", mergedHeadSha: "merged-tip" }),
        priorStatus: makePrStatus(),
        headSha: "at-the-base",
        atBase: true,
        fetchFails: true,
      });
      expect(await h.run()).toBe(false);
      expect(h.headIsAtBase).not.toHaveBeenCalled();
      expect(h.emit).not.toHaveBeenCalled();
    });

    it("skips the fetch when the caller just fetched (docs/218 pre-turn reset)", async () => {
      const h = resetHarness({
        session: makeSession({ mergedAt: "2026-02-01", mergedHeadSha: "merged-tip" }),
        priorStatus: makePrStatus(),
        headSha: "at-the-base",
        atBase: true,
        skipFetch: true,
      });
      expect(await h.run()).toBe(true);
      expect(h.fetch).not.toHaveBeenCalled();
      expect(h.headIsAtBase).toHaveBeenCalledWith("main");
    });

    it("short-circuits with no fetch when HEAD still sits on the merged tip", async () => {
      const h = resetHarness({
        session: makeSession({ mergedAt: "2026-02-01", mergedHeadSha: "merged-tip" }),
        priorStatus: makePrStatus(),
        headSha: "merged-tip",
        atBase: true,
      });
      expect(await h.run()).toBe(false);
      expect(h.fetch).not.toHaveBeenCalled();
      expect(h.headIsAtBase).not.toHaveBeenCalled();
    });
  });
});
