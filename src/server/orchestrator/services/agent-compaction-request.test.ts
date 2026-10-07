// docs/324-agent-requested-compaction — the request, and the post-turn step that acts on it.
// The step runs against a real runner and the real dispatched-turn path, with fake agents.
import { describe, it, expect, vi, afterEach } from "vitest";
import { SessionRunnerRegistry, type QueuedMessage, type SessionRunnerInterface } from "../session-runner.js";
import type { PendingCompaction, SessionManager } from "../sessions.js";
import { turnDropped } from "../turn-settlement.js";
import { beginTurnSetup, noteUserStop } from "../turn-stop-request.js";
import { MISSED_COMPACTION_NOTICE } from "../compact-before-turn.js";
import {
  makeDispatchTurnDeps,
  flushTurn,
  waitForTurn,
  type FakeAgent,
} from "../integration_tests/dispatch-test-helpers.js";
import { ServiceError } from "./types.js";
import {
  recordCompactionRequest,
  runRequestedCompaction,
  buildInstructionsNotice,
  buildContinuationPrompt,
} from "./agent-compaction-request.js";
import { stopCompactionContinuation } from "./agent-compaction-stop.js";

const SESSION = "compact-session";

function makeSessionManager(request?: PendingCompaction, agentId = "claude") {
  const state = { request, notices: [] as string[], agentId };
  const manager = {
    get: (id: string) => (id === SESSION ? { id, workspaceDir: "/tmp/ws", agentId: state.agentId } : undefined),
    getPendingCompaction: () => state.request,
    setPendingCompaction: (_id: string, value: PendingCompaction | null) => { state.request = value ?? undefined; },
    dropPendingCompactionNote: () => {
      if (state.request?.note === undefined) return;
      state.request = state.request.instructions !== undefined ? { instructions: state.request.instructions } : {};
    },
    appendPendingCompactionNotice: (_id: string, notice: string) => { state.notices.push(notice); },
  } as unknown as SessionManager;
  return { manager, state };
}

let runner: SessionRunnerInterface | undefined;

function setup(request: PendingCompaction | undefined, opts: { agentId?: string } = {}) {
  const { manager, state } = makeSessionManager(request, opts.agentId);
  const runnerRegistry = new SessionRunnerRegistry();
  runner = runnerRegistry.getOrCreate(SESSION, "/tmp/ws", "claude");
  const agents: FakeAgent[] = [];
  const appended: { role?: string; text?: string }[] = [];
  const { deps: turnDeps } = makeDispatchTurnDeps(agents, appended);
  const prompts: string[] = [];
  const compactFlags: (boolean | undefined)[] = [];
  turnDeps.buildRunParams = vi.fn(async (_sid, _agentId, prompt, _route, buildOpts) => {
    prompts.push(prompt);
    compactFlags.push(buildOpts?.compact);
    return { prompt, cwd: "/tmp/ws" } as never;
  });
  // The production wiring: a turn's prompt takes the parked notices.
  turnDeps.consumePendingAgentNotice = () => state.notices.splice(0).join("\n\n") || undefined;
  (runner as unknown as { setSystemTurnDeps(d: unknown): void }).setSystemTurnDeps(turnDeps);
  const userNotices: string[] = [];
  const deps = {
    sessionManager: manager,
    runnerRegistry,
    chatHistoryManager: {
      append: (_sid: string, msg: { text?: string }) => { userNotices.push(msg.text ?? ""); },
    },
  };
  const turn = {
    sessionId: SESSION,
    runner,
    turnIsCurrent: () => true,
    ownsSystemHold: () => false,
    settle: vi.fn(),
  };
  return { deps, state, runner, turn, agents, prompts, compactFlags, appended, userNotices };
}

const compacted = (agent: FakeAgent | undefined) => {
  agent?.emit("event", { type: "agent_result", status: "success", sessionId: "after" });
  agent?.emit("done", 0);
};

afterEach(() => {
  runner?.dispose({ force: true });
  runner = undefined;
});

describe("recordCompactionRequest", () => {
  it("stores trimmed instructions and note, and a later request replaces it (req 1, 3, 8)", () => {
    const { manager, state } = makeSessionManager();
    const deps = { sessionManager: manager, defaultAgentId: "claude" as const };
    expect(recordCompactionRequest(deps, SESSION, { instructions: "  keep A  ", note: " start B " }))
      .toEqual({ requested: true, continues: true });
    expect(state.request).toEqual({ instructions: "keep A", note: "start B" });
    expect(recordCompactionRequest(deps, SESSION, {})).toEqual({ requested: true, continues: false });
    expect(state.request).toEqual({});
  });

  it("refuses a harness that cannot compact, and records nothing (req 7)", () => {
    const { manager, state } = makeSessionManager(undefined, "antigravity");
    let thrown: unknown;
    try {
      recordCompactionRequest({ sessionManager: manager, defaultAgentId: "claude" }, SESSION, { note: "x" });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as ServiceError).statusCode).toBe(409);
    expect(state.request).toBeUndefined();
  });

  it("refuses an unknown session, non-text fields and overlong text", () => {
    const { manager } = makeSessionManager();
    const deps = { sessionManager: manager, defaultAgentId: "claude" as const };
    expect(() => recordCompactionRequest(deps, "other", {})).toThrow(expect.objectContaining({ statusCode: 404 }));
    expect(() => recordCompactionRequest(deps, SESSION, { note: 42 })).toThrow(ServiceError);
    expect(() => recordCompactionRequest(deps, SESSION, { instructions: "x".repeat(4001) })).toThrow(ServiceError);
  });
});

describe("runRequestedCompaction — when it waits", () => {
  it("does nothing when the agent asked for no compaction", async () => {
    const { deps, turn, prompts } = setup(undefined);
    await runRequestedCompaction(deps, turn);
    await flushTurn();
    expect(prompts).toHaveLength(0);
    expect(turn.settle).not.toHaveBeenCalled();
  });

  it.each([
    ["a turn runs", (r: SessionRunnerInterface) => { r.running = true; }],
    ["a merge holds the session", (r: SessionRunnerInterface) => { r.mergeHold = true; }],
    ["another flow holds the session", (r: SessionRunnerInterface) => { r.systemTurnInProgress = true; }],
    ["the agent waits for the user's answer", (r: SessionRunnerInterface) => { r.awaitingUserAnswer = true; }],
  ])("leaves the request pending while %s", async (_label, makeBusy) => {
    const { deps, state, runner: r, turn, prompts } = setup({ instructions: "keep A" });
    makeBusy(r);
    await runRequestedCompaction(deps, turn);
    await flushTurn();
    expect(prompts).toHaveLength(0);
    expect(state.request).toEqual({ instructions: "keep A" });
    expect(state.notices).toHaveLength(0);
    r.running = false;
    r.mergeHold = false;
    r.systemTurnInProgress = false;
    r.awaitingUserAnswer = false;
  });

  it("stands down for a turn that is no longer current", async () => {
    const { deps, state, turn, prompts } = setup({ instructions: "keep A" });
    await runRequestedCompaction(deps, { ...turn, turnIsCurrent: () => false });
    await flushTurn();
    expect(prompts).toHaveLength(0);
    expect(state.request).toEqual({ instructions: "keep A" });
  });
});

describe("runRequestedCompaction — the compaction turn", () => {
  it("settles the ending turn first, then runs a silent compaction system turn (req 3, 5)", async () => {
    const { deps, state, runner: r, turn, prompts, compactFlags, appended } = setup({ instructions: "keep A" });
    // The ending turn's outcome must be read before the compaction resets the runner.
    turn.settle.mockImplementation(() => { expect(r.running).toBe(false); });
    await runRequestedCompaction(deps, turn);
    await waitForTurn(() => prompts.length === 1, "compaction spawn");

    expect(turn.settle).toHaveBeenCalledTimes(1);
    expect(prompts[0]?.startsWith("/compact keep A")).toBe(true);
    expect(compactFlags[0]).toBe(true);
    expect(r.systemTurnInProgress).toBe(true);
    expect(state.request).toBeUndefined();
    expect(appended.filter((m) => m.role === "user")).toHaveLength(0);
  });

  it("without instructions sends a bare /compact and parks nothing", async () => {
    const { deps, state, turn, prompts } = setup({});
    await runRequestedCompaction(deps, turn);
    await waitForTurn(() => prompts.length === 1, "compaction spawn");
    expect(prompts[0]?.trim()).toBe("/compact");
    expect(state.notices).toHaveLength(0);
  });

  it("a system turn's settle releases its own hold, so the compaction is admitted", async () => {
    const { deps, runner: r, turn, prompts } = setup({ instructions: "keep A" });
    r.systemTurnInProgress = true;
    turn.settle.mockImplementation(() => { r.systemTurnInProgress = false; });
    await runRequestedCompaction(deps, { ...turn, ownsSystemHold: () => true });
    await waitForTurn(() => prompts.length === 1, "compaction spawn");
  });

  it("re-checks the harness: one that can no longer compact never receives /compact (req 6)", async () => {
    const request = { instructions: "keep A", note: "start B" };
    const { deps, state, turn, prompts, userNotices } = setup(request, { agentId: "antigravity" });
    await runRequestedCompaction(deps, turn);
    await flushTurn();
    expect(prompts).toHaveLength(0);
    expect(state.request).toBeUndefined();
    expect(userNotices).toContain(MISSED_COMPACTION_NOTICE);
    // Nothing is lost: the note waits for the next turn.
    expect(state.notices).toHaveLength(1);
    expect(state.notices[0]).toContain(buildContinuationPrompt("start B"));
  });
});

describe("runRequestedCompaction — after the compaction", () => {
  it("with a note, the next turn is the continuation, carrying the instructions and the note (req 8, 9)", async () => {
    const { deps, turn, agents, prompts, compactFlags } = setup({ instructions: "keep A", note: "start B" });
    await runRequestedCompaction(deps, turn);
    await waitForTurn(() => prompts.length === 1, "compaction spawn");
    compacted(agents[0]);

    await waitForTurn(() => prompts.length === 2, "continuation spawn");
    expect(compactFlags[1]).toBeFalsy();
    expect(prompts[1]).toContain(buildInstructionsNotice("keep A"));
    expect(prompts[1]).toContain(buildContinuationPrompt("start B"));
  });

  it("continues on a compaction that reports a result and never exits, as OpenCode's does", async () => {
    const { deps, turn, agents, prompts } = setup({ note: "start B" });
    await runRequestedCompaction(deps, turn);
    await waitForTurn(() => prompts.length === 1, "compaction spawn");
    agents[0]?.emit("event", { type: "agent_result", status: "success", sessionId: "after" });

    await waitForTurn(() => prompts.length === 2, "continuation spawn");
    expect(prompts[1]).toContain("start B");
  });

  it("without a note, a message queued during the compaction runs next and takes the instructions (req 9)", async () => {
    const { deps, state, runner: r, turn, agents, prompts } = setup({ instructions: "keep A" });
    await runRequestedCompaction(deps, turn);
    await waitForTurn(() => prompts.length === 1, "compaction spawn");
    r.enqueue({ text: "USER NEXT", execution: "dispatched" } as QueuedMessage);
    compacted(agents[0]);

    await waitForTurn(() => prompts.length === 2, "user turn");
    expect(prompts[1]).toContain("USER NEXT");
    expect(prompts[1]).toContain(buildInstructionsNotice("keep A"));
    expect(state.notices).toHaveLength(0);
  });

  it("with a note, the continuation runs ahead of a message queued during the compaction", async () => {
    const { deps, runner: r, turn, agents, prompts } = setup({ note: "start B" });
    await runRequestedCompaction(deps, turn);
    await waitForTurn(() => prompts.length === 1, "compaction spawn");
    r.enqueue({ text: "USER NEXT", execution: "dispatched" } as QueuedMessage);
    compacted(agents[0]);

    await waitForTurn(() => prompts.length === 2, "next spawn");
    expect(prompts[1]).toContain("start B");
    expect(r.getQueueSnapshot().map((q) => q.text)).toEqual(["USER NEXT"]);
  });

  it("a Stop on the requesting turn compacts but does not continue (req 10)", async () => {
    const { deps, state, runner: r, turn, prompts } = setup({ instructions: "keep A", note: "start B" });
    beginTurnSetup(r);
    noteUserStop(r);
    await runRequestedCompaction(deps, turn);
    await waitForTurn(() => prompts.length === 1, "compaction spawn");
    expect(r.queueLength).toBe(0);
    expect(state.notices).toEqual([buildInstructionsNotice("keep A")]);
  });

  it("a Stop during the compaction ends the continuation, even when the stopped turn reports a result", async () => {
    const { deps, state, runner: r, turn, agents, prompts } = setup({ instructions: "keep A", note: "start B" });
    await runRequestedCompaction(deps, turn);
    await waitForTurn(() => prompts.length === 1, "compaction spawn");
    expect(r.queueLength).toBe(1);

    stopCompactionContinuation(deps.sessionManager, r);
    r.wasInterrupted = true;
    agents[0]?.emit("event", { type: "agent_result", status: "error", sessionId: "after", error: "interrupted" });
    agents[0]?.emit("done", 143);
    await flushTurn();
    await flushTurn();

    expect(prompts).toHaveLength(1);
    expect(r.queueLength).toBe(0);
    // The instructions still reach the user's next turn.
    expect(state.notices).toEqual([buildInstructionsNotice("keep A")]);
  });

  it("parks the note when the continuation never reaches the agent", async () => {
    const { deps, state, runner: r, turn, prompts } = setup({ note: "start B" });
    await runRequestedCompaction(deps, turn);
    await waitForTurn(() => prompts.length === 1, "compaction spawn");
    r.messageQueue[0]?.onTurnComplete?.(turnDropped("runner disposed"));
    expect(state.notices).toEqual([`[System] ${buildContinuationPrompt("start B")}`]);
  });
});
