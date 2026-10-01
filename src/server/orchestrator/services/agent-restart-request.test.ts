import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionRunner, SessionRunnerRegistry, type SessionRunnerInterface } from "../session-runner.js";
import type { SessionManager } from "../sessions.js";
import type { SessionContainerManager } from "../session-container.js";
import type { WakeSessionDeps, WakeTurnOptions } from "../wake-session.js";
import { turnDropped, TURN_COMPLETED, type TurnHandle } from "../turn-settlement.js";
import { ServiceError } from "./types.js";
import { takeQueueHold, type QueueHold, type RestartAgentOpts, type RecoveryDeps } from "./recovery.js";
import type * as RecoveryModuleNs from "./recovery.js";

type RecoveryModule = typeof RecoveryModuleNs;

const restartAgent = vi.fn();
const wakeSessionWithTurn = vi.fn();
vi.mock("./recovery.js", async (importOriginal) => ({
  ...(await importOriginal<RecoveryModule>()),
  restartAgent: (deps: RecoveryDeps, id: string, opts: RestartAgentOpts) => restartAgent(deps, id, opts),
}));
vi.mock("../wake-session.js", () => ({
  wakeSessionWithTurn: (deps: WakeSessionDeps, session: unknown, opts: WakeTurnOptions) =>
    wakeSessionWithTurn(deps, session, opts),
}));

const { recordRestartRequest, deferRestartToTurnEnd, runRequestedRestart, buildRestartFollowupPrompt } =
  await import("./agent-restart-request.js");

const SESSION = "restart-session";

function makeSessionManager(note?: string) {
  const state = { note, userAsked: false, notices: [] as string[] };
  const manager = {
    get: (id: string) => (id === SESSION ? { id, workspaceDir: "/tmp/ws" } : undefined),
    getPendingRestartNote: () => state.note,
    setPendingRestartNote: (_id: string, value: string | null) => { state.note = value ?? undefined; },
    hasPendingUserRestart: () => state.userAsked,
    setPendingUserRestart: (_id: string, pending: boolean) => { state.userAsked = pending; },
    clearPendingRestart: () => { state.note = undefined; state.userAsked = false; },
    appendPendingAgentNotice: (_id: string, notice: string) => { state.notices.push(notice); },
  } as unknown as SessionManager;
  return { manager, state };
}

function setup(note: string | null = "check node -v") {
  const { manager, state } = makeSessionManager(note ?? undefined);
  const runnerRegistry = new SessionRunnerRegistry();
  const runner = runnerRegistry.getOrCreate(SESSION, "/tmp/ws", "claude");
  const deps: WakeSessionDeps = {
    sessionManager: manager,
    runnerRegistry,
    defaultAgentId: "claude",
    containerManager: {} as SessionContainerManager,
  };
  const turn = {
    sessionId: SESSION,
    runner,
    turnIsCurrent: () => true,
    ownsSystemHold: () => false,
    settle: vi.fn(),
  };
  return { deps, state, runner, runnerRegistry, turn };
}

function replacementHold(): QueueHold {
  const replacement = new SessionRunner({ sessionId: SESSION, sessionDir: "/tmp/ws", defaultAgentId: "claude" });
  return takeQueueHold(replacement, { lease: true });
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  restartAgent.mockReset();
  wakeSessionWithTurn.mockReset();
});

describe("recordRestartRequest", () => {
  const containerManager = {} as SessionContainerManager;

  it("stores the trimmed note, and a later request replaces it", () => {
    const { manager, state } = makeSessionManager();
    recordRestartRequest({ sessionManager: manager, containerManager }, SESSION, "  first  ");
    recordRestartRequest({ sessionManager: manager, containerManager }, SESSION, "second");
    expect(state.note).toBe("second");
  });

  it("refuses an empty note: the agent continues from it", () => {
    const { manager, state } = makeSessionManager();
    for (const empty of ["", "   ", undefined, 42]) {
      expect(() => recordRestartRequest({ sessionManager: manager, containerManager }, SESSION, empty))
        .toThrow(ServiceError);
    }
    expect(state.note).toBeUndefined();
  });

  it("refuses with 503 where there is no container to restart", () => {
    const { manager, state } = makeSessionManager();
    let thrown: unknown;
    try {
      recordRestartRequest({ sessionManager: manager, containerManager: null }, SESSION, "x");
    } catch (err) {
      thrown = err;
    }
    expect((thrown as ServiceError).statusCode).toBe(503);
    expect(state.note).toBeUndefined();
  });

  it("refuses an unknown session with 404", () => {
    const { manager } = makeSessionManager();
    expect(() => recordRestartRequest({ sessionManager: manager, containerManager }, "other", "x"))
      .toThrow(expect.objectContaining({ statusCode: 404 }));
  });
});

describe("runRequestedRestart — when it waits", () => {
  it("does nothing when the agent asked for no restart", async () => {
    const { deps, turn } = setup(null);
    await runRequestedRestart(deps, turn);
    expect(restartAgent).not.toHaveBeenCalled();
  });

  it("ignores a late callback from an older turn: its runner is no longer the session's", async () => {
    const { deps, state, turn } = setup();
    const stale = new SessionRunner({ sessionId: SESSION, sessionDir: "/tmp/ws", defaultAgentId: "claude" });
    await runRequestedRestart(deps, { ...turn, runner: stale });
    expect(restartAgent).not.toHaveBeenCalled();
    expect(state.note).toBe("check node -v");
  });

  it("ignores a turn that is no longer current", async () => {
    const { deps, state, turn } = setup();
    await runRequestedRestart(deps, { ...turn, turnIsCurrent: () => false });
    expect(restartAgent).not.toHaveBeenCalled();
    expect(state.note).toBe("check node -v");
  });

  it.each([
    ["a drained turn is running", (r: SessionRunnerInterface) => { r.running = true; }],
    ["a merge holds the session", (r: SessionRunnerInterface) => { r.mergeHold = true; }],
    ["another flow holds the session", (r: SessionRunnerInterface) => { r.systemTurnInProgress = true; }],
  ])("keeps the request for the next turn's end when %s", async (_label, occupy) => {
    const { deps, state, runner, turn } = setup();
    occupy(runner);
    await runRequestedRestart(deps, turn);
    expect(restartAgent).not.toHaveBeenCalled();
    expect(state.note).toBe("check node -v");
  });
});

describe("runRequestedRestart — the restart", () => {
  it("holds new messages before the restart starts, and carries the queue", async () => {
    const { deps, state, runner, turn } = setup();
    let heldDuringRestart = false;
    restartAgent.mockImplementation(async (_deps: RecoveryDeps, _id: string, opts: RestartAgentOpts) => {
      heldDuringRestart = runner.systemTurnInProgress;
      expect(opts).toEqual({ carryQueue: true });
      return { ok: true, noContainer: false, newContainerState: "running", error: null, held: replacementHold() };
    });
    wakeSessionWithTurn.mockResolvedValue({} as TurnHandle);

    await runRequestedRestart(deps, turn);

    expect(heldDuringRestart).toBe(true);
    expect(state.note).toBeUndefined();
  });

  it("settles the ending turn before the restart disposes its runner", async () => {
    const { deps, runner, turn } = setup();
    let settledBeforeRestart = false;
    restartAgent.mockImplementation(async () => {
      settledBeforeRestart = turn.settle.mock.calls.length === 1 && !runner.disposed;
      return { ok: true, noContainer: false, newContainerState: "running", error: null };
    });
    wakeSessionWithTurn.mockResolvedValue({} as TurnHandle);

    await runRequestedRestart(deps, turn);

    expect(settledBeforeRestart).toBe(true);
  });

  it("a failed clear of the request takes no hold, so nothing stays queued for ever", async () => {
    const { deps, runner, turn } = setup();
    (deps.sessionManager as unknown as { clearPendingRestart: () => void }).clearPendingRestart = () => {
      throw new Error("SQLITE_FULL");
    };

    await expect(runRequestedRestart(deps, turn)).rejects.toThrow("SQLITE_FULL");

    expect(runner.systemTurnInProgress).toBe(false);
    expect(restartAgent).not.toHaveBeenCalled();
  });

  it("restarts when the ending turn's own system hold is the only hold", async () => {
    const { deps, runner, turn } = setup();
    runner.systemTurnInProgress = true;
    restartAgent.mockResolvedValue({ ok: true, noContainer: false, newContainerState: "running", error: null });
    wakeSessionWithTurn.mockResolvedValue({} as TurnHandle);

    await runRequestedRestart(deps, { ...turn, ownsSystemHold: () => true });

    expect(restartAgent).toHaveBeenCalledTimes(1);
  });

  it("does not reset the OOM breaker or the loop detector, which the button does", async () => {
    const { deps, turn } = setup();
    restartAgent.mockResolvedValue({ ok: true, noContainer: false, newContainerState: "running", error: null });
    wakeSessionWithTurn.mockResolvedValue({} as TurnHandle);

    await runRequestedRestart(deps, turn);

    const recoveryDeps = restartAgent.mock.calls[0]![0] as RecoveryDeps;
    expect(recoveryDeps.oomBreaker).toBeUndefined();
    expect(recoveryDeps.loopDetector).toBeUndefined();
  });

  it("wakes the new container with the note, releasing the hold for that turn only", async () => {
    const { deps, turn } = setup();
    const held = replacementHold();
    restartAgent.mockResolvedValue({ ok: true, noContainer: false, newContainerState: "running", error: null, held });
    wakeSessionWithTurn.mockResolvedValue({} as TurnHandle);

    await runRequestedRestart(deps, turn);
    await settle();

    const opts = wakeSessionWithTurn.mock.calls[0]![2] as WakeTurnOptions;
    expect(opts.text).toBe(buildRestartFollowupPrompt("check node -v"));
    expect(opts.text).toContain("check node -v");
    expect(opts.releaseHold).toBe(held);
  });

  it("parks the follow-up prompt when the wake turn never reaches the agent", async () => {
    const { deps, state, turn } = setup();
    restartAgent.mockResolvedValue({ ok: true, noContainer: false, newContainerState: "running", error: null });
    wakeSessionWithTurn.mockImplementation(async (_d: unknown, _s: unknown, opts: WakeTurnOptions) => {
      opts.onSettled?.(turnDropped("runner disposed mid-turn"));
      return {} as TurnHandle;
    });

    await runRequestedRestart(deps, turn);
    await settle();

    expect(state.notices).toEqual([`[System] ${buildRestartFollowupPrompt("check node -v")}`]);
  });

  it("parks nothing when the wake turn ran", async () => {
    const { deps, state, turn } = setup();
    restartAgent.mockResolvedValue({ ok: true, noContainer: false, newContainerState: "running", error: null });
    wakeSessionWithTurn.mockImplementation(async (_d: unknown, _s: unknown, opts: WakeTurnOptions) => {
      opts.onSettled?.(TURN_COMPLETED);
      return {} as TurnHandle;
    });

    await runRequestedRestart(deps, turn);
    await settle();

    expect(state.notices).toEqual([]);
  });
});

describe("the user's Restart after turn (docs/242-stale-session-container-indicator req 9)", () => {
  const containerManager = {} as SessionContainerManager;
  const running = { ok: true, noContainer: false, newContainerState: "running", error: null };

  it("records the request only while a turn runs", () => {
    const { deps, state, runner, runnerRegistry } = setup(null);
    const deferDeps = { sessionManager: deps.sessionManager, containerManager, runnerRegistry };

    expect(deferRestartToTurnEnd(deferDeps, SESSION)).toBe(false);
    expect(state.userAsked).toBe(false);

    runner.running = true;
    expect(deferRestartToTurnEnd(deferDeps, SESSION)).toBe(true);
    expect(state.userAsked).toBe(true);
  });

  it("does not record where there is no container to restart", () => {
    const { deps, state, runner, runnerRegistry } = setup(null);
    runner.running = true;
    const deferDeps = { sessionManager: deps.sessionManager, containerManager: null, runnerRegistry };
    expect(deferRestartToTurnEnd(deferDeps, SESSION)).toBe(false);
    expect(state.userAsked).toBe(false);
  });

  it("restarts at the turn's end, carries the queue, and starts no follow-up turn", async () => {
    const { deps, state, turn } = setup(null);
    state.userAsked = true;
    const held = replacementHold();
    restartAgent.mockResolvedValue({ ...running, held });

    await runRequestedRestart(deps, turn);
    await settle();

    expect(restartAgent.mock.calls[0]![2]).toEqual({ carryQueue: true });
    expect(state.userAsked).toBe(false);
    expect(wakeSessionWithTurn).not.toHaveBeenCalled();
    expect(held.runner.systemTurnInProgress).toBe(false);
    expect(held.runner.postTurnWorkInFlight).toBe(false);
  });

  it("gives the agent its note when both asked, in one restart", async () => {
    const { deps, state, turn } = setup();
    state.userAsked = true;
    restartAgent.mockResolvedValue(running);
    wakeSessionWithTurn.mockResolvedValue({} as TurnHandle);

    await runRequestedRestart(deps, turn);
    await settle();

    expect(restartAgent).toHaveBeenCalledTimes(1);
    expect(wakeSessionWithTurn).toHaveBeenCalledTimes(1);
    expect(state.userAsked).toBe(false);
  });

  it("waits while the agent's background work runs, which the agent's own request does not", async () => {
    const { deps, state, runner, turn } = setup(null);
    state.userAsked = true;
    runner.isStreamingActive = true;
    runner.setBackgroundTasks([{ id: "review" }]);

    await runRequestedRestart(deps, turn);
    expect(restartAgent).not.toHaveBeenCalled();
    expect(state.userAsked).toBe(true);

    state.note = "check node -v";
    restartAgent.mockResolvedValue(running);
    wakeSessionWithTurn.mockResolvedValue({} as TurnHandle);
    await runRequestedRestart(deps, turn);
    expect(restartAgent).toHaveBeenCalledTimes(1);
  });

  it("a failed restart parks no notice for the agent and releases the holds", async () => {
    const { deps, state, runner, turn } = setup(null);
    state.userAsked = true;
    restartAgent.mockRejectedValue(new Error("worker gone"));

    await runRequestedRestart(deps, turn);

    expect(state.notices).toEqual([]);
    expect(runner.systemTurnInProgress).toBe(false);
  });
});

describe("runRequestedRestart — failure", () => {
  it("a restart that throws parks the note and releases the hold it took", async () => {
    const { deps, state, runner, turn } = setup();
    restartAgent.mockRejectedValue(new Error("worker gone"));

    await runRequestedRestart(deps, turn);

    expect(state.notices).toHaveLength(1);
    expect(state.notices[0]).toContain("worker gone");
    expect(state.notices[0]).toContain("check node -v");
    expect(runner.systemTurnInProgress).toBe(false);
    expect(wakeSessionWithTurn).not.toHaveBeenCalled();
  });

  it("a replacement that could not be created parks the note and releases the carried queue", async () => {
    const { deps, state, turn } = setup();
    const held = replacementHold();
    restartAgent.mockResolvedValue({
      ok: true, noContainer: false, newContainerState: "missing", error: "no image", held,
    });

    await runRequestedRestart(deps, turn);

    expect(state.notices[0]).toContain("no image");
    expect(held.runner.systemTurnInProgress).toBe(false);
    expect(held.runner.postTurnWorkInFlight).toBe(false);
    expect(wakeSessionWithTurn).not.toHaveBeenCalled();
  });

  it("a wake that throws parks the note and releases the hold", async () => {
    const { deps, state, turn } = setup();
    const held = replacementHold();
    restartAgent.mockResolvedValue({ ok: true, noContainer: false, newContainerState: "running", error: null, held });
    wakeSessionWithTurn.mockRejectedValue(new Error("container could not be resumed"));

    await runRequestedRestart(deps, turn);
    await settle();

    expect(state.notices[0]).toContain("container could not be resumed");
    expect(held.runner.systemTurnInProgress).toBe(false);
    expect(held.runner.postTurnWorkInFlight).toBe(false);
  });

  it("leaves a hold alone that changed hands since", async () => {
    const { deps, turn } = setup();
    const held = replacementHold();
    held.runner.systemTurnInProgress = true; // another flow takes the hold over
    restartAgent.mockResolvedValue({ ok: true, noContainer: false, newContainerState: "running", error: null, held });
    wakeSessionWithTurn.mockRejectedValue(new Error("boom"));

    await runRequestedRestart(deps, turn);
    await settle();

    expect(held.runner.systemTurnInProgress).toBe(true);
  });
});
