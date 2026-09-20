import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { SessionRunner } from "./session-runner.js";
import type { SystemTurnDeps } from "./session-runner.js";
import type { AgentId, SessionStatus } from "../shared/types.js";
import { formatSessionStatusContext, recordSessionStatus } from "./services/session-status.js";
import type { SessionStatusDeps } from "./services/session-status.js";
import { testDispatch } from "./integration_tests/dispatch-test-helpers.js";

interface FakeAgent extends EventEmitter {
  run: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
  sendUserMessage: ReturnType<typeof vi.fn>;
}

function makeFakeAgent(): FakeAgent {
  const agent = new EventEmitter() as FakeAgent;
  agent.run = vi.fn();
  agent.kill = vi.fn();
  agent.setPermissionMode = vi.fn();
  agent.sendUserMessage = vi.fn();
  return agent;
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 0));
}

async function waitFor(fn: () => boolean, label = "condition", timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await flush();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function harness(opts: {
  statusCardEnabled?: boolean | (() => boolean);
  streaming?: boolean;
  card?: SessionStatus;
  /** Commit indices to park on, to observe what the terminal sequence has done before them. */
  holdCommits?: number[];
} = {}) {
  const cards = new Map<string, SessionStatus | undefined>();
  if (opts.card) cards.set("s1", opts.card);
  const state = { readThrows: false, commits: 0, entered: [] as number[], preTurnResets: 0 };
  let preTurnReset: ((call: number) => Promise<{ agentPrefix: string }>) | null = null;
  let prepareEnv: (() => Promise<void>) | null = null;
  const gates = new Map<number, { parked: Promise<void>; release: () => void }>();
  const gateFor = (index: number) => {
    let release = (): void => {};
    const parked = new Promise<void>((resolve) => { release = resolve; });
    const gate = gates.get(index) ?? { parked, release };
    gates.set(index, gate);
    return gate;
  };
  const sessionManager = {
    setAgentSessionId: vi.fn(),
    setLastTurnErrored: vi.fn(),
    get: (id: string) => {
      if (state.readThrows) throw new Error("database connection is not open");
      return { id, sessionStatus: cards.get(id) };
    },
    track: vi.fn(),
    setMuted: vi.fn(),
    list: () => [],
    setSessionStatus: (id: string, status: SessionStatus | null) => {
      cards.set(id, status ?? undefined);
    },
    sessionIdsWithStatus: () => [...cards.keys()],
  };

  const agents: FakeAgent[] = [];
  const prompts: string[] = [];
  const emitted: { type: string; text?: string }[] = [];
  const rows: { role: string; text: string }[] = [];
  const appendRow = vi.fn((_id: string, row: { role: string; text: string }) => { rows.push(row); });
  const runner = new SessionRunner({
    sessionId: "s1",
    sessionDir: "/tmp/status-settlement",
    defaultAgentId: "claude" as AgentId,
  });

  const deps: SystemTurnDeps = {
    agentFactory: () => {
      const a = makeFakeAgent();
      agents.push(a);
      return a as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
    },
    autoCommit: async () => ({
      commitHash: null,
      parentHash: null,
      conflictedFiles: [],
      rebaseInProgress: false,
      secretFindings: [],
      unreadable: null,
    }),
    // The real post-turn commit, which the executor prefers over `autoCommit`.
    commitTurn: async () => {
      const index = state.commits;
      state.entered.push(index);
      if (opts.holdCommits?.includes(index)) await gateFor(index).parked;
      state.commits += 1;
      return null;
    },
    scheduleAutoPush: vi.fn(),
    // The window the executor is already listening in: its agent listeners are wired
    // before this runs, so a turn the CLI starts here is one the prompt goes in behind.
    prepareAgentEnv: (async () => {
      if (prepareEnv) await prepareEnv();
      return undefined;
    }) as never,
    preTurnReset: async () => {
      state.preTurnResets += 1;
      return preTurnReset ? await preTurnReset(state.preTurnResets) : { agentPrefix: "" };
    },
    statusCardEnabled: () =>
      (typeof opts.statusCardEnabled === "function"
        ? opts.statusCardEnabled()
        : opts.statusCardEnabled) ?? true,
    // req 38 — the ask rides this, so the prompts below are what the agent actually reads.
    sessionStatusContext: () => formatSessionStatusContext(cards.get("s1")),
    ...(opts.streaming ? { steerInputs: () => ({ liveSteering: true, steeringCapable: true }) } : {}),
    listenerDeps: {
      sessionManager: sessionManager as never,
      chatHistoryManager: {
        replaceInProgress: vi.fn(),
        finalizeInProgress: vi.fn(),
        append: appendRow,
        updateLastMessage: vi.fn().mockReturnValue(null),
        indexOfMessageId: vi.fn().mockReturnValue(-1),
      } as never,
      usageManager: { record: vi.fn(), getSessionUsage: vi.fn(), getSessionTokenTotals: vi.fn() } as never,
      sseBroadcast: vi.fn(),
      broadcastLog: vi.fn(),
      getSelectedModel: () => undefined,
    },
    buildRunParams: vi.fn(async (_sessionId: string, _agentId: AgentId, prompt: string) => {
      prompts.push(prompt);
      return { prompt, cwd: "/tmp/status-settlement" };
    }) as never,
  };
  runner.setSystemTurnDeps(deps);

  const statusDeps: SessionStatusDeps = {
    sessionManager: sessionManager as unknown as SessionStatusDeps["sessionManager"],
    sseBroadcast: vi.fn(),
  };

  /** What the route does on an accepted `session_status` call. */
  const agentWritesCard = async (status: string): Promise<void> => {
    runner.statusUpdated = true;
    await recordSessionStatus(statusDeps, "s1", { status });
  };

  runner.on("message", (msg) => emitted.push(msg as { type: string; text?: string }));

  return {
    runner,
    agents,
    prompts,
    emitted,
    rows,
    state,
    setPreTurnReset: (fn: (call: number) => Promise<{ agentPrefix: string }>) => { preTurnReset = fn; },
    setPrepareEnv: (fn: () => Promise<void>) => { prepareEnv = fn; },
    parkedOn: (index: number) => state.entered.includes(index) && state.commits === index,
    releaseCommit: (index = 0) => gateFor(index).release(),
    card: () => cards.get("s1"),
    /** Prompts that carried the miss notice (req 38); no turn of ShipIt's own carries it. */
    asks: () => prompts.filter((p) => p.includes("ended without a status-card update")),
    agentWritesCard,
  };
}

const seeded: SessionStatus = { status: "Routes done.", actions: [], fresh: true, writeSeq: 1, turnSeq: 0 };

function finishTurn(agent: FakeAgent): void {
  agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
  agent.emit("done", 0);
}


/** An ordinary turn: prose, no tool call — the shape the drift report counts as text-only. */
function textOnlyTurn(agent: FakeAgent): void {
  agent.emit("event", {
    type: "agent_assistant",
    content: [{ type: "text", text: "Everything is good." }],
  });
  finishTurn(agent);
}

describe("settleTurnFacts and the status-card ask (docs/303 req 11–15, 38)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("marks the card stale and puts the ask in the NEXT turn's prompt, spending no turn", async () => {
    const h = harness({ card: { ...seeded } });

    h.runner.dispatch(testDispatch({ text: "do the thing" }));
    await waitFor(() => h.agents.length === 1, "turn started");
    finishTurn(h.agents[0]!);
    await waitFor(() => !h.card()!.fresh, "the card went stale");
    await flush();

    // No turn of ShipIt's own, and nothing echoed into the conversation.
    expect(h.agents).toHaveLength(1);
    expect(h.asks()).toHaveLength(0);
    expect(h.rows.some((r) => r.text.startsWith("[ShipIt] The last turn ended"))).toBe(false);
    expect(h.card()!.nudgePending).toBe(true);

    h.runner.dispatch(testDispatch({ text: "and now this" }));
    await waitFor(() => h.agents.length === 2, "the next ordinary turn started");
    expect(h.asks()).toHaveLength(1);
    expect(h.prompts[1]).toContain("and now this");

    finishTurn(h.agents[1]!);
    await waitFor(() => !h.runner.running, "turn 2 finished");
    h.runner.dispose({ force: true });
  });

  /*
    The drift report's "text-only" class: a turn the agent answers in prose with no tool
    call at all. Nothing in the settlement reads the turn's tool use, so this turn is
    asked exactly as a working one is — which is why the class cannot be one gate.
  */
  it("asks a turn that used no tool at all (the report's text-only shape)", async () => {
    const h = harness({ card: { ...seeded } });

    h.runner.dispatch(testDispatch({ text: "is it done?" }));
    await waitFor(() => h.agents.length === 1, "turn started");
    textOnlyTurn(h.agents[0]!);
    await waitFor(() => h.card()!.nudgePending === true, "the ask was recorded");

    expect(h.card()!.fresh).toBe(false);
    h.runner.dispose({ force: true });
  });

  /*
    req 38 — the gate that swallowed a steered turn (req 34) was there because the nudge
    was a system turn that would retire the resident process holding the unread message.
    The ask is a line in a prompt, so it preempts nothing and the miss is not dropped.
  */
  it("asks a turn a message reached after it started, and starts nothing (req 34, 38)", async () => {
    const h = harness({ card: { ...seeded }, streaming: true });

    h.runner.dispatch(testDispatch({ text: "first" }));
    await waitFor(() => h.agents.length === 1, "turn started");
    h.runner.steeredMessages = [{ text: "actually, do this instead" } as never];
    h.agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => h.card()!.nudgePending === true, "the ask was recorded");

    expect(h.agents).toHaveLength(1);
    expect(h.agents[0]!.kill).not.toHaveBeenCalled();
    h.runner.dispose({ force: true });
  });

  /*
    The other gate that dropped a miss silently: a system turn is refused outright while
    the resident CLI has background work, and the refusal logged nothing.
  */
  it("asks a turn whose resident agent has background work in flight (req 38)", async () => {
    const h = harness({ card: { ...seeded }, streaming: true });

    h.runner.dispatch(testDispatch({ text: "kick off the build" }));
    await waitFor(() => h.agents.length === 1, "turn started");
    h.runner.setBackgroundTasks([{ id: "bg-1", description: "npm test" } as never]);
    h.agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => h.card()!.nudgePending === true, "the ask was recorded");

    expect(h.agents).toHaveLength(1);
    h.runner.dispose({ force: true });
  });

  it("asks a turn the user stopped, which did the session's work (req 38)", async () => {
    const h = harness({ card: { ...seeded } });

    h.runner.dispatch(testDispatch({ text: "do the thing" }));
    await waitFor(() => h.agents.length === 1, "turn started");
    // What the Stop button sets. It is not a question card, so req 13 does not cover it.
    h.runner.wasInterrupted = true;
    finishTurn(h.agents[0]!);
    await waitFor(() => h.card()!.nudgePending === true, "the ask was recorded");

    h.runner.dispose({ force: true });
  });

  it("does not ask a turn that ended with a question or a plan to approve (req 13)", async () => {
    const h = harness({ card: { ...seeded } });

    h.runner.dispatch(testDispatch({ text: "ask a question" }));
    await waitFor(() => h.agents.length === 1, "turn started");
    h.runner.awaitingUserAnswer = true;
    h.runner.wasInterrupted = true;
    finishTurn(h.agents[0]!);
    await waitFor(() => !h.runner.running, "turn finished");
    await flush();

    // The card still says it may be behind (req 14); it is only the ask that is withheld.
    expect(h.card()!.fresh).toBe(false);
    expect(h.card()!.nudgePending).toBeUndefined();
    h.runner.dispose({ force: true });
  });

  it("carries one ask, however many turns miss in a row", async () => {
    const h = harness({ card: { ...seeded } });

    h.runner.dispatch(testDispatch({ text: "first" }));
    await waitFor(() => h.agents.length === 1, "turn 1 started");
    finishTurn(h.agents[0]!);
    await waitFor(() => h.card()!.nudgePending === true, "the first ask");

    h.runner.dispatch(testDispatch({ text: "second" }));
    await waitFor(() => h.agents.length === 2, "turn 2 started");
    finishTurn(h.agents[1]!);
    await waitFor(() => !h.runner.running, "turn 2 finished");
    await flush();

    expect(h.asks()).toHaveLength(1);
    expect(h.card()!.nudgePending).toBe(true);
    expect(h.agents).toHaveLength(2);
    h.runner.dispose({ force: true });
  });

  it("does not ask a turn that wrote the card, and leaves it current", async () => {
    const h = harness({ card: { ...seeded } });

    h.runner.dispatch(testDispatch({ text: "do the thing" }));
    await waitFor(() => h.agents.length === 1, "turn started");
    await h.agentWritesCard("Ready to merge.");
    finishTurn(h.agents[0]!);
    await waitFor(() => !h.runner.running, "turn finished");
    await flush();

    expect(h.agents).toHaveLength(1);
    expect(h.card()).toMatchObject({ status: "Ready to merge.", fresh: true });
    expect(h.card()!.nudgePending).toBeUndefined();
    // req 40 — the turn is counted even though it wrote, so the ages stay in turns.
    expect(h.card()!.turnSeq).toBe(1);
    h.runner.dispose({ force: true });
  });

  it("a predecessor settling after its successor wrote leaves the card current", async () => {
    const h = harness({ card: { ...seeded }, streaming: true });

    h.runner.dispatch(testDispatch({ text: "first" }));
    await waitFor(() => h.agents.length === 1, "turn 1 started");
    h.runner.dispatch(testDispatch({ text: "second", systemTurn: true }));
    expect(h.runner.queueLength).toBe(1);

    h.agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => h.agents.length === 2, "turn 2 started");

    await h.agentWritesCard("Ready to merge.");
    finishTurn(h.agents[1]!);
    await waitFor(() => !h.runner.running, "turn 2 finished");

    h.runner.dispatch(testDispatch({ text: "third" }));
    await waitFor(() => h.agents.length === 3, "turn 3 started");

    h.agents[0]!.emit("done", 0);
    await flush();
    await flush();

    expect(h.card()).toMatchObject({ status: "Ready to merge.", fresh: true });
    expect(h.card()!.nudgePending).toBeUndefined();

    finishTurn(h.agents[2]!);
    await waitFor(() => !h.runner.running, "turn 3 finished");
    h.runner.dispose({ force: true });
  });

  it("a streaming turn's agent_result and done settle ONCE, so the turn is counted once", async () => {
    const h = harness({ card: { ...seeded }, streaming: true });

    h.runner.dispatch(testDispatch({ text: "do the thing" }));
    await waitFor(() => h.agents.length === 1, "turn started");

    h.agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => h.card()!.nudgePending === true, "the ask was recorded");
    h.agents[0]!.emit("done", 0);
    await flush();
    await flush();

    expect(h.card()!.turnSeq).toBe(1);
    h.runner.dispose({ force: true });
  });

  it("with the setting off, nothing is marked and nothing is asked", async () => {
    const h = harness({ statusCardEnabled: false, card: { ...seeded } });

    h.runner.dispatch(testDispatch({ text: "do the thing" }));
    await waitFor(() => h.agents.length === 1, "turn started");
    finishTurn(h.agents[0]!);
    await waitFor(() => !h.runner.running, "turn finished");
    await flush();

    expect(h.agents).toHaveLength(1);
    expect(h.card()!.fresh).toBe(true);
    expect(h.card()!.nudgePending).toBeUndefined();
    expect(h.card()!.turnSeq).toBe(0);
  });

  /**
   * req 36 — the settlement reads what the turn DID, not who started it. A compaction is
   * left out entirely: not marked, not counted, not asked about.
   */
  for (const [label, extra] of [
    ["ShipIt's own, before a post-merge turn", { systemTurn: true, silent: true }],
    ["one the user asked for", {}],
  ] as const) {
    it(`leaves a compaction out of the settlement entirely — ${label} (req 36)`, async () => {
      const h = harness({ card: { ...seeded } });

      h.runner.dispatch(testDispatch({ text: "/compact", ...extra }));
      await waitFor(() => h.agents.length === 1, "compaction started");
      finishTurn(h.agents[0]!);
      await waitFor(() => !h.runner.running, "compaction finished");
      await flush();

      expect(h.agents).toHaveLength(1);
      expect(h.card()).toMatchObject({ fresh: true, turnSeq: 0 });
      expect(h.card()!.nudgePending).toBeUndefined();
      h.runner.dispose({ force: true });
    });
  }

  it("checks a compaction command that arrives wrapped as another session's message (req 36)", async () => {
    const h = harness({ card: { ...seeded } });

    h.runner.dispatch(testDispatch({
      text: "/compact",
      messageOrigin: { sessionId: "parent-1", sessionTitle: "Parent session", relation: "parent" },
    }));
    await waitFor(() => h.agents.length === 1, "the message turn started");
    finishTurn(h.agents[0]!);
    await waitFor(() => h.card()!.nudgePending === true, "the ask was recorded");

    expect(h.card()!.fresh).toBe(false);
    h.runner.dispose({ force: true });
  });

  it("still checks a ShipIt-started turn that is not a harness command (req 36)", async () => {
    const h = harness({ card: { ...seeded } });

    h.runner.dispatch(testDispatch({
      text: "[ShipIt] The pull request for this session was merged.",
      systemTurn: true,
    }));
    await waitFor(() => h.agents.length === 1, "the wake started");
    finishTurn(h.agents[0]!);
    await waitFor(() => h.card()!.nudgePending === true, "the ask was recorded");

    expect(h.card()!.fresh).toBe(false);
    h.runner.dispose({ force: true });
  });

  it("does not ask a driver-owned turn (postTurn: none)", async () => {
    const h = harness({ card: { ...seeded } });

    h.runner.dispatch(testDispatch({ text: "rebase step", systemTurn: true, postTurn: "none" }));
    await waitFor(() => h.agents.length === 1, "turn started");
    finishTurn(h.agents[0]!);
    await waitFor(() => !h.runner.running, "turn finished");
    await flush();

    // It did real work, so the card is marked; only the ask is withheld.
    expect(h.card()!.fresh).toBe(false);
    expect(h.card()!.nudgePending).toBeUndefined();
    h.runner.dispose({ force: true });
  });

  // Invariant 3: the snapshot runs at the head of the terminal sequence, before the hold
  // and outside `postTurnStep`, so it must not be able to abandon the commit behind it.
  it("commits even when reading the stored card throws", async () => {
    const h = harness({ card: { ...seeded } });

    h.runner.dispatch(testDispatch({ text: "do the thing" }));
    await waitFor(() => h.agents.length === 1, "turn started");
    h.state.readThrows = true;
    finishTurn(h.agents[0]!);
    await waitFor(() => !h.runner.running, "turn finished");
    await flush();

    expect(h.state.commits).toBe(1);
  });

  // The mark is immediate: the card must never read as current while the rest of the
  // terminal sequence is still running.
  it("marks the card stale before the commit that follows in the same sequence", async () => {
    const h = harness({ card: { ...seeded }, holdCommits: [0] });

    h.runner.dispatch(testDispatch({ text: "do the thing" }));
    await waitFor(() => h.agents.length === 1, "turn started");
    finishTurn(h.agents[0]!);

    await waitFor(() => !h.card()!.fresh, "the card went stale");
    expect(h.state.commits).toBe(0);

    h.releaseCommit();
    await waitFor(() => h.state.commits === 1, "commit ran");
    await waitFor(() => !h.runner.running, "turn finished");
    h.runner.dispose({ force: true });
  });

  // Adoption keeps the predecessor's `receivedResult` for its own recovery semantics, so
  // the settlement cannot read it: a crashed adopted turn produced no result to judge.
  it("does not ask an adopted turn that crashed without a result of its own", async () => {
    const h = harness({ card: { ...seeded }, streaming: true });

    h.runner.dispatch(testDispatch({ text: "do the thing" }));
    await waitFor(() => h.agents.length === 1, "turn started");
    await h.agentWritesCard("Routes done.");
    h.agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => !h.runner.running, "the first turn settled");

    h.agents[0]!.emit("event", { type: "agent_self_wake" });
    await flush();
    h.agents[0]!.emit("done", 1);
    await flush();
    await flush();

    // The adopted turn produced nothing, so the card no longer speaks for the session.
    expect(h.card()!.fresh).toBe(false);
    expect(h.card()!.nudgePending).toBeUndefined();
    h.runner.dispose({ force: true });
  });

  /**
   * req 36 — the exemption belongs to the turn being settled, not to the executor. A turn
   * the CLI starts after a compaction is real work, and it is the turn that carries no
   * prompt of ShipIt's, so the ask it records is read by the next turn that has one.
   */
  it("does not carry a compaction's exemption into a turn the CLI starts next (req 36)", async () => {
    const h = harness({ card: { ...seeded }, streaming: true });

    h.runner.dispatch(testDispatch({ text: "/compact" }));
    await waitFor(() => h.agents.length === 1, "compaction started");
    h.agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => !h.runner.running, "the compaction settled");
    expect(h.card()!.fresh).toBe(true);

    h.agents[0]!.emit("event", { type: "agent_self_wake" });
    await flush();
    h.agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => !h.card()!.fresh, "the adopted turn marked the card stale");
    expect(h.card()!.nudgePending).toBe(true);
    expect(h.agents).toHaveLength(1);

    h.runner.dispose({ force: true });
  });

  // A turn adopted from the CLI owns the terminal path it lands on, so the snapshot has to
  // come from it — after the handover, not from the predecessor that was about to hand over.
  it("settles the ADOPTED turn's facts, so its own commit does not run against a card reading current", async () => {
    const h = harness({ card: { ...seeded }, streaming: true, holdCommits: [0, 1] });

    h.runner.dispatch(testDispatch({ text: "do the thing" }));
    await waitFor(() => h.agents.length === 1, "turn started");
    await h.agentWritesCard("Routes done.");

    h.agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => h.parkedOn(0), "the predecessor parked on its commit");

    h.agents[0]!.emit("event", { type: "agent_self_wake" });
    await flush();
    h.agents[0]!.emit("done", 1);
    await flush();
    h.releaseCommit(0);

    await waitFor(() => h.parkedOn(1), "the adopted turn parked on its own commit");
    expect(h.card()!.fresh).toBe(false);

    h.releaseCommit(1);
    await waitFor(() => !h.runner.running, "the adopted turn finished");
    h.runner.dispose({ force: true });
  });

  it("a crash with no result marks the card stale but records no ask", async () => {
    const h = harness({ card: { ...seeded } });

    h.runner.dispatch(testDispatch({ text: "do the thing" }));
    await waitFor(() => h.agents.length === 1, "turn started");
    h.agents[0]!.emit("done", 1);
    await waitFor(() => h.agents.length === 2, "the retry started");
    h.agents[1]!.emit("done", 1);
    await waitFor(() => !h.runner.running, "turn finished");
    await flush();

    expect(h.card()!.fresh).toBe(false);
    expect(h.card()!.nudgePending).toBeUndefined();
    h.runner.dispose({ force: true });
  });
});
