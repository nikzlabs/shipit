import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyPreTurnReset, type PreTurnResetHookDeps, type PreTurnResetRunner } from "./pre-turn-reset-hook.js";
import { clearResetSkipEpisode } from "./services/pre-turn-reset.js";
import { MERGE_RECHECK_TIMEOUT_MS } from "./services/pre-turn-merge-recheck.js";
import type { GitManager } from "../shared/git.js";
import type { SessionInfo, WsServerMessage } from "../shared/types.js";
import type { PrStatusSummary } from "../shared/types/github-types.js";
import type { PersistedMessage } from "./chat-history.js";

vi.mock("./session-worker-uid.js", () => ({ handWorkspaceBackToWorker: vi.fn() }));

const MERGED_SHA = "a1f3c9d0000000000000000000000000000000aa";
const BASE_TIP = "7e02b480000000000000000000000000000000bb";

beforeEach(() => { clearResetSkipEpisode("s1"); });

function makeSession(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "s1",
    title: "Fix login redirect",
    createdAt: "2026-06-01T00:00:00.000Z",
    lastUsedAt: "2026-06-01T00:00:00.000Z",
    remoteUrl: "https://github.com/o/r.git",
    branch: "shipit/fix-login",
    mergedAt: "2026-06-02 12:00:00",
    mergedHeadSha: MERGED_SHA,
    ...over,
  };
}

function makePrStatus(over: Partial<PrStatusSummary> = {}): PrStatusSummary {
  return {
    sessionId: "s1",
    prNumber: 482,
    prUrl: "https://github.com/o/r/pull/482",
    prTitle: "Fix login redirect",
    prBody: "",
    prState: "merged",
    baseBranch: "main",
    headBranch: "shipit/fix-login",
    insertions: 1,
    deletions: 0,
    checks: { state: "none", total: 0, passed: 0, failed: 0, pending: 0 },
    mergeable: "unknown",
    reviewDecision: "none",
    autoMergeEnabled: false,
    ...over,
  };
}

function makeGit(over: Partial<Record<keyof GitManager, unknown>> = {}): GitManager {
  return {
    isClean: vi.fn().mockResolvedValue(true),
    currentBranchOrNull: vi.fn().mockResolvedValue("shipit/fix-login"),
    isRebaseInProgress: vi.fn().mockResolvedValue(false),
    isMergeOrSequencerInProgress: vi.fn().mockResolvedValue(false),
    getHeadHash: vi.fn().mockResolvedValue(MERGED_SHA),
    getRefHash: vi.fn().mockResolvedValue(BASE_TIP),
    isAncestor: vi.fn().mockResolvedValue(false),
    fetch: vi.fn().mockResolvedValue(undefined),
    resetHardToRemoteBase: vi.fn().mockResolvedValue({ from: MERGED_SHA, to: BASE_TIP }),
    forcePush: vi.fn().mockResolvedValue("ok"),
    headIsAtBase: vi.fn().mockResolvedValue(true),
    ...over,
  } as unknown as GitManager;
}

interface Harness {
  deps: PreTurnResetHookDeps;
  runner: PreTurnResetRunner;
  emitted: WsServerMessage[];
  appended: PersistedMessage[];
}

function makeHarness(over: {
  session?: SessionInfo | undefined;
  prStatus?: PrStatusSummary | null;
  git?: GitManager;
  setting?: boolean;
  running?: boolean;
} = {}): Harness {
  const emitted: WsServerMessage[] = [];
  const appended: PersistedMessage[] = [];
  const session = "session" in over ? over.session : makeSession();
  const prStatus = "prStatus" in over ? over.prStatus : makePrStatus();

  const runner: PreTurnResetRunner = {
    emitMessage: (msg: WsServerMessage) => { emitted.push(msg); },
    running: over.running ?? false,
    chatMessageGroups: [],
    recordedCards: [],
    steeredMessages: [],
    getTurnEventBuffer: () => [],
    lastPersistedBufferIndex: 0,
    reevaluateWorkspaceConfig: vi.fn(),
    notifyWorkspaceRewritten: vi.fn(),
  } as unknown as PreTurnResetRunner;

  const deps = {
    sessionManager: {
      get: () => session,
      getPrStatus: () => prStatus ?? null,
      clearMerged: vi.fn(),
    },
    prStatusPoller: { getStatus: () => prStatus ?? null, reArm: vi.fn() },
    createGitManager: () => over.git ?? makeGit(),
    sseBroadcast: vi.fn(),
    chatHistoryManager: {
      replaceInProgress: vi.fn(),
      append: (_sid: string, msg: PersistedMessage) => { appended.push(msg); },
    },
    getAutoResetMergedBranch: () => over.setting ?? true,
  } as unknown as PreTurnResetHookDeps;

  return { deps, runner, emitted, appended };
}

const run = (h: Harness, intent?: boolean) =>
  applyPreTurnReset({
    deps: h.deps,
    runner: h.runner,
    sessionId: "s1",
    sessionDir: "/ws",
    ...(intent !== undefined ? { intent } : {}),
  });

describe("applyPreTurnReset — the branch moved", () => {
  it("returns the agent prefix and records the branch-updated card at the anchor", async () => {
    const h = makeHarness();
    const result = await run(h);

    expect(result.agentPrefix).toContain("was merged into main");
    expect(h.appended).toHaveLength(0);

    result.afterUserMessagePersisted!("s1");

    const card = h.appended.find((m) => "branchAutoReset" in m);
    expect(card).toMatchObject({
      role: "assistant",
      branchAutoReset: { base: "main", prNumber: 482, fromSha: MERGED_SHA, toSha: BASE_TIP },
    });
    expect(h.emitted.some((m) => m.type === "branch_auto_reset_card")).toBe(true);
  });

  it("hides the composer control immediately (reset_eligible: false)", async () => {
    const h = makeHarness();
    await run(h);
    expect(h.emitted).toContainEqual({ type: "reset_eligible", sessionId: "s1", eligible: false });
  });

  it("tells the live session its config and dependencies were rewritten", async () => {
    const h = makeHarness();
    await run(h);
    expect(h.runner.reevaluateWorkspaceConfig).toHaveBeenCalledTimes(1);
    expect(h.runner.notifyWorkspaceRewritten).toHaveBeenCalledTimes(1);
  });

  it("still records the card when the turn dies before the anchor fires", async () => {
    const h = makeHarness();
    const result = await run(h);

    result.ensureRecorded!("s1");

    expect(h.appended.filter((m) => "branchAutoReset" in m)).toHaveLength(1);
  });

  it("appends the late record directly — never as an in-progress rewrite (docs/236)", async () => {
    const h = makeHarness({ running: true });
    const result = await run(h);

    result.ensureRecorded!("s1");

    expect(h.deps.chatHistoryManager.replaceInProgress).not.toHaveBeenCalled();
    expect(h.appended.filter((m) => "branchAutoReset" in m)).toHaveLength(1);
  });

  it("writes the record exactly once when both triggers fire", async () => {
    const h = makeHarness();
    const result = await run(h);

    result.afterUserMessagePersisted!("s1");
    result.ensureRecorded!("s1");
    result.ensureRecorded!("s1");

    expect(h.appended.filter((m) => "branchAutoReset" in m)).toHaveLength(1);
    expect(h.emitted.filter((m) => m.type === "branch_auto_reset_card")).toHaveLength(1);
  });

  it("never lets a transcript-write failure abort the turn", async () => {
    const h = makeHarness();
    (h.deps.chatHistoryManager as { append: unknown }).append = () => {
      throw new Error("database connection is not open");
    };
    const result = await run(h);
    expect(() => result.ensureRecorded!("s1")).not.toThrow();
  });

  it("retries on the fallback when the anchored write threw (latch closes on success)", async () => {
    const h = makeHarness();
    const result = await run(h);
    let failNextEmit = true;
    const realEmit = h.runner.emitMessage;
    (h.runner as { emitMessage: unknown }).emitMessage = (msg: WsServerMessage) => {
      if (failNextEmit) { failNextEmit = false; throw new Error("viewer transport closed"); }
      realEmit.call(h.runner, msg);
    };

    result.afterUserMessagePersisted!("s1");
    expect(h.appended.filter((m) => "branchAutoReset" in m)).toHaveLength(0);

    result.ensureRecorded!("s1");

    expect(h.appended.filter((m) => "branchAutoReset" in m)).toHaveLength(1);
  });

  it("returns the delivery callbacks even when the post-reset bookkeeping throws", async () => {
    let head = MERGED_SHA;
    const h = makeHarness({
      git: makeGit({
        getHeadHash: vi.fn(async () => head),
        getRefHash: vi.fn(async () => BASE_TIP),
        headIsAtBase: vi.fn(async () => head === BASE_TIP),
        resetHardToRemoteBase: vi.fn(async () => {
          const from = head;
          head = BASE_TIP;
          return { from, to: BASE_TIP };
        }),
      }),
    });
    (h.deps.prStatusPoller as { reArm: unknown }).reArm = () => {
      throw new Error("pr status write failed");
    };

    const result = await run(h);
    expect(h.deps.sessionManager.clearMerged).toHaveBeenCalled();

    expect(result.agentPrefix).toContain("was merged into main");
    result.ensureRecorded!("s1");
    expect(h.appended.filter((m) => "branchAutoReset" in m)).toHaveLength(1);
  });
});

describe("applyPreTurnReset — the branch did not move", () => {
  it("persists the planning#297 skip notice on a merged session", async () => {
    const h = makeHarness({ git: makeGit({ isClean: vi.fn().mockResolvedValue(false) }) });
    const result = await run(h);

    expect(result.agentPrefix).toContain("NOT reset");
    result.afterUserMessagePersisted!("s1");

    const notice = h.appended.find((m) => m.notice === true);
    expect(notice?.text).toContain("Branch not updated to the latest base");
    expect(notice?.noticeLevel).toBe("warn");
    expect(h.emitted.some((m) => m.type === "reset_eligible")).toBe(false);
    expect(h.runner.notifyWorkspaceRewritten).not.toHaveBeenCalled();
  });

  it("drops the repeat of a refusal the user was already shown", async () => {
    const dirty = { git: makeGit({ isClean: vi.fn().mockResolvedValue(false) }) };
    await run(makeHarness(dirty));

    const h = makeHarness(dirty);
    const result = await run(h);
    expect(result.agentPrefix).toContain("NOT reset");
    result.afterUserMessagePersisted!("s1");
    expect(h.appended.find((m) => m.notice === true)).toBeUndefined();
  });

  it("gives the claim back when the late transcript write fails, so the next turn retries", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const dirty = { git: makeGit({ isClean: vi.fn().mockResolvedValue(false) }) };
    const broken = makeHarness(dirty);
    (broken.deps.chatHistoryManager as { append: unknown }).append = () => {
      throw new Error("db closed");
    };
    (await run(broken)).ensureRecorded!("s1");

    const h = makeHarness(dirty);
    const result = await run(h);
    result.afterUserMessagePersisted!("s1");
    expect(h.appended.find((m) => m.notice === true)?.text).toContain("Branch not updated");
    err.mockRestore();
  });

  it("reports a per-send untick at info level", async () => {
    const h = makeHarness();
    const result = await run(h, false);

    result.afterUserMessagePersisted!("s1");
    expect(h.appended.find((m) => m.notice === true)?.noticeLevel).toBe("info");
  });

  it("is completely silent on a session with no merged PR", async () => {
    const h = makeHarness({ session: makeSession({ mergedAt: undefined }) });
    const result = await run(h);

    expect(result).toEqual({ agentPrefix: "" });
    expect(h.appended).toHaveLength(0);
    expect(h.emitted).toHaveLength(0);
  });
});

describe("applyPreTurnReset — a merge the poller has not observed yet", () => {
  const PUSHED_TIP = MERGED_SHA;

  const raceGit = (): GitManager =>
    makeGit({
      getHeadHash: vi.fn().mockResolvedValue(PUSHED_TIP),
      getRefHash: vi.fn(async (ref: string) =>
        ref === "origin/shipit/fix-login" ? PUSHED_TIP : BASE_TIP,
      ),
    });

  function makeRaceHarness(opts: { merges?: boolean; bookkeepingHangs?: boolean } = {}) {
    const emitted: WsServerMessage[] = [];
    const appended: PersistedMessage[] = [];
    let session = makeSession({ mergedAt: undefined, mergedHeadSha: undefined });
    let prStatus = makePrStatus({ prState: "open" });
    const forceVerifySessionPrState = vi.fn(async (_id: string, _o?: unknown) => {
      if (opts.merges === false) return;
      prStatus = makePrStatus({ prState: "merged" });
      session = { ...session, mergedAt: "2026-08-22 19:32:02", mergedHeadSha: PUSHED_TIP };
    });

    const runner = {
      emitMessage: (msg: WsServerMessage) => { emitted.push(msg); },
      running: false,
      chatMessageGroups: [],
      recordedCards: [],
      steeredMessages: [],
      getTurnEventBuffer: () => [],
      lastPersistedBufferIndex: 0,
      reevaluateWorkspaceConfig: vi.fn(),
      notifyWorkspaceRewritten: vi.fn(),
    } as unknown as PreTurnResetRunner;

    const deps = {
      sessionManager: {
        get: () => session,
        getPrStatus: () => prStatus,
        clearMerged: vi.fn(),
      },
      prStatusPoller: {
        getStatus: () => prStatus,
        reArm: vi.fn(),
        forceVerifySessionPrState,
        awaitMergeHandling: vi.fn(
          opts.bookkeepingHangs ? () => new Promise<void>(() => {}) : async () => {},
        ),
      },
      createGitManager: () => raceGit(),
      sseBroadcast: vi.fn(),
      chatHistoryManager: {
        replaceInProgress: vi.fn(),
        append: (_sid: string, msg: PersistedMessage) => { appended.push(msg); },
      },
      getAutoResetMergedBranch: () => true,
    } as unknown as PreTurnResetHookDeps;

    return { deps, runner, emitted, appended, forceVerifySessionPrState };
  }

  it("resets the branch on the turn that would otherwise have stranded its commit", async () => {
    const h = makeRaceHarness();
    const result = await applyPreTurnReset({ deps: h.deps, runner: h.runner, sessionId: "s1", sessionDir: "/ws" });

    expect(h.forceVerifySessionPrState).toHaveBeenCalledOnce();
    expect(result.agentPrefix).toContain("was merged into main");
    result.afterUserMessagePersisted!("s1");
    expect(h.appended.find((m) => "branchAutoReset" in m)).toMatchObject({
      branchAutoReset: { base: "main", prNumber: 482, fromSha: MERGED_SHA, toSha: BASE_TIP },
    });
  });

  it("leaves the `verifiedAbsent` debounce un-armed, so the NEXT merge is still detected", async () => {
    const h = makeRaceHarness();
    await applyPreTurnReset({ deps: h.deps, runner: h.runner, sessionId: "s1", sessionDir: "/ws" });
    expect(h.forceVerifySessionPrState).toHaveBeenCalledWith("s1", { armAbsentDebounce: false });
  });

  it("stays silent when the probe confirms the pull request is still open", async () => {
    const h = makeRaceHarness({ merges: false });
    const result = await applyPreTurnReset({ deps: h.deps, runner: h.runner, sessionId: "s1", sessionDir: "/ws" });

    expect(result).toEqual({ agentPrefix: "" });
    expect(h.appended).toHaveLength(0);
    expect(h.emitted).toHaveLength(0);
  });

  it("refuses to reset while the merge bookkeeping is still in flight", async () => {
    const h = makeRaceHarness({ bookkeepingHangs: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    const pending = applyPreTurnReset({ deps: h.deps, runner: h.runner, sessionId: "s1", sessionDir: "/ws" });
    await vi.advanceTimersByTimeAsync(MERGE_RECHECK_TIMEOUT_MS + 1);
    const result = await pending;
    vi.useRealTimers();

    expect(result).toEqual({ agentPrefix: "" });
    expect(h.appended).toHaveLength(0);
    expect(h.emitted).toHaveLength(0);
    expect(h.runner.notifyWorkspaceRewritten).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
