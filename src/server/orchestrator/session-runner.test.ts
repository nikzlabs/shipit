import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { AgentTurnAdmissionError, SessionRunner, SessionRunnerRegistry, resetRunnerTurnState, sessionHasLiveAgent, toQueuedMessage } from "./session-runner.js";
import type { QueuedMessage } from "./session-runner.js";
import { ContainerSessionRunner } from "./container-session-runner.js";
import {
  prepareSessionAgentEnvironment,
  PUSH_AGENT_SECRETS_TIMEOUT_MS,
} from "./session-agent-env.js";
import type { AgentId, AgentRunParams } from "../shared/types.js";
import { testDispatch } from "./integration_tests/dispatch-test-helpers.js";
import { TURN_COMPLETED, type TurnOutcome } from "./turn-settlement.js";
import { noteTurnReady } from "./turn-stop-request.js";
import { nextSendOrder } from "./queue-identity.js";
import { returnQueueOnStop, returnedMessages } from "./queue-return.js";
import { BACKGROUND_TASK_TTL_MS } from "./background-task-tracker.js";

describe("SessionRunner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("tracks running state", () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    expect(runner.running).toBe(false);
    runner.running = true;
    expect(runner.running).toBe(true);
    runner.dispose({ force: true });
  });

  it("ends a sub-agent run at once when the adapter finds no credential in run()", async () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    const agent = Object.assign(new EventEmitter(), {
      run: () => { agent.emit("auth_required"); },
      kill: vi.fn(),
    });
    runner.setSystemTurnDeps({ agentFactory: () => agent } as never);

    const res = await runner.spawnSubAgent({
      agentId: "codex" as AgentId,
      prompt: "review",
      spawnId: "sp-1",
      depth: 0,
      model: "gpt-5.6-sol",
    });

    expect(res.status).toBe("error");
    expect(res.error).toMatch(/credential/);
    runner.dispose({ force: true });
  });

  it("runs a local sub-agent under the managed settings, with a sandbox parent's flag", async () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    let seen: AgentRunParams | undefined;
    const agent = Object.assign(new EventEmitter(), {
      run: (params: AgentRunParams) => { seen = params; agent.emit("auth_required"); },
      kill: vi.fn(),
    });
    runner.setSystemTurnDeps({ agentFactory: () => agent } as never);

    await runner.spawnSubAgent({
      agentId: "claude" as AgentId,
      prompt: "review",
      spawnId: "sp-2",
      depth: 0,
      model: "claude-opus-5",
      sandbox: true,
    });

    expect(seen?.settingsPath).toBe("/etc/shipit/managed-settings.json");
    expect(seen?.sandbox).toBe(true);
    runner.dispose({ force: true });
  });

  it("manages message queue", () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    expect(runner.queueLength).toBe(0);
    runner.enqueue({ text: "msg1", execution: "interactive", clientRequestId: "r1" });
    runner.enqueue({ text: "msg2", execution: "interactive" });
    expect(runner.queueLength).toBe(2);

    const snapshot = runner.getQueueSnapshot();
    expect(snapshot).toEqual([
      { id: "r1", text: "msg1", position: 1 },
      { id: expect.any(String), text: "msg2", position: 2 },
    ]);
    // The id an entry gets is the one every later snapshot and event names it by.
    expect(runner.getQueueSnapshot()[1]?.id).toBe(snapshot[1]?.id);

    const dequeued = runner.dequeue();
    expect(dequeued?.text).toBe("msg1");
    expect(runner.queueLength).toBe(1);

    runner.clearQueue();
    expect(runner.queueLength).toBe(0);
    runner.dispose();
  });

  it("emits messages to listeners and buffers them", () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });

    const received: any[] = [];
    runner.on("message", (msg) => received.push(msg));

    runner.emitMessage({ type: "agent_interrupted", sessionId: runner.sessionId });
    runner.emitMessage({ type: "error", message: "test" });

    expect(received).toHaveLength(2);
    expect(received[0].type).toBe("agent_interrupted");

    const buffer = runner.getTurnEventBuffer();
    expect(buffer).toHaveLength(2);

    runner.clearTurnEventBuffer();
    expect(runner.getTurnEventBuffer()).toHaveLength(0);
    runner.dispose();
  });

  it("tracks viewers", () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    expect(runner.viewerCount).toBe(0);
    runner.attachViewer();
    expect(runner.viewerCount).toBe(1);
    runner.attachViewer();
    expect(runner.viewerCount).toBe(2);
    runner.detachViewer();
    expect(runner.viewerCount).toBe(1);
    runner.detachViewer();
    expect(runner.viewerCount).toBe(0);
    runner.detachViewer();
    expect(runner.viewerCount).toBe(0);
    runner.dispose();
  });

  it("emits idle when agent finishes with empty queue", () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    const idleSpy = vi.fn();
    runner.on("idle", idleSpy);

    runner.running = false;
    runner.onAgentFinished();
    expect(idleSpy).toHaveBeenCalled();
    runner.dispose();
  });

  it("does not emit idle when queue is not empty", () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    const idleSpy = vi.fn();
    runner.on("idle", idleSpy);

    runner.enqueue({ text: "pending", execution: "interactive" });
    runner.running = false;
    runner.onAgentFinished();
    expect(idleSpy).not.toHaveBeenCalled();
    runner.dispose();
  });

  it("dispatch enqueues when agent is running", () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    runner.running = true;
    runner.dispatch(testDispatch({ text: "fix ci" }));
    expect(runner.queueLength).toBe(1);
    expect(runner.dequeue()?.text).toBe("fix ci");
    runner.dispose({ force: true });
  });

  it("dispatch broadcasts message_queued via emitMessage (docs/150)", () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    const received: any[] = [];
    runner.on("message", (msg) => received.push(msg));
    runner.running = true;
    runner.dispatch(testDispatch({ text: "fix ci" }));
    const queued = received.find((m) => m.type === "message_queued");
    expect(queued).toMatchObject({ type: "message_queued", text: "fix ci", position: 1 });
    runner.dispose({ force: true });
  });

  function steerDeps(opts: { liveSteering: boolean; steeringCapable?: boolean; replaceInProgress?: () => void }) {
    return {
      agentFactory: vi.fn(),
      autoCommit: vi.fn(),
      scheduleAutoPush: vi.fn(),
      listenerDeps: {
        sessionManager: { setAgentSessionId: vi.fn(), get: vi.fn(), track: vi.fn(), touchUnlessResolved: vi.fn(), setMuted: vi.fn(), list: vi.fn(), setLastTurnErrored: vi.fn() } as any,
        chatHistoryManager: { replaceInProgress: opts.replaceInProgress ?? vi.fn(), finalizeInProgress: vi.fn(), append: vi.fn() } as any,
        usageManager: { record: vi.fn(), getSessionUsage: vi.fn(), getSessionTokenTotals: vi.fn() } as any,
        sseBroadcast: vi.fn(),
        broadcastLog: vi.fn(),
        getSelectedModel: () => undefined,
      },
      buildRunParams: vi.fn(),
      steerInputs: () => ({ liveSteering: opts.liveSteering, steeringCapable: opts.steeringCapable ?? true }),
    } as any;
  }

  it("rejects an untrusted dispatch before steering or queue insertion (docs/243)", () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    const deps = steerDeps({ liveSteering: true });
    deps.authorizeDispatch = vi.fn(() => {
      throw new AgentTurnAdmissionError("s1");
    });
    runner.setSystemTurnDeps(deps);
    const sendUserMessage = vi.fn();
    runner.setAgent({ sendUserMessage, kill: vi.fn() } as any);
    runner.running = true;
    noteTurnReady(runner);
    runner.isStreamingActive = true;

    expect(() => runner.dispatch(testDispatch({ text: "blocked" }))).toThrow(
      expect.objectContaining({ code: "repository_untrusted", statusCode: 403 }),
    );
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(runner.queueLength).toBe(0);
    runner.dispose({ force: true });
  });

  it("dispatch steers a mid-turn message via sendUserMessage when live steering + streaming are active (docs/163)", () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    const persisted: any[] = [];
    runner.setSystemTurnDeps(steerDeps({ liveSteering: true, replaceInProgress: (...a: any[]) => persisted.push(a) }));

    const sent: string[] = [];
    const fakeAgent = { sendUserMessage: (t: string) => sent.push(t), kill: () => {} } as any;
    runner.setAgent(fakeAgent);
    runner.running = true;
    noteTurnReady(runner);
    runner.isStreamingActive = true;

    const received: any[] = [];
    runner.on("message", (msg) => received.push(msg));

    runner.dispatch(testDispatch({ text: "actually use a worktree" }));

    expect(sent).toEqual(["actually use a worktree"]);
    expect(runner.queueLength).toBe(0);
    const steered = received.find((m) => m.type === "message_steered");
    expect(steered).toMatchObject({ type: "message_steered", text: "actually use a worktree", sessionId: "s1" });
    expect(received.find((m) => m.type === "message_queued")).toBeUndefined();
    expect(persisted.length).toBe(1);

    runner.dispose({ force: true });
  });

  it("planning#256: a dispatch that asks for its own turn is NEVER steered into a running user turn — it enqueues, keeping its onTurnComplete", () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    runner.setSystemTurnDeps(steerDeps({ liveSteering: true }));
    const sent: string[] = [];
    runner.setAgent({ sendUserMessage: (t: string) => sent.push(t), kill: () => {} } as any);
    runner.running = true;
    noteTurnReady(runner);
    runner.isStreamingActive = true;

    const completions: { errored: boolean }[] = [];
    runner.dispatch(testDispatch({
      text: "child PR merged — resume the rebase",
      automatic: true,
      onTurnComplete: (o) => completions.push(o),
    }), { whenBusy: "queue" });

    expect(sent).toEqual([]);
    expect(runner.queueLength).toBe(1);
    const queued = runner.messageQueue[0]!;
    expect(queued.automatic).toBe(true);
    expect(queued.execution).toBe("dispatched");
    expect(queued.onTurnComplete).toBeTypeOf("function");
    queued.onTurnComplete!(TURN_COMPLETED);
    expect(completions).toEqual([TURN_COMPLETED]);

    runner.dispose({ force: true });
  });

  it("planning#256: a dispatch carrying only onTurnComplete is also unsteerable (the callback can't survive a steer)", () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    runner.setSystemTurnDeps(steerDeps({ liveSteering: true }));
    const sent: string[] = [];
    runner.setAgent({ sendUserMessage: (t: string) => sent.push(t), kill: () => {} } as any);
    runner.running = true;
    noteTurnReady(runner);
    runner.isStreamingActive = true;

    runner.dispatch(testDispatch({ text: "awaited follow-up", onTurnComplete: () => {} }));

    expect(sent).toEqual([]);
    expect(runner.queueLength).toBe(1);
    expect(runner.messageQueue[0]!.onTurnComplete).toBeTypeOf("function");

    runner.dispose({ force: true });
  });

  // docs/328-session-message-inbox — the notice is never a queue entry.
  it("a steer-or-refuse dispatch is steered into a turn that can take it", () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    runner.setSystemTurnDeps(steerDeps({ liveSteering: true }));
    const sent: string[] = [];
    runner.setAgent({ sendUserMessage: (t: string) => sent.push(t), kill: () => {} } as any);
    runner.running = true;
    noteTurnReady(runner);
    runner.isStreamingActive = true;

    const handle = runner.dispatch(testDispatch({ text: "you have messages" }), { whenBusy: "steer-or-refuse" });

    expect(handle.admitted).toBe("steered");
    expect(sent).toEqual(["you have messages"]);
    expect(runner.queueLength).toBe(0);
    runner.dispose({ force: true });
  });

  it.each([
    ["live steering is off", { liveSteering: false }, true],
    ["the turn is not streaming", { liveSteering: true }, false],
  ] as const)("a steer-or-refuse dispatch is refused, not queued, when %s", async (_label, deps, streaming) => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    runner.setSystemTurnDeps(steerDeps(deps));
    const sent: string[] = [];
    runner.setAgent({ sendUserMessage: (t: string) => sent.push(t), kill: () => {} } as any);
    runner.running = true;
    runner.isStreamingActive = streaming;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const handle = runner.dispatch(testDispatch({ text: "you have messages" }), { whenBusy: "steer-or-refuse" });

    expect(handle.admitted).toBe("refused");
    expect((await handle.settled).status).toBe("refused");
    expect(sent).toEqual([]);
    expect(runner.queueLength).toBe(0);
    vi.restoreAllMocks();
    runner.dispose({ force: true });
  });

  it("dispatch enqueues (does not steer) when live steering is off, even on a streaming turn (docs/163)", () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    runner.setSystemTurnDeps(steerDeps({ liveSteering: false }));

    const sent: string[] = [];
    runner.setAgent({ sendUserMessage: (t: string) => sent.push(t), kill: () => {} } as any);
    runner.running = true;
    noteTurnReady(runner);
    runner.isStreamingActive = true;

    const received: any[] = [];
    runner.on("message", (msg) => received.push(msg));

    runner.dispatch(testDispatch({ text: "queue me" }));

    expect(sent).toEqual([]);
    expect(runner.queueLength).toBe(1);
    expect(received.find((m) => m.type === "message_queued")).toMatchObject({ type: "message_queued", text: "queue me" });
    expect(received.find((m) => m.type === "message_steered")).toBeUndefined();

    runner.dispose({ force: true });
  });

  it("docs/322: while the agent waits for an answer, an automatic dispatch is held and the user's is not", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const deps = steerDeps({ liveSteering: false });
    const saved: QueuedMessage[] = [];
    deps.answerHold = {
      automaticTurnsHeld: () => true,
      setAwaitingAnswer: vi.fn(),
      holdTurn: (_id: string, entry: QueuedMessage) => { saved.push(entry); return saved.length; },
      heldTurns: () => [],
      forgetHeldTurn: vi.fn(),
      hasHeldDelivery: () => false,
    };
    runner.setSystemTurnDeps(deps);
    const ran = vi.spyOn(runner, "runDispatchedTurn").mockResolvedValue();

    const held = runner.dispatch(testDispatch({ text: "[ci-fix] CI failed", automatic: true }));
    expect(held.admitted).toBe("queued");
    // req 8 — saved, not queued in the runner a stopped container would take with it.
    expect(saved.map((m) => m.text)).toEqual(["[ci-fix] CI failed"]);
    expect(runner.queueLength).toBe(0);
    expect(runner.running).toBe(false);

    const refused = runner.dispatch(
      testDispatch({ text: "resolve conflicts", automatic: true, postTurn: "none" }),
      { whenBusy: "refuse" },
    );
    expect(refused.admitted).toBe("refused");
    expect((await refused.settled).detail).toContain("waiting for the user's answer");

    const answer = runner.dispatch(testDispatch({ text: "Redis" }));
    expect(answer.admitted).toBe("started");
    expect(ran).toHaveBeenCalledTimes(1);
    expect(ran.mock.calls[0]![0].text).toBe("Redis");

    runner.dispose({ force: true });
  });

  it("docs/322-question-holds-automatic-turns req 8: automatic work stopped by any gate while the agent waits is saved, not queued", () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const deps = steerDeps({ liveSteering: true });
    const saved: string[] = [];
    deps.answerHold = {
      automaticTurnsHeld: () => true,
      setAwaitingAnswer: vi.fn(),
      holdTurn: (_id: string, entry: QueuedMessage) => { saved.push(entry.text); return saved.length; },
      heldTurns: () => [],
      forgetHeldTurn: vi.fn(),
      hasHeldDelivery: () => false,
    };
    runner.setSystemTurnDeps(deps);
    // The asking turn is still winding down, or a CLI-started turn is being stopped.
    runner.running = true;

    const handle = runner.dispatch(testDispatch({
      text: "from the parent session",
      automatic: true,
      messageOrigin: { sessionId: "parent", sessionTitle: "Parent", relation: "parent" },
    }));
    expect(handle.admitted).toBe("queued");
    expect(saved).toEqual(["from the parent session"]);
    expect(runner.queueLength).toBe(0);

    runner.dispatch(testDispatch({ text: "typed by the user" }));
    expect(runner.queueLength).toBe(1);

    runner.dispose({ force: true });
  });

  it("docs/322: automatic work is not steered into a turn that is ending on a question", () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    runner.setSystemTurnDeps(steerDeps({ liveSteering: true }));
    const sent: string[] = [];
    runner.setAgent({ sendUserMessage: (t: string) => sent.push(t), kill: () => {} } as any);
    runner.running = true;
    noteTurnReady(runner);
    runner.isStreamingActive = true;
    runner.awaitingUserAnswer = true;

    runner.dispatch(testDispatch({
      text: "from the parent session",
      automatic: true,
      messageOrigin: { sessionId: "parent", sessionTitle: "Parent", relation: "parent" },
    }));
    expect(sent).toEqual([]);
    expect(runner.queueLength).toBe(1);

    runner.dispatch(testDispatch({ text: "typed by the user" }));
    expect(sent).toEqual(["typed by the user"]);

    runner.dispose({ force: true });
  });

  it("dispatch enqueues when the turn is not streaming (no resident streaming process to steer) (docs/163)", () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    runner.setSystemTurnDeps(steerDeps({ liveSteering: true }));

    const sent: string[] = [];
    runner.setAgent({ sendUserMessage: (t: string) => sent.push(t), kill: () => {} } as any);
    runner.running = true;
    runner.isStreamingActive = false;

    const received: any[] = [];
    runner.on("message", (msg) => received.push(msg));

    runner.dispatch(testDispatch({ text: "queue me" }));

    expect(sent).toEqual([]);
    expect(runner.queueLength).toBe(1);
    expect(received.find((m) => m.type === "message_queued")).toBeTruthy();

    runner.dispose({ force: true });
  });

  it("dispose tears down a streaming turn: kills the agent, drops the buffered steer, resets the gate (docs/140)", () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    runner.setSystemTurnDeps(steerDeps({ liveSteering: true }));

    let killed = 0;
    runner.setAgent({ sendUserMessage: () => {}, kill: () => { killed++; } } as any);
    runner.running = true;
    noteTurnReady(runner);
    runner.isStreamingActive = true;

    runner.dispatch(testDispatch({ text: "buffered note" }), { whenBusy: "queue" });
    expect(runner.queueLength).toBe(1);

    runner.dispose({ force: true });

    expect(killed).toBe(1);
    expect(runner.queueLength).toBe(0);
    expect(runner.isStreamingActive).toBe(false);
  });

  it("dispatch starts agent turn when idle with deps set", async () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    const fakeAgent = { on: vi.fn(), run: vi.fn(), kill: vi.fn(), removeAllListeners: vi.fn() } as any;
    runner.setSystemTurnDeps({
      agentFactory: () => fakeAgent,
      autoCommit: vi.fn().mockResolvedValue({
        commitHash: null,
        parentHash: null,
        conflictedFiles: [],
        rebaseInProgress: false,
        secretFindings: [],
      }),
      scheduleAutoPush: vi.fn(),
      listenerDeps: {
        sessionManager: { setAgentSessionId: vi.fn(), get: vi.fn(), track: vi.fn(), touchUnlessResolved: vi.fn(), setMuted: vi.fn(), list: vi.fn(), setLastTurnErrored: vi.fn() } as any,
        chatHistoryManager: { replaceInProgress: vi.fn(), finalizeInProgress: vi.fn(), append: vi.fn() } as any,
        usageManager: { record: vi.fn(), getSessionUsage: vi.fn(), getSessionTokenTotals: vi.fn() } as any,
        sseBroadcast: vi.fn(),
        broadcastLog: vi.fn(),
        getSelectedModel: () => undefined,
      },
      buildRunParams: vi.fn().mockResolvedValue({
        prompt: "fix ci",
        cwd: "/tmp/s1",
        sessionId: "agent-session-123",
      }),
    });

    runner.dispatch(testDispatch({ text: "fix ci" }));
    await new Promise((r) => setImmediate(r));
    expect(runner.queueLength).toBe(0);
    expect(runner.running).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(fakeAgent.run).toHaveBeenCalledWith(expect.objectContaining({ prompt: "fix ci" }));
    runner.dispose({ force: true });
  });

  it("dispatch runs prepareAgentEnv right before buildRunParams (fresh token at spawn)", async () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    const fakeAgent = { on: vi.fn(), run: vi.fn(), kill: vi.fn(), removeAllListeners: vi.fn() } as any;
    const callOrder: string[] = [];
    runner.setSystemTurnDeps({
      agentFactory: () => fakeAgent,
      autoCommit: vi.fn().mockResolvedValue({
        commitHash: null,
        parentHash: null,
        conflictedFiles: [],
        rebaseInProgress: false,
        secretFindings: [],
      }),
      scheduleAutoPush: vi.fn(),
      listenerDeps: {
        sessionManager: { setAgentSessionId: vi.fn(), get: vi.fn(), track: vi.fn(), touchUnlessResolved: vi.fn(), setMuted: vi.fn(), list: vi.fn(), setLastTurnErrored: vi.fn() } as any,
        chatHistoryManager: { replaceInProgress: vi.fn(), finalizeInProgress: vi.fn(), append: vi.fn() } as any,
        usageManager: { record: vi.fn(), getSessionUsage: vi.fn(), getSessionTokenTotals: vi.fn() } as any,
        sseBroadcast: vi.fn(),
        broadcastLog: vi.fn(),
        getSelectedModel: () => undefined,
      },
      prepareAgentEnv: vi.fn().mockImplementation(async () => {
        callOrder.push("prepareAgentEnv");
      }),
      buildRunParams: vi.fn().mockImplementation(async () => {
        callOrder.push("buildRunParams");
        return { prompt: "fix ci", cwd: "/tmp/s1" };
      }),
    });

    runner.dispatch(testDispatch({ text: "fix ci" }));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 0));
    expect(callOrder).toEqual(["prepareAgentEnv", "buildRunParams"]);
    expect(fakeAgent.run).toHaveBeenCalled();
    runner.dispose({ force: true });
  });

  it("retires the outgoing resident before creating an account-failover turn", async () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    const outgoing = {
      emit: vi.fn(),
      kill: vi.fn(),
      removeAllListeners: vi.fn(),
    } as any;
    const incoming = {
      on: vi.fn(),
      run: vi.fn(),
      kill: vi.fn(),
      removeAllListeners: vi.fn(),
    } as any;
    runner.setAgent(outgoing);
    runner.isStreamingActive = true;
    runner.setSystemTurnDeps({
      agentFactory: () => incoming,
      autoCommit: vi.fn().mockResolvedValue({
        commitHash: null,
        parentHash: null,
        conflictedFiles: [],
        rebaseInProgress: false,
        secretFindings: [],
      }),
      scheduleAutoPush: vi.fn(),
      listenerDeps: {
        sessionManager: { setAgentSessionId: vi.fn(), get: vi.fn(), track: vi.fn(), touchUnlessResolved: vi.fn(), setMuted: vi.fn(), list: vi.fn(), setLastTurnErrored: vi.fn() } as any,
        chatHistoryManager: { replaceInProgress: vi.fn(), finalizeInProgress: vi.fn(), append: vi.fn() } as any,
        usageManager: { record: vi.fn(), getSessionUsage: vi.fn(), getSessionTokenTotals: vi.fn() } as any,
        sseBroadcast: vi.fn(),
        broadcastLog: vi.fn(),
        getSelectedModel: () => undefined,
      },
      needsAccountFailover: () => true,
      prepareAgentEnv: vi.fn().mockResolvedValue(undefined),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "continue", cwd: "/tmp/s1" }),
    });

    runner.dispatch(testDispatch({ text: "continue" }));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 0));

    expect(outgoing.kill).toHaveBeenCalledOnce();
    expect(incoming.kill).not.toHaveBeenCalled();
    expect(incoming.run).toHaveBeenCalledWith(expect.objectContaining({ prompt: "continue" }));
    expect(runner.getAgent()).toBe(incoming);
    runner.dispose({ force: true });
  });

  it("tells env prep whether the turn reuses a resident agent or spawns a fresh one", async () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    const resident = {
      on: vi.fn(),
      run: vi.fn(),
      kill: vi.fn(),
      removeAllListeners: vi.fn(),
      sendUserMessage: vi.fn(),
    } as any;
    const fresh = { on: vi.fn(), run: vi.fn(), kill: vi.fn(), removeAllListeners: vi.fn() } as any;
    const prepareAgentEnv = vi.fn().mockResolvedValue(undefined);
    resident.emit = vi.fn();
    runner.setAgent(resident);
    runner.isStreamingActive = true;
    runner.setSystemTurnDeps({
      agentFactory: () => fresh,
      autoCommit: vi.fn().mockResolvedValue({
        commitHash: null,
        parentHash: null,
        conflictedFiles: [],
        rebaseInProgress: false,
        secretFindings: [],
      }),
      scheduleAutoPush: vi.fn(),
      listenerDeps: {
        sessionManager: { setAgentSessionId: vi.fn(), get: vi.fn(), track: vi.fn(), touchUnlessResolved: vi.fn(), setMuted: vi.fn(), list: vi.fn(), setLastTurnErrored: vi.fn() } as any,
        chatHistoryManager: { replaceInProgress: vi.fn(), finalizeInProgress: vi.fn(), append: vi.fn() } as any,
        usageManager: { record: vi.fn(), getSessionUsage: vi.fn(), getSessionTokenTotals: vi.fn() } as any,
        sseBroadcast: vi.fn(),
        broadcastLog: vi.fn(),
        getSelectedModel: () => undefined,
      },
      prepareAgentEnv,
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "continue", cwd: "/tmp/s1" }),
    });

    runner.dispatch(testDispatch({ text: "continue" }));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 0));
    expect(resident.sendUserMessage).toHaveBeenCalledWith("continue");
    expect(prepareAgentEnv).toHaveBeenLastCalledWith(
      "s1", "claude", expect.objectContaining({ reusingResidentAgent: true }),
    );

    runner.running = false;
    runner.setAgent(null);
    runner.isStreamingActive = false;
    runner.dispatch(testDispatch({ text: "again" }));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 0));
    expect(prepareAgentEnv).toHaveBeenLastCalledWith(
      "s1", "claude", expect.objectContaining({ reusingResidentAgent: false }),
    );

    runner.dispose({ force: true });
  });

  it("dispatch still spawns the agent when env prep's network step hangs (warm-pool hang regression)", async () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    const fakeAgent = { on: vi.fn(), run: vi.fn(), kill: vi.fn(), removeAllListeners: vi.fn() } as any;

    // Reparent to exercise env prep's instanceof ContainerSessionRunner branch.
    class HangingContainerRunner extends EventEmitter {
      serviceManager = null;
      tryPushAgentSecrets = (): Promise<void> => new Promise<void>(() => { /* never resolves */ });
    }
    Object.setPrototypeOf(HangingContainerRunner.prototype, ContainerSessionRunner.prototype);
    const envRunner = new HangingContainerRunner();

    const credentialStore = {
      getAllAgentEnv: () => ({}),
      getAllMcpOAuthTokens: () => ({}),
    } as any;
    const sessionManager = {
      get: () => ({ agentPinned: true, id: "s1", agentSessionId: "sid" }),
      setAgentId: vi.fn(),
      setAgentPinned: vi.fn(),
      setProviderRoute: vi.fn(),
      setAgentSessionId: vi.fn(),
      setLastTurnErrored: vi.fn(),
    } as any;

    runner.setSystemTurnDeps({
      agentFactory: () => fakeAgent,
      autoCommit: vi.fn().mockResolvedValue({
        commitHash: null,
        parentHash: null,
        conflictedFiles: [],
        rebaseInProgress: false,
        secretFindings: [],
      }),
      scheduleAutoPush: vi.fn(),
      listenerDeps: {
        sessionManager: { setAgentSessionId: vi.fn(), get: vi.fn(), track: vi.fn(), touchUnlessResolved: vi.fn(), setMuted: vi.fn(), list: vi.fn(), setLastTurnErrored: vi.fn() } as any,
        chatHistoryManager: { replaceInProgress: vi.fn(), finalizeInProgress: vi.fn(), append: vi.fn() } as any,
        usageManager: { record: vi.fn(), getSessionUsage: vi.fn(), getSessionTokenTotals: vi.fn() } as any,
        sseBroadcast: vi.fn(),
        broadcastLog: vi.fn(),
        getSelectedModel: () => undefined,
      },
      prepareAgentEnv: async (sessionId, agentId) =>
        prepareSessionAgentEnvironment(envRunner as any, {
          sessionId,
          agentId,
          deps: { credentialsDir: "/tmp/shipit-env-prep-hang-test", credentialStore, sessionManager },
        }),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "fix ci", cwd: "/tmp/s1" }),
    });

    vi.useFakeTimers();
    try {
      runner.dispatch(testDispatch({ text: "fix ci" }));
      await vi.advanceTimersByTimeAsync(PUSH_AGENT_SECRETS_TIMEOUT_MS + 1_000);
      expect(fakeAgent.run).toHaveBeenCalledWith(expect.objectContaining({ prompt: "fix ci" }));
    } finally {
      vi.useRealTimers();
    }
    runner.dispose({ force: true });
  });

  it("dispatch clears running state and broadcasts finished when startup preparation fails", async () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    const fakeAgent = new EventEmitter() as any;
    fakeAgent.run = vi.fn();
    fakeAgent.kill = vi.fn();
    const sseBroadcast = vi.fn();
    const chatHistoryAppend = vi.fn();
    const received: any[] = [];
    runner.on("message", (msg) => received.push(msg));
    runner.setSystemTurnDeps({
      agentFactory: () => fakeAgent,
      autoCommit: vi.fn(),
      scheduleAutoPush: vi.fn(),
      listenerDeps: {
        sessionManager: { setAgentSessionId: vi.fn(), get: vi.fn(), track: vi.fn(), touchUnlessResolved: vi.fn(), setMuted: vi.fn(), list: vi.fn(), setLastTurnErrored: vi.fn() } as any,
        chatHistoryManager: {
          replaceInProgress: vi.fn(),
          finalizeInProgress: vi.fn(),
          append: chatHistoryAppend,
        } as any,
        usageManager: { record: vi.fn(), getSessionUsage: vi.fn(), getSessionTokenTotals: vi.fn() } as any,
        sseBroadcast,
        broadcastLog: vi.fn(),
        getSelectedModel: () => undefined,
      },
      buildRunParams: vi.fn().mockRejectedValue(new Error("run params failed")),
    });

    runner.dispatch(testDispatch({ text: "fix ci" }));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 0));

    expect(fakeAgent.run).not.toHaveBeenCalled();
    expect(runner.running).toBe(false);
    expect(sseBroadcast).toHaveBeenCalledWith("session_agent_finished", { sessionId: "s1" });
    expect(received).toContainEqual(expect.objectContaining({
      type: "session_status",
      sessionId: "s1",
      running: false,
      error: "Agent process error: run params failed",
    }));
    expect(chatHistoryAppend).toHaveBeenCalledWith("s1", expect.objectContaining({
      role: "assistant",
      text: "Error: run params failed",
      isError: true,
    }));
    runner.dispose();
  });

  it("dispatch falls back to enqueue when idle with no deps", () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    runner.dispatch(testDispatch({ text: "fix ci" }));
    expect(runner.queueLength).toBe(1);
    runner.dispose();
  });

  it("dispatch threads attachments + permissionMode into the queued message (docs/150)", () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    runner.running = true;
    runner.dispatch(testDispatch({
      text: "review please",
      activity: "Reviewing…",
      images: [{ data: "AAA=", mediaType: "image/png" }],
      files: [{ path: "src/foo.ts" }],
      uploads: [{ path: "/uploads/screen.png", type: "upload" as const }],
      permissionMode: "guarded",
    }));
    const queued = runner.dequeue();
    expect(queued).toMatchObject({
      text: "review please",
      activity: "Reviewing…",
      images: [{ data: "AAA=", mediaType: "image/png" }],
      files: [{ path: "src/foo.ts" }],
      uploads: [{ path: "/uploads/screen.png", type: "upload" as const }],
      permissionMode: "guarded",
    });
    runner.dispose({ force: true });
  });

  it("enforces message queue cap of 50", () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });

    for (let i = 0; i < 50; i++) {
      runner.enqueue({ text: `msg${i}`, execution: "interactive" });
    }
    expect(runner.queueLength).toBe(50);

    expect(() => runner.enqueue({ text: "overflow", execution: "interactive" })).toThrow("Message queue is full");
    expect(runner.queueLength).toBe(50);

    runner.dequeue();
    expect(runner.queueLength).toBe(49);
    runner.enqueue({ text: "fits now", execution: "interactive" });
    expect(runner.queueLength).toBe(50);

    runner.dispose();
  });

  it("dispose kills agent and terminal", () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    const fakeAgent = { kill: vi.fn() } as any;
    const fakeTerminal = { kill: vi.fn() } as any;
    runner.setAgent(fakeAgent);
    runner.setTerminal(fakeTerminal);

    const disposedSpy = vi.fn();
    runner.on("disposed", disposedSpy);

    runner.dispose();
    expect(fakeAgent.kill).toHaveBeenCalled();
    expect(fakeTerminal.kill).toHaveBeenCalled();
    expect(runner.disposed).toBe(true);
    expect(disposedSpy).toHaveBeenCalled();
  });

  it("dispose() refuses to kill a running agent", () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    const fakeAgent = { kill: vi.fn() } as any;
    runner.setAgent(fakeAgent);
    runner.running = true;

    runner.dispose();

    expect(fakeAgent.kill).not.toHaveBeenCalled();
    expect(runner.disposed).toBe(false);

    runner.dispose({ force: true });
    expect(fakeAgent.kill).toHaveBeenCalled();
    expect(runner.disposed).toBe(true);
  });

  it("detachViewer records the timestamp for grace-period checks", () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    expect(runner.lastViewerDetachAt).toBe(0);

    runner.attachViewer();
    expect(runner.lastViewerDetachAt).toBe(0);

    const before = Date.now();
    runner.detachViewer();
    const after = Date.now();
    expect(runner.lastViewerDetachAt).toBeGreaterThanOrEqual(before);
    expect(runner.lastViewerDetachAt).toBeLessThanOrEqual(after);
    runner.dispose();
  });

  it("grace-period timer arms only on LAST detach, never on intermediate detach", async () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    runner.attachViewer();
    runner.attachViewer();
    expect(runner.viewerCount).toBe(2);
    expect(runner.lastViewerDetachAt).toBe(0);

    runner.detachViewer();
    expect(runner.viewerCount).toBe(1);
    expect(runner.lastViewerDetachAt).toBe(0);

    runner.detachViewer();
    expect(runner.viewerCount).toBe(0);
    const firstZero = runner.lastViewerDetachAt;
    expect(firstZero).toBeGreaterThan(0);

    await new Promise((r) => setTimeout(r, 5));
    runner.detachViewer();
    expect(runner.lastViewerDetachAt).toBe(firstZero);

    runner.attachViewer();
    expect(runner.lastViewerDetachAt).toBe(0);
    runner.detachViewer();
    expect(runner.lastViewerDetachAt).toBeGreaterThanOrEqual(firstZero);
    runner.dispose();
  });

  // planning#710 — the SSE announcement reaches the sidebar only, so the open chat kept its row.
  it("tells the open chat when the task list is cleared or expires", () => {
    vi.useFakeTimers();
    try {
      const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
      const seen: unknown[] = [];
      runner.on("message", (m) => { if (m.type === "background_tasks") seen.push(m); });
      const drained = { type: "background_tasks", sessionId: "s1", count: 0, descriptions: [] };
      runner.isStreamingActive = true;

      runner.setBackgroundTasks([{ id: "t1", description: "npm test" }]);
      runner.clearBackgroundTasks();
      runner.clearBackgroundTasks();
      expect(seen).toEqual([drained]);

      runner.setBackgroundTasks([{ id: "t2", description: "npm run build" }]);
      vi.advanceTimersByTime(BACKGROUND_TASK_TTL_MS);
      expect(seen).toEqual([drained, drained]);
      expect(runner.backgroundWorkDescriptions).toEqual([]);
      runner.dispose({ force: true });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("statusUpdated", () => {
  // docs/303 req 11 — freshness is judged per turn, so the flag a turn set must
  // not survive into the next one and report it as updated.
  it("resets with the rest of the turn on both runners", () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    const container = new ContainerSessionRunner({
      sessionId: "s2",
      sessionDir: "/tmp/s2",
      defaultAgentId: "claude" as AgentId,
      workerBaseUrl: "http://127.0.0.1:1",
    } as never);

    for (const r of [runner, container]) {
      expect(r.statusUpdated).toBe(false);
      r.statusUpdated = true;
      resetRunnerTurnState(r);
      expect(r.statusUpdated).toBe(false);
    }
    runner.dispose({ force: true });
  });
});

describe("sessionHasLiveAgent", () => {
  it("is false for an unknown session and for a runner with no agent", () => {
    const registry = new SessionRunnerRegistry();
    expect(sessionHasLiveAgent(registry, "nope")).toBe(false);
    const runner = registry.getOrCreate("s1", "/tmp/s1", "claude" as AgentId);
    expect(sessionHasLiveAgent(registry, "s1")).toBe(false);
    runner.dispose();
  });

  it("is true for an IDLE session that still holds a resident process", () => {
    const registry = new SessionRunnerRegistry();
    const runner = registry.getOrCreate("s1", "/tmp/s1", "claude" as AgentId);
    runner.setAgent(new EventEmitter() as never);
    runner.running = false;

    expect(runner.running).toBe(false);
    expect(sessionHasLiveAgent(registry, "s1")).toBe(true);

    runner.setAgent(null);
    expect(sessionHasLiveAgent(registry, "s1")).toBe(false);
    runner.dispose({ force: true });
  });

  it("tolerates a missing registry", () => {
    expect(sessionHasLiveAgent(null, "s1")).toBe(false);
    expect(sessionHasLiveAgent(undefined, "s1")).toBe(false);
  });
});

describe("SessionRunnerRegistry", () => {
  it("creates and retrieves runners", () => {
    const registry = new SessionRunnerRegistry();
    const runner = registry.getOrCreate("s1", "/tmp/s1", "claude" as AgentId);
    expect(runner.sessionId).toBe("s1");

    const same = registry.getOrCreate("s1", "/tmp/s1", "claude" as AgentId);
    expect(same).toBe(runner);

    expect(registry.size).toBe(1);
    runner.dispose();
  });

  it("lists active runners", () => {
    const registry = new SessionRunnerRegistry();
    const r1 = registry.getOrCreate("s1", "/tmp/s1", "claude" as AgentId);
    const r2 = registry.getOrCreate("s2", "/tmp/s2", "claude" as AgentId);
    r1.running = true;

    expect(registry.listActive()).toEqual(["s1"]);
    r1.dispose({ force: true });
    r2.dispose();
  });

  it("disposes a specific runner", () => {
    const registry = new SessionRunnerRegistry();
    const r = registry.getOrCreate("s1", "/tmp/s1", "claude" as AgentId);
    registry.dispose("s1");
    expect(r.disposed).toBe(true);
    expect(registry.get("s1")).toBeUndefined();
  });

  it("disposes all runners", () => {
    const registry = new SessionRunnerRegistry();
    const r1 = registry.getOrCreate("s1", "/tmp/s1", "claude" as AgentId);
    const r2 = registry.getOrCreate("s2", "/tmp/s2", "claude" as AgentId);
    registry.disposeAll();
    expect(r1.disposed).toBe(true);
    expect(r2.disposed).toBe(true);
    expect(registry.size).toBe(0);
  });

  it("reports a replacement only when the disposed runner still had viewers", () => {
    const orphaned = vi.fn();
    const registry = new SessionRunnerRegistry({ onViewersOrphaned: orphaned });
    const watched = registry.getOrCreate("s1", "/tmp/s1", "claude" as AgentId);
    watched.attachViewer();
    registry.dispose("s1");
    const replacement = registry.getOrCreate("s1", "/tmp/s1", "claude" as AgentId);
    expect(orphaned).toHaveBeenCalledWith("s1", 2);

    orphaned.mockClear();
    registry.dispose("s1");
    registry.getOrCreate("s1", "/tmp/s1", "claude" as AgentId).dispose();
    expect(replacement.disposed).toBe(true);
    expect(orphaned).not.toHaveBeenCalled();
  });

  it("calls onRunnerIdle when runner emits idle", () => {
    const idleSpy = vi.fn();
    const registry = new SessionRunnerRegistry({ onRunnerIdle: idleSpy });
    const r1 = registry.getOrCreate("s1", "/tmp/s1", "claude" as AgentId);

    r1.running = false;
    r1.onAgentFinished();

    expect(idleSpy).toHaveBeenCalledWith("s1");
    r1.dispose();
  });

  it("auto-removes disposed runners from registry", () => {
    const registry = new SessionRunnerRegistry();
    const r = registry.getOrCreate("s1", "/tmp/s1", "claude" as AgentId);
    r.dispose();
    expect(registry.get("s1")).toBeUndefined();
  });
});

// docs/330-stop-returns-queued-messages — a Stop tells what was sent before it by this order.
describe("the send order of a dispatch", () => {
  function startedRunner() {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    runner.setSystemTurnDeps({} as never);
    const run = vi.spyOn(runner, "runDispatchedTurn").mockResolvedValue(undefined);
    return { runner, run };
  }

  it("is taken when the dispatch is accepted, also for a dispatch that starts at once", () => {
    const { runner, run } = startedRunner();
    const before = nextSendOrder();

    runner.dispatch(testDispatch({ text: "a wake" }));

    expect(run.mock.calls[0]?.[0].sendOrder).toBeGreaterThan(before);
    runner.dispose({ force: true });
  });

  it("returns a dispatch that was sent before the last Stop instead of starting it", async () => {
    const { runner, run } = startedRunner();
    const sentEarlier = nextSendOrder();
    returnQueueOnStop(runner);

    const handle = runner.dispatch(testDispatch({
      text: "on its way at the Stop",
      execution: "interactive",
      clientRequestId: "m1",
      sendOrder: sentEarlier,
    }));

    expect(handle.admitted).toBe("refused");
    expect((await handle.settled).status).toBe("dropped");
    expect(run).not.toHaveBeenCalled();
    expect(runner.queueLength).toBe(0);
    expect(returnedMessages(runner)).toEqual([{ id: "m1", text: "on its way at the Stop" }]);
    runner.dispose({ force: true });
  });

  it("is kept when the dispatch has one already, as an entry that a drain started has", () => {
    const { runner, run } = startedRunner();

    runner.dispatch(testDispatch({ text: "drained", sendOrder: 3 }));

    expect(run.mock.calls[0]?.[0].sendOrder).toBe(3);
    runner.dispose({ force: true });
  });
});

// A sender told that its dispatch failed acts on it (planning#695 parks a note), so a
// dispatch that still runs must not be told so.
describe("a dispatch that a pre-turn compaction put back in the queue", () => {
  it("is not settled as a setup failure when the compaction fails, and runs next", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const forgetHeldTurn = vi.fn();
    runner.setSystemTurnDeps({
      answerHold: {
        automaticTurnsHeld: () => false,
        setAwaitingAnswer: vi.fn(),
        holdTurn: vi.fn(),
        heldTurns: () => [],
        forgetHeldTurn,
        hasHeldDelivery: () => false,
      },
    } as never);
    const run = vi.spyOn(runner, "runDispatchedTurn")
      .mockImplementationOnce((opts) => {
        runner.messageQueue.unshift({ ...toQueuedMessage(opts), compactContext: false });
        return Promise.reject(new Error("the compaction could not start"));
      })
      .mockResolvedValue(undefined);
    const outcomes: TurnOutcome[] = [];

    const handle = runner.dispatch(testDispatch({
      text: "a wake",
      heldId: 5,
      onTurnComplete: (o) => { outcomes.push(o); },
    }));

    await vi.waitFor(() => { expect(run).toHaveBeenCalledTimes(2); });
    expect(run.mock.calls[1]?.[0].text).toBe("a wake");
    expect(runner.queueLength).toBe(0);
    expect(outcomes).toEqual([]);
    // Its saved copy goes when it runs, not before.
    expect(forgetHeldTurn).not.toHaveBeenCalled();

    run.mock.calls[1]![0].onTurnComplete!(TURN_COMPLETED);
    expect(await handle.settled).toEqual(TURN_COMPLETED);
    expect(outcomes).toEqual([TURN_COMPLETED]);
    runner.dispose({ force: true });
  });

  it("is told of its own setup failure while another entry waits in the queue", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    runner.setSystemTurnDeps({} as never);
    const run = vi.spyOn(runner, "runDispatchedTurn")
      .mockRejectedValueOnce(new Error("no worker"))
      .mockResolvedValue(undefined);
    runner.messageQueue.push({ text: "waiting", execution: "dispatched", onTurnComplete: () => {} });

    const handle = runner.dispatch(testDispatch({ text: "a wake" }));

    const outcome = await handle.settled;
    expect(outcome.status).toBe("errored");
    expect(outcome.detail).toContain("no worker");
    await vi.waitFor(() => { expect(run.mock.calls[1]?.[0].text).toBe("waiting"); });
    runner.dispose({ force: true });
  });
});
