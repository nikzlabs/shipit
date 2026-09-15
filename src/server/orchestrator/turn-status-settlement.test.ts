import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { SessionRunner } from "./session-runner.js";
import type { SystemTurnDeps } from "./session-runner.js";
import type { AgentId, SessionStatus } from "../shared/types.js";
import { recordSessionStatus } from "./services/session-status.js";
import type { SessionStatusDeps } from "./services/session-status.js";
import { testDispatch } from "./integration_tests/dispatch-test-helpers.js";

interface FakeAgent extends EventEmitter {
  run: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
}

function makeFakeAgent(): FakeAgent {
  const agent = new EventEmitter() as FakeAgent;
  agent.run = vi.fn();
  agent.kill = vi.fn();
  agent.setPermissionMode = vi.fn();
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

function harness(opts: { statusCardEnabled?: boolean; streaming?: boolean; card?: SessionStatus } = {}) {
  const cards = new Map<string, SessionStatus | undefined>();
  if (opts.card) cards.set("s1", opts.card);
  const sessionManager = {
    setAgentSessionId: vi.fn(),
    setLastTurnErrored: vi.fn(),
    get: (id: string) => ({ id, sessionStatus: cards.get(id) }),
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
    scheduleAutoPush: vi.fn(),
    statusCardEnabled: () => opts.statusCardEnabled ?? true,
    ...(opts.streaming ? { steerInputs: () => ({ liveSteering: true, steeringCapable: true }) } : {}),
    listenerDeps: {
      sessionManager: sessionManager as never,
      chatHistoryManager: {
        replaceInProgress: vi.fn(),
        finalizeInProgress: vi.fn(),
        append: vi.fn(),
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

  return {
    runner,
    agents,
    prompts,
    card: () => cards.get("s1"),
    nudges: () => prompts.filter((p) => p.includes("[ShipIt] The last turn ended without a status-card update")),
    agentWritesCard,
  };
}

const seeded: SessionStatus = { status: "Routes done.", actions: [], fresh: true, writeSeq: 1 };

function finishTurn(agent: FakeAgent): void {
  agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
  agent.emit("done", 0);
}

describe("settleTurnFacts and the status-card nudge (docs/303 req 11–15)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("marks the card stale and dispatches one visible nudge when the turn did not update it", async () => {
    const h = harness({ card: { ...seeded } });

    h.runner.dispatch(testDispatch({ text: "do the thing" }));
    await waitFor(() => h.agents.length === 1, "turn started");
    finishTurn(h.agents[0]!);

    await waitFor(() => h.agents.length === 2, "the nudge turn started");
    expect(h.card()!.fresh).toBe(false);
    // Not silent: the nudge's prompt is echoed as its own user row.
    expect(h.nudges()).toHaveLength(1);
    expect(h.runner.messageQueue).toHaveLength(0);

    finishTurn(h.agents[1]!);
    await waitFor(() => !h.runner.running, "the nudge turn finished");
    h.runner.dispose({ force: true });
  });

  it("marks the card stale even when it cannot nudge — the mark is immediate, not the nudge's job", async () => {
    const h = harness({ card: { ...seeded } });

    h.runner.dispatch(testDispatch({ text: "ask a question" }));
    await waitFor(() => h.agents.length === 1, "turn started");
    // A question, a plan approval or a user stop (req 13).
    h.runner.wasInterrupted = true;
    finishTurn(h.agents[0]!);
    await waitFor(() => !h.runner.running, "turn finished");
    await flush();

    expect(h.card()!.fresh).toBe(false);
    expect(h.nudges()).toHaveLength(0);
    expect(h.agents).toHaveLength(1);
    h.runner.dispose({ force: true });
  });

  it("nudges once per missing update: the nudge turn is not itself nudged (req 15)", async () => {
    const h = harness({ card: { ...seeded } });

    h.runner.dispatch(testDispatch({ text: "do the thing" }));
    await waitFor(() => h.agents.length === 1, "turn started");
    finishTurn(h.agents[0]!);
    await waitFor(() => h.agents.length === 2, "the nudge turn started");

    // The agent ignores the nudge too.
    finishTurn(h.agents[1]!);
    await waitFor(() => !h.runner.running, "the nudge turn finished");
    await flush();

    expect(h.agents).toHaveLength(2);
    expect(h.nudges()).toHaveLength(1);
    expect(h.card()!.fresh).toBe(false);
    h.runner.dispose({ force: true });
  });

  it("does not nudge a turn that wrote the card, and leaves it current", async () => {
    const h = harness({ card: { ...seeded } });

    h.runner.dispatch(testDispatch({ text: "do the thing" }));
    await waitFor(() => h.agents.length === 1, "turn started");
    await h.agentWritesCard("Ready to merge.");
    finishTurn(h.agents[0]!);
    await waitFor(() => !h.runner.running, "turn finished");
    await flush();

    expect(h.agents).toHaveLength(1);
    expect(h.nudges()).toHaveLength(0);
    expect(h.card()).toMatchObject({ status: "Ready to merge.", fresh: true });
    h.runner.dispose({ force: true });
  });

  it("defers to a queued successor and checks that turn afresh when it ends", async () => {
    const h = harness({ card: { ...seeded } });

    h.runner.dispatch(testDispatch({ text: "first" }));
    await waitFor(() => h.agents.length === 1, "turn 1 started");
    h.runner.dispatch(testDispatch({ text: "second" }));
    expect(h.runner.queueLength).toBe(1);

    finishTurn(h.agents[0]!);
    await waitFor(() => h.agents.length === 2, "turn 2 started");
    // The predecessor asked for nothing — not even behind the successor in the queue.
    expect(h.nudges()).toHaveLength(0);
    expect(h.runner.queueLength).toBe(0);
    expect(h.prompts[1]).toContain("second");

    finishTurn(h.agents[1]!);
    await waitFor(() => h.agents.length === 3, "the nudge turn started");
    expect(h.nudges()).toHaveLength(1);

    finishTurn(h.agents[2]!);
    await waitFor(() => !h.runner.running, "the nudge turn finished");
    h.runner.dispose({ force: true });
  });

  it("a predecessor settling after its successor wrote leaves the card current and nudges nothing", async () => {
    const h = harness({ card: { ...seeded }, streaming: true });

    h.runner.dispatch(testDispatch({ text: "first" }));
    await waitFor(() => h.agents.length === 1, "turn 1 started");
    h.runner.dispatch(testDispatch({ text: "second", systemTurn: true }));
    expect(h.runner.queueLength).toBe(1);

    // Streaming: the post-turn flow runs off agent_result, and `done` can come much later.
    h.agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => h.agents.length === 2, "turn 2 started");

    await h.agentWritesCard("Ready to merge.");
    finishTurn(h.agents[1]!);
    await waitFor(() => !h.runner.running, "turn 2 finished");

    // A third turn clears the runner's own `statusUpdated`, so the only thing that can
    // still tell the predecessor's state from the record's is the snapshot it took.
    h.runner.dispatch(testDispatch({ text: "third" }));
    await waitFor(() => h.agents.length === 3, "turn 3 started");

    // The predecessor's late exit must not re-settle against the successor's card.
    h.agents[0]!.emit("done", 0);
    await flush();
    await flush();

    expect(h.card()).toMatchObject({ status: "Ready to merge.", fresh: true });
    expect(h.nudges()).toHaveLength(0);

    finishTurn(h.agents[2]!);
    await waitFor(() => !h.runner.running, "turn 3 finished");
    h.runner.dispose({ force: true });
  });

  it("a streaming turn's agent_result and done give ONE decision, so one nudge", async () => {
    const h = harness({ card: { ...seeded }, streaming: true });

    h.runner.dispatch(testDispatch({ text: "do the thing" }));
    await waitFor(() => h.agents.length === 1, "turn started");

    h.agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => h.agents.length === 2, "the nudge turn started");
    h.agents[0]!.emit("done", 0);
    await flush();
    await flush();

    expect(h.nudges()).toHaveLength(1);
    finishTurn(h.agents[1]!);
    await waitFor(() => !h.runner.running, "the nudge turn finished");
    h.runner.dispose({ force: true });
  });

  it("with the setting off, nothing is marked and nothing is dispatched", async () => {
    const h = harness({ statusCardEnabled: false, card: { ...seeded } });

    h.runner.dispatch(testDispatch({ text: "do the thing" }));
    await waitFor(() => h.agents.length === 1, "turn started");
    finishTurn(h.agents[0]!);
    await waitFor(() => !h.runner.running, "turn finished");
    await flush();

    expect(h.agents).toHaveLength(1);
    expect(h.nudges()).toHaveLength(0);
    expect(h.card()!.fresh).toBe(true);
    h.runner.dispose({ force: true });
  });

  // `silent` reaches the executor only because the dispatch forwards it; without that the
  // compaction turn below would mark the card stale and then ask the agent about it.
  it("leaves a silent turn — compaction — out of the settlement entirely", async () => {
    const h = harness({ card: { ...seeded } });

    h.runner.dispatch(testDispatch({ text: "/compact", systemTurn: true, silent: true }));
    await waitFor(() => h.agents.length === 1, "compaction started");
    finishTurn(h.agents[0]!);
    await waitFor(() => !h.runner.running, "compaction finished");
    await flush();

    expect(h.agents).toHaveLength(1);
    expect(h.nudges()).toHaveLength(0);
    expect(h.card()!.fresh).toBe(true);
    h.runner.dispose({ force: true });
  });

  it("does not nudge a driver-owned turn (postTurn: none)", async () => {
    const h = harness({ card: { ...seeded } });

    h.runner.dispatch(testDispatch({ text: "rebase step", systemTurn: true, postTurn: "none" }));
    await waitFor(() => h.agents.length === 1, "turn started");
    finishTurn(h.agents[0]!);
    await waitFor(() => !h.runner.running, "turn finished");
    await flush();

    expect(h.agents).toHaveLength(1);
    expect(h.nudges()).toHaveLength(0);
    h.runner.dispose({ force: true });
  });

  it("a crash with no result marks the card stale but starts no nudge", async () => {
    const h = harness({ card: { ...seeded } });

    h.runner.dispatch(testDispatch({ text: "do the thing" }));
    await waitFor(() => h.agents.length === 1, "turn started");
    h.agents[0]!.emit("done", 1);
    // A no-result exit retries once; the second exit is terminal.
    await waitFor(() => h.agents.length === 2, "the retry started");
    h.agents[1]!.emit("done", 1);
    await waitFor(() => !h.runner.running, "turn finished");
    await flush();

    expect(h.card()!.fresh).toBe(false);
    expect(h.nudges()).toHaveLength(0);
    h.runner.dispose({ force: true });
  });
});
