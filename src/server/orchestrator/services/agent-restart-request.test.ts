import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionRunner, SessionRunnerRegistry, type SessionRunnerInterface } from "../session-runner.js";
import type { SessionManager } from "../sessions.js";
import type { SessionContainerManager } from "../session-container.js";
import type { WakeSessionDeps, WakeTurnOptions } from "../wake-session.js";
import { turnDropped, TURN_COMPLETED, type TurnHandle } from "../turn-settlement.js";
import { ServiceError } from "./types.js";
import type { QueueHold, RestartAgentOpts, RecoveryDeps } from "./recovery.js";

const restartAgent = vi.fn();
const wakeSessionWithTurn = vi.fn();
vi.mock("./recovery.js", () => ({
  restartAgent: (deps: RecoveryDeps, id: string, opts: RestartAgentOpts) => restartAgent(deps, id, opts),
}));
vi.mock("../wake-session.js", () => ({
  wakeSessionWithTurn: (deps: WakeSessionDeps, session: unknown, opts: WakeTurnOptions) =>
    wakeSessionWithTurn(deps, session, opts),
}));

const { recordRestartRequest, runRequestedRestart, buildRestartFollowupPrompt } =
  await import("./agent-restart-request.js");

const SESSION = "restart-session";

function makeSessionManager(note?: string) {
  const state = { note, notices: [] as string[] };
  const manager = {
    get: (id: string) => (id === SESSION ? { id, workspaceDir: "/tmp/ws" } : undefined),
    getPendingRestartNote: () => state.note,
    setPendingRestartNote: (_id: string, value: string | null) => { state.note = value ?? undefined; },
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
  };
  return { deps, state, runner, runnerRegistry, turn };
}

function replacementHold(): QueueHold {
  const replacement = new SessionRunner({ sessionId: SESSION, sessionDir: "/tmp/ws", defaultAgentId: "claude" });
  replacement.systemTurnInProgress = true;
  return { runner: replacement, seq: replacement.systemHoldSeq };
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
