import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";

vi.mock("./session-worker-uid.js", () => ({ handWorkspaceBackToWorker: vi.fn() }));
vi.mock("./git-lfs.js", () => ({
  restoreLfsAfterTreeRewrite: vi.fn(() => Promise.resolve({ status: "not-an-lfs-repo" as const, usesLfs: false })),
}));
const { emitChatCard, persistNoticeUnattached, detectAndReArmResetSession } = vi.hoisted(() => ({
  emitChatCard: vi.fn(),
  persistNoticeUnattached: vi.fn(),
  detectAndReArmResetSession: vi.fn(() => Promise.resolve()),
}));
vi.mock("./chat-card-persistence.js", () => ({ emitChatCard, persistNoticeUnattached }));
vi.mock("./services/pr-rearm.js", () => ({ detectAndReArmResetSession }));

import { DatabaseManager } from "../shared/database.js";
import { SessionManager } from "./sessions.js";
import { ChatHistoryManager } from "./chat-history.js";
import type { GitManager } from "../shared/git.js";
import type { PrStatusPoller } from "./pr-status-poller.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { PrStatusSummary } from "../shared/types/github-types.js";
import { captureTurn } from "./services/agent-merge-settlement.js";
import {
  resetBranchAfterDirectMerge,
  runExplicitBranchReset,
  type BranchResetFlowDeps,
} from "./branch-reset-flow.js";

const SESSION = "s1";
const BRANCH = "shipit/feature";
const MERGED_SHA = "a1f3c9d0000000000000000000000000000000aa";
const BASE_TIP = "7e02b480000000000000000000000000000000bb";

let dbManager: DatabaseManager;
let sessions: SessionManager;
let chatHistoryManager: ChatHistoryManager;

function prStatus(): PrStatusSummary {
  return {
    sessionId: SESSION,
    prNumber: 7,
    prUrl: "https://github.com/acme/shipit/pull/7",
    prTitle: "A pull request",
    prBody: "",
    prState: "merged",
    baseBranch: "main",
    headBranch: BRANCH,
    insertions: 1,
    deletions: 0,
    checks: { state: "none", total: 0, passed: 0, failed: 0, pending: 0 },
    mergeable: "unknown",
    reviewDecision: "none",
    autoMergeEnabled: false,
  };
}

function makeGit(over: Partial<Record<keyof GitManager, unknown>> = {}) {
  return {
    isClean: vi.fn().mockResolvedValue(true),
    uncommittedPaths: vi.fn().mockResolvedValue([]),
    currentBranchOrNull: vi.fn().mockResolvedValue(BRANCH),
    isRebaseInProgress: vi.fn().mockResolvedValue(false),
    isMergeOrSequencerInProgress: vi.fn().mockResolvedValue(false),
    getHeadHash: vi.fn().mockResolvedValue(MERGED_SHA),
    getRefHash: vi.fn().mockResolvedValue(BASE_TIP),
    isAncestor: vi.fn().mockResolvedValue(false),
    fetch: vi.fn().mockResolvedValue(undefined),
    resetHardToRemoteBase: vi.fn().mockResolvedValue({ from: MERGED_SHA, to: BASE_TIP }),
    forcePush: vi.fn().mockResolvedValue("Force pushed"),
    ...over,
  } as unknown as GitManager & { resetHardToRemoteBase: ReturnType<typeof vi.fn> };
}

function fakeRunner(over: { running?: boolean; turnEpoch?: number } = {}) {
  const runner = {
    sessionId: SESSION,
    sessionDir: os.tmpdir(),
    running: over.running ?? true,
    turnEpoch: over.turnEpoch ?? 1,
    mergeHold: false,
    sessionHold: null,
    queueLength: 0,
    leaseDepth: 0,
    emitMessage: vi.fn(),
    reevaluateWorkspaceConfig: vi.fn(),
    notifyWorkspaceRewritten: vi.fn(),
    beginPostTurnWork: () => { runner.leaseDepth += 1; },
    endPostTurnWork: () => { runner.leaseDepth -= 1; },
  };
  return runner;
}

function registry(runner: object | null): SessionRunnerRegistry {
  return { get: () => runner ?? undefined } as unknown as SessionRunnerRegistry;
}

function poller(handling: Promise<void> = Promise.resolve()): PrStatusPoller {
  return { awaitMergeHandling: vi.fn(() => handling) } as unknown as PrStatusPoller;
}

function deps(over: Partial<BranchResetFlowDeps> & { git?: GitManager } = {}): BranchResetFlowDeps {
  const git = over.git ?? makeGit();
  return {
    sessionManager: sessions,
    createGitManager: () => git,
    chatHistoryManager,
    prStatusPoller: poller(),
    sseBroadcast: vi.fn(),
    ...over,
  };
}

function merged(): void {
  sessions.markMerged(SESSION);
  sessions.setMergedHeadSha(SESSION, MERGED_SHA);
  sessions.setPrStatus(SESSION, prStatus());
}

beforeEach(() => {
  vi.clearAllMocks();
  dbManager = new DatabaseManager(":memory:");
  sessions = new SessionManager(dbManager);
  chatHistoryManager = new ChatHistoryManager(dbManager);
  sessions.track(SESSION, "A session");
  sessions.setRemoteUrl(SESSION, "https://github.com/acme/shipit.git");
  sessions.setBranch(SESSION, BRANCH);
});

afterEach(() => {
  dbManager.close();
});

describe("resetBranchAfterDirectMerge (docs/287 req 22)", () => {
  it("moves the branch inside the merging turn, and the answer says so", async () => {
    merged();
    const git = makeGit();
    const runner = fakeRunner();
    const reg = registry(runner);

    const answer = await resetBranchAfterDirectMerge(
      deps({ git, runnerRegistry: reg }),
      { sessionId: SESSION, sessionDir: "/ws", turn: captureTurn(reg, SESSION) },
    );

    expect(git.resetHardToRemoteBase).toHaveBeenCalledWith("main");
    expect(answer).toContain("moved this branch to the latest origin/main (a1f3c9d → 7e02b48)");
    expect(answer).toContain("re-read them before editing");
    expect(runner.notifyWorkspaceRewritten).toHaveBeenCalled();
    expect(emitChatCard).toHaveBeenCalledTimes(1);
    expect(detectAndReArmResetSession).toHaveBeenCalledTimes(1);
    // The agent reads the answer; a notice for its next turn would repeat it.
    expect(sessions.get(SESSION)?.pendingAgentNotice).toBeUndefined();
    expect(runner.mergeHold).toBe(false);
  });

  it("holds turn admission off, and the runner from being reclaimed, for the whole reset", async () => {
    merged();
    const runner = fakeRunner();
    const reg = registry(runner);
    let during = { held: false, leases: 0 };
    const git = makeGit({
      resetHardToRemoteBase: vi.fn(() => {
        during = { held: runner.mergeHold, leases: runner.leaseDepth };
        return Promise.resolve({ from: MERGED_SHA, to: BASE_TIP });
      }),
    });

    await resetBranchAfterDirectMerge(
      deps({ git, runnerRegistry: reg }),
      { sessionId: SESSION, sessionDir: "/ws", turn: captureTurn(reg, SESSION) },
    );

    expect(during).toEqual({ held: true, leases: 1 });
    expect(runner.mergeHold).toBe(false);
    expect(runner.leaseDepth).toBe(0);
  });

  it("abandons the reset when the turn ends while the merge is being recorded", async () => {
    const git = makeGit();
    const runner = fakeRunner();
    const reg = registry(runner);
    let finish!: () => void;
    const handling = new Promise<void>((resolve) => { finish = resolve; });

    const pending = resetBranchAfterDirectMerge(
      deps({ git, runnerRegistry: reg, prStatusPoller: poller(handling) }),
      { sessionId: SESSION, sessionDir: "/ws", turn: captureTurn(reg, SESSION) },
    );
    merged();
    runner.running = false;
    finish();
    const answer = await pending;

    expect(git.resetHardToRemoteBase).not.toHaveBeenCalled();
    expect(answer).toContain("the turn that ran the merge has ended");
    expect(runner.leaseDepth).toBe(0);
  });

  it("does not touch the branch when the turn that merged has ended", async () => {
    merged();
    const git = makeGit();
    const runner = fakeRunner();
    const reg = registry(runner);
    const turn = captureTurn(reg, SESSION);
    runner.running = false;

    const answer = await resetBranchAfterDirectMerge(
      deps({ git, runnerRegistry: reg }),
      { sessionId: SESSION, sessionDir: "/ws", turn },
    );

    expect(git.resetHardToRemoteBase).not.toHaveBeenCalled();
    expect(answer).toContain("the turn that ran the merge has ended");
  });

  it("does not touch the branch when a different turn is now running", async () => {
    merged();
    const git = makeGit();
    const runner = fakeRunner({ turnEpoch: 1 });
    const reg = registry(runner);
    const turn = captureTurn(reg, SESSION);
    runner.turnEpoch = 2;

    await resetBranchAfterDirectMerge(deps({ git, runnerRegistry: reg }), { sessionId: SESSION, sessionDir: "/ws", turn });

    expect(git.resetHardToRemoteBase).not.toHaveBeenCalled();
  });

  it("leaves a dirty tree alone and says why", async () => {
    merged();
    const git = makeGit({
      isClean: vi.fn().mockResolvedValue(false),
      uncommittedPaths: vi.fn().mockResolvedValue(["notes.txt"]),
    });
    const reg = registry(fakeRunner());

    const answer = await resetBranchAfterDirectMerge(
      deps({ git, runnerRegistry: reg }),
      { sessionId: SESSION, sessionDir: "/ws", turn: captureTurn(reg, SESSION) },
    );

    expect(git.resetHardToRemoteBase).not.toHaveBeenCalled();
    expect(answer).toContain("left on the merged commit");
    expect(answer).toContain("notes.txt");
  });

  it("waits for the merge handling before it reads the merged state", async () => {
    const git = makeGit();
    const reg = registry(fakeRunner());
    let finish!: () => void;
    const handling = new Promise<void>((resolve) => { finish = resolve; });

    const pending = resetBranchAfterDirectMerge(
      deps({ git, runnerRegistry: reg, prStatusPoller: poller(handling) }),
      { sessionId: SESSION, sessionDir: "/ws", turn: captureTurn(reg, SESSION) },
    );
    // The handling is what writes merged_at.
    merged();
    finish();
    const answer = await pending;

    expect(git.resetHardToRemoteBase).toHaveBeenCalled();
    expect(answer).toContain("moved this branch");
  });

  it("gives up waiting for the merge handling, and moves nothing", async () => {
    merged();
    const git = makeGit();
    const reg = registry(fakeRunner());

    const answer = await resetBranchAfterDirectMerge(
      deps({ git, runnerRegistry: reg, prStatusPoller: poller(new Promise<void>(() => {})) }),
      { sessionId: SESSION, sessionDir: "/ws", turn: captureTurn(reg, SESSION), mergeHandlingWaitMs: 10 },
    );

    expect(git.resetHardToRemoteBase).not.toHaveBeenCalled();
    expect(answer).toContain("could not finish recording the merge in time");
  });

  it("says the reset did not complete when the branch moved but the push failed", async () => {
    merged();
    const git = makeGit({ forcePush: vi.fn().mockRejectedValue(new Error("stale info")) });
    const runner = fakeRunner();
    const reg = registry(runner);

    const answer = await resetBranchAfterDirectMerge(
      deps({ git, runnerRegistry: reg }),
      { sessionId: SESSION, sessionDir: "/ws", turn: captureTurn(reg, SESSION) },
    );

    expect(answer).toContain("did not complete");
    expect(answer).toContain("reset locally");
    // The files did change, so the container must still hear about it.
    expect(runner.notifyWorkspaceRewritten).toHaveBeenCalled();
    expect(detectAndReArmResetSession).not.toHaveBeenCalled();
  });
});

describe("runExplicitBranchReset", () => {
  it("still says the user moved the branch when the reset came from the UI", async () => {
    merged();

    await runExplicitBranchReset(
      deps({ runnerRegistry: registry(fakeRunner({ running: false })) }),
      { sessionId: SESSION, sessionDir: "/ws" },
    );

    expect(sessions.get(SESSION)?.pendingAgentNotice).toContain("the user reset this branch");
  });
});
