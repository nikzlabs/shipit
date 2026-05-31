import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { SessionRunner, SessionRunnerRegistry } from "./session-runner.js";
import type { AgentId } from "../shared/types.js";

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
    runner.enqueue({ text: "msg1" });
    runner.enqueue({ text: "msg2" });
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
    runner.detachViewer(); // should not go below 0
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

    runner.enqueue({ text: "pending" });
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
    runner.dispatch({ text: "fix ci" });
    expect(runner.queueLength).toBe(1);
    expect(runner.dequeue()?.text).toBe("fix ci");
    runner.dispose({ force: true });
  });

  it("dispatch broadcasts message_queued via emitMessage (docs/150)", () => {
    // The enqueue branch must emit message_queued via the runner's broadcast
    // channel so every attached viewer sees the update, not just the originating
    // socket. Previously the WS handler did this with ctx.send.
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    const received: any[] = [];
    runner.on("message", (msg) => received.push(msg));
    runner.running = true;
    runner.dispatch({ text: "fix ci" });
    const queued = received.find((m) => m.type === "message_queued");
    expect(queued).toMatchObject({ type: "message_queued", text: "fix ci", position: 1 });
    runner.dispose({ force: true });
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
      }),
      scheduleAutoPush: vi.fn(),
      listenerDeps: {
        sessionManager: { setAgentSessionId: vi.fn(), get: vi.fn(), track: vi.fn(), list: vi.fn() } as any,
        chatHistoryManager: { replaceInProgress: vi.fn(), finalizeInProgress: vi.fn(), append: vi.fn() } as any,
        usageManager: { record: vi.fn(), getSessionUsage: vi.fn(), getSessionTokenTotals: vi.fn() } as any,
        authManager: { startOAuthFlow: vi.fn() } as any,
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

    runner.dispatch({ text: "fix ci" });
    // runDispatchedTurn awaits buildRunParams; flush microtasks so the run call lands.
    await new Promise((r) => setImmediate(r));
    // Should start a turn directly — not enqueue
    expect(runner.queueLength).toBe(0);
    expect(runner.running).toBe(true);
    // buildRunParams is async, so let microtasks flush before asserting on run().
    await new Promise((r) => setTimeout(r, 0));
    expect(fakeAgent.run).toHaveBeenCalledWith(expect.objectContaining({ prompt: "fix ci" }));
    runner.dispose({ force: true });
  });

  it("dispatch runs prepareAgentEnv right before buildRunParams (fresh token at spawn)", async () => {
    // Regression for the quick-session "Not logged in" bug: env prep (OAuth
    // token sync-in) must run at spawn time, immediately before run-params are
    // built — the same late moment the WS path uses — not early in the service
    // fn where a sibling session can rotate the single-use refresh token first.
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
      }),
      scheduleAutoPush: vi.fn(),
      listenerDeps: {
        sessionManager: { setAgentSessionId: vi.fn(), get: vi.fn(), track: vi.fn(), list: vi.fn() } as any,
        chatHistoryManager: { replaceInProgress: vi.fn(), finalizeInProgress: vi.fn(), append: vi.fn() } as any,
        usageManager: { record: vi.fn(), getSessionUsage: vi.fn(), getSessionTokenTotals: vi.fn() } as any,
        authManager: { startOAuthFlow: vi.fn() } as any,
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

    runner.dispatch({ text: "fix ci" });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 0));
    expect(callOrder).toEqual(["prepareAgentEnv", "buildRunParams"]);
    expect(fakeAgent.run).toHaveBeenCalled();
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
        sessionManager: { setAgentSessionId: vi.fn(), get: vi.fn(), track: vi.fn(), list: vi.fn() } as any,
        chatHistoryManager: {
          replaceInProgress: vi.fn(),
          finalizeInProgress: vi.fn(),
          append: chatHistoryAppend,
        } as any,
        usageManager: { record: vi.fn(), getSessionUsage: vi.fn(), getSessionTokenTotals: vi.fn() } as any,
        authManager: { startOAuthFlow: vi.fn() } as any,
        sseBroadcast,
        broadcastLog: vi.fn(),
        getSelectedModel: () => undefined,
      },
      buildRunParams: vi.fn().mockRejectedValue(new Error("run params failed")),
    });

    runner.dispatch({ text: "fix ci" });
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
    // No system turn deps set
    runner.dispatch({ text: "fix ci" });
    expect(runner.queueLength).toBe(1);
    runner.dispose();
  });

  it("dispatch threads attachments + permissionMode into the queued message (docs/150)", () => {
    // The drain at runDispatchedTurn previously only carried `text`. This guards
    // the round-trip: an enqueued dispatch retains images, files, uploads,
    // permissionMode, and reviewFilePath so a queued review or attachment-bearing
    // turn doesn't silently lose them when the previous turn finishes.
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    runner.running = true;
    runner.dispatch({
      text: "review please",
      activity: "Reviewing…",
      images: [{ data: "AAA=", mediaType: "image/png" }],
      files: [{ path: "src/foo.ts" }],
      uploads: [{ path: "/uploads/screen.png", type: "upload" as const }],
      permissionMode: "guarded",
      reviewFilePath: "docs/foo.md",
    });
    const queued = runner.dequeue();
    expect(queued).toMatchObject({
      text: "review please",
      activity: "Reviewing…",
      images: [{ data: "AAA=", mediaType: "image/png" }],
      files: [{ path: "src/foo.ts" }],
      uploads: [{ path: "/uploads/screen.png", type: "upload" as const }],
      permissionMode: "guarded",
      reviewFilePath: "docs/foo.md",
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
      runner.enqueue({ text: `msg${i}` });
    }
    expect(runner.queueLength).toBe(50);

    expect(() => runner.enqueue({ text: "overflow" })).toThrow("Message queue is full");
    expect(runner.queueLength).toBe(50);

    runner.dequeue();
    expect(runner.queueLength).toBe(49);
    runner.enqueue({ text: "fits now" });
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
    // Lifecycle events (idle cleanup, transient WS disconnects) must never
    // kill a running agent. dispose() is a no-op while running unless forced.
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

    // force: true must override the protection so shutdown / explicit
    // archive paths still work.
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
    expect(runner.lastViewerDetachAt).toBe(0); // unchanged on attach

    const before = Date.now();
    runner.detachViewer();
    const after = Date.now();
    expect(runner.lastViewerDetachAt).toBeGreaterThanOrEqual(before);
    expect(runner.lastViewerDetachAt).toBeLessThanOrEqual(after);
    runner.dispose();
  });

  it("grace-period timer arms only on LAST detach, never on intermediate detach", async () => {
    // The timestamp is only meaningful when viewerCount === 0 (the idle
    // enforcer never reads it otherwise). Setting it on a 2→1 detach would
    // be a misleading lie. This test pins the multi-viewer semantics.
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    runner.attachViewer();
    runner.attachViewer();
    expect(runner.viewerCount).toBe(2);
    expect(runner.lastViewerDetachAt).toBe(0);

    // Detach one — runner is still actively viewed, no grace period.
    runner.detachViewer();
    expect(runner.viewerCount).toBe(1);
    expect(runner.lastViewerDetachAt).toBe(0);

    // Detach the LAST viewer — NOW the grace timer arms.
    runner.detachViewer();
    expect(runner.viewerCount).toBe(0);
    const firstZero = runner.lastViewerDetachAt;
    expect(firstZero).toBeGreaterThan(0);

    // Defensive: a stray extra detach when count is already 0 must not
    // reset the timer. Without this, a buggy caller could extend the grace
    // period indefinitely.
    await new Promise((r) => setTimeout(r, 5));
    runner.detachViewer();
    expect(runner.lastViewerDetachAt).toBe(firstZero);

    // Re-attach clears so the next 1→0 transition starts a fresh clock.
    runner.attachViewer();
    expect(runner.lastViewerDetachAt).toBe(0);
    runner.detachViewer();
    expect(runner.lastViewerDetachAt).toBeGreaterThanOrEqual(firstZero);
    runner.dispose();
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
