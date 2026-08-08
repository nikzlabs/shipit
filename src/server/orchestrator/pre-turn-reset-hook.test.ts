/**
 * docs/218 + planning#333 — the shared per-turn wiring of the merged-branch reset.
 *
 * `services/pre-turn-reset.test.ts` covers the gate and the git move. This
 * covers what a turn does around it, and above all the guarantee the user asked
 * for in so many words: **the "Branch updated to latest <base>" card always
 * appears when the branch moved.** A destructive move nobody watched happen,
 * with no record in the transcript, is the failure mode planning#297 already had to
 * fix once for the skip case.
 */
import { describe, it, expect, vi } from "vitest";
import { applyPreTurnReset, type PreTurnResetHookDeps, type PreTurnResetRunner } from "./pre-turn-reset-hook.js";
import type { GitManager } from "../shared/git.js";
import type { SessionInfo, WsServerMessage } from "../shared/types.js";
import type { PrStatusSummary } from "../shared/types/github-types.js";
import type { PersistedMessage } from "./chat-history.js";

vi.mock("./session-worker-uid.js", () => ({ handWorkspaceBackToWorker: vi.fn() }));

const MERGED_SHA = "a1f3c9d0000000000000000000000000000000aa";
const BASE_TIP = "7e02b480000000000000000000000000000000bb";

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
  } as unknown as PreTurnResetRunner;

  const deps = {
    sessionManager: {
      get: () => session,
      getPrStatus: () => prStatus ?? null,
      // Touched only by the re-arm, which bails before this on a session with
      // no live merged snapshot.
      clearMerged: vi.fn(),
    },
    // The re-arm is exercised in `pr-rearm.test.ts`; here it only needs to not
    // throw, so its own gate (`prior?.baseBranch`) is what runs.
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
    expect(h.appended).toHaveLength(0); // nothing written until the anchor fires

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

  it("still records the card when the turn dies before the anchor fires", async () => {
    // The guarantee: a moved branch ALWAYS leaves a record. If the turn throws
    // during setup, `afterUserMessagePersisted` never runs — `ensureRecorded`
    // (called from the caller's `finally`) writes it instead.
    const h = makeHarness();
    const result = await run(h);

    result.ensureRecorded!("s1");

    expect(h.appended.filter((m) => "branchAutoReset" in m)).toHaveLength(1);
  });

  it("appends the late record directly — never as an in-progress rewrite (docs/236)", async () => {
    // `ensureRecorded` fires when the turn died before the anchor, often before
    // `executeAgentTurn` ran at all — so `resetRunnerTurnState` never cleared the
    // runner and `chatMessageGroups` may still hold the PREVIOUS turn's messages
    // while `running` is still true. Recording in-band there would rewrite that
    // finished turn as `in_progress=1` rows for the next turn's
    // `replaceInProgress` to delete wholesale.
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
    // `emitChatCard` emits BEFORE it records or persists, so a throwing WS
    // listener used to consume the only delivery and leave the card in neither
    // `recordedCards` nor durable history — an emit-only transcript card. The
    // latch must close on success, not on attempt.
    const h = makeHarness();
    const result = await run(h);
    let failNextEmit = true;
    const realEmit = h.runner.emitMessage;
    (h.runner as { emitMessage: unknown }).emitMessage = (msg: WsServerMessage) => {
      if (failNextEmit) { failNextEmit = false; throw new Error("viewer transport closed"); }
      realEmit.call(h.runner, msg);
    };

    result.afterUserMessagePersisted!("s1"); // throws inside, swallowed
    expect(h.appended.filter((m) => "branchAutoReset" in m)).toHaveLength(0);

    result.ensureRecorded!("s1"); // the retry the latch must still allow

    expect(h.appended.filter((m) => "branchAutoReset" in m)).toHaveLength(1);
  });

  it("returns the delivery callbacks even when the post-reset bookkeeping throws", async () => {
    // The branch is already reset and force-pushed by the time the re-arm runs.
    // A throw there must not reject out of the hook: both callers establish
    // their `try/finally` only AFTER it returns, so the turn would abort with
    // the branch moved and no record — and none reconstructable, since the
    // re-arm may already have cleared `mergedAt`.
    // A stateful git, so the reset actually moves HEAD and the re-arm gets past
    // its own `unmovedSinceMerge` short-circuit to the `reArm` below.
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
    expect(h.deps.sessionManager.clearMerged).toHaveBeenCalled(); // the re-arm did reach it

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
    // Nothing moved, so the composer control must stay as it was.
    expect(h.emitted.some((m) => m.type === "reset_eligible")).toBe(false);
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
