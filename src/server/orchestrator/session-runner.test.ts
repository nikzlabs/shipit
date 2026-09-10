import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { AgentTurnAdmissionError, SessionRunner, SessionRunnerRegistry, sessionHasLiveAgent } from "./session-runner.js";
import { ContainerSessionRunner } from "./container-session-runner.js";
import {
  prepareSessionAgentEnvironment,
  PUSH_AGENT_SECRETS_TIMEOUT_MS,
} from "./session-agent-env.js";
import type { AgentId } from "../shared/types.js";
import { testDispatch } from "./integration_tests/dispatch-test-helpers.js";
import { TURN_COMPLETED } from "./turn-settlement.js";

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

  it("manages message queue", () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    expect(runner.queueLength).toBe(0);
    runner.enqueue({ text: "msg1", execution: "interactive" });
    runner.enqueue({ text: "msg2", execution: "interactive" });
    expect(runner.queueLength).toBe(2);

    const snapshot = runner.getQueueSnapshot();
    expect(snapshot).toEqual([
      { text: "msg1", position: 1 },
      { text: "msg2", position: 2 },
    ]);

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

    runner.emitMessage({ type: "agent_interrupted" });
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
        sessionManager: { setAgentSessionId: vi.fn(), get: vi.fn(), track: vi.fn(), setMuted: vi.fn(), list: vi.fn(), setLastTurnErrored: vi.fn() } as any,
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

  it("planning#256: a systemTurn dispatch is NEVER steered into a running user turn — it enqueues, keeping its onTurnComplete", () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    runner.setSystemTurnDeps(steerDeps({ liveSteering: true }));
    const sent: string[] = [];
    runner.setAgent({ sendUserMessage: (t: string) => sent.push(t), kill: () => {} } as any);
    runner.running = true;
    runner.isStreamingActive = true;
    expect(runner.systemTurnInProgress).toBe(false);

    const completions: { errored: boolean }[] = [];
    runner.dispatch(testDispatch({
      text: "child PR merged — resume the rebase",
      systemTurn: true,
      onTurnComplete: (o) => completions.push(o),
    }));

    expect(sent).toEqual([]);
    expect(runner.queueLength).toBe(1);
    const queued = runner.messageQueue[0]!;
    expect(queued.systemTurn).toBe(true);
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
    runner.isStreamingActive = true;

    runner.dispatch(testDispatch({ text: "awaited follow-up", onTurnComplete: () => {} }));

    expect(sent).toEqual([]);
    expect(runner.queueLength).toBe(1);
    expect(runner.messageQueue[0]!.onTurnComplete).toBeTypeOf("function");

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
    runner.isStreamingActive = true;

    runner.systemTurnInProgress = true;
    runner.dispatch(testDispatch({ text: "buffered note" }));
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
        sessionManager: { setAgentSessionId: vi.fn(), get: vi.fn(), track: vi.fn(), setMuted: vi.fn(), list: vi.fn(), setLastTurnErrored: vi.fn() } as any,
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
        sessionManager: { setAgentSessionId: vi.fn(), get: vi.fn(), track: vi.fn(), setMuted: vi.fn(), list: vi.fn(), setLastTurnErrored: vi.fn() } as any,
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
        sessionManager: { setAgentSessionId: vi.fn(), get: vi.fn(), track: vi.fn(), setMuted: vi.fn(), list: vi.fn(), setLastTurnErrored: vi.fn() } as any,
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
        sessionManager: { setAgentSessionId: vi.fn(), get: vi.fn(), track: vi.fn(), setMuted: vi.fn(), list: vi.fn(), setLastTurnErrored: vi.fn() } as any,
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

  it("retires the resident process before env prep on a system turn (merge wake)", async () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    const order: string[] = [];
    const resident = {
      on: vi.fn(),
      run: vi.fn(),
      emit: vi.fn(),
      kill: vi.fn(() => { order.push("kill-resident"); }),
      removeAllListeners: vi.fn(),
      sendUserMessage: vi.fn(),
    } as any;
    const fresh = { on: vi.fn(), run: vi.fn(), kill: vi.fn(), removeAllListeners: vi.fn() } as any;
    let agentAtEnvPrep: unknown = "unset";
    const prepareAgentEnv = vi.fn().mockImplementation(async () => {
      order.push("env-prep");
      agentAtEnvPrep = runner.getAgent();
    });
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
        sessionManager: { setAgentSessionId: vi.fn(), get: vi.fn(), track: vi.fn(), setMuted: vi.fn(), list: vi.fn(), setLastTurnErrored: vi.fn() } as any,
        chatHistoryManager: { replaceInProgress: vi.fn(), finalizeInProgress: vi.fn(), append: vi.fn() } as any,
        usageManager: { record: vi.fn(), getSessionUsage: vi.fn(), getSessionTokenTotals: vi.fn() } as any,
        sseBroadcast: vi.fn(),
        broadcastLog: vi.fn(),
        getSelectedModel: () => undefined,
      },
      prepareAgentEnv,
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "merged", cwd: "/tmp/s1" }),
    });

    runner.dispatch(testDispatch({ text: "merged", systemTurn: true }));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 0));

    expect(resident.sendUserMessage).not.toHaveBeenCalled();
    expect(fresh.run).toHaveBeenCalledWith(expect.objectContaining({ prompt: "merged" }));
    expect(order).toEqual(["kill-resident", "env-prep"]);
    // The incoming agent occupies the slot before it starts.
    expect(agentAtEnvPrep).toBe(fresh);
    expect(agentAtEnvPrep).not.toBe(resident);

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
      clearAgentSessionId: vi.fn(),
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
        sessionManager: { setAgentSessionId: vi.fn(), get: vi.fn(), track: vi.fn(), setMuted: vi.fn(), list: vi.fn(), setLastTurnErrored: vi.fn() } as any,
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
        sessionManager: { setAgentSessionId: vi.fn(), get: vi.fn(), track: vi.fn(), setMuted: vi.fn(), list: vi.fn(), setLastTurnErrored: vi.fn() } as any,
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
