import { describe, it, expect, vi, afterEach } from "vitest";
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

    runner.emitMessage({ type: "claude_interrupted" });
    runner.emitMessage({ type: "error", message: "test" });

    expect(received).toHaveLength(2);
    expect(received[0].type).toBe("claude_interrupted");

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

  it("sendSystemMessage enqueues when agent is running", () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    runner.running = true;
    runner.sendSystemMessage("fix ci");
    expect(runner.queueLength).toBe(1);
    expect(runner.dequeue()?.text).toBe("fix ci");
    runner.dispose({ force: true });
  });

  it("sendSystemMessage starts agent turn when idle with deps set", () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    const fakeAgent = { on: vi.fn(), run: vi.fn(), kill: vi.fn() } as any;
    runner.setSystemTurnDeps({
      agentFactory: () => fakeAgent,
      autoCommit: vi.fn().mockResolvedValue(null),
      scheduleAutoPush: vi.fn(),
      sseBroadcast: vi.fn(),
      persistMessage: vi.fn(),
      resolveAgentSessionId: vi.fn().mockReturnValue("agent-session-123"),
    });

    runner.sendSystemMessage("fix ci");
    // Should start a turn directly — not enqueue
    expect(runner.queueLength).toBe(0);
    expect(runner.running).toBe(true);
    expect(fakeAgent.run).toHaveBeenCalledWith(expect.objectContaining({ prompt: "fix ci" }));
    runner.dispose({ force: true });
  });

  it("sendSystemMessage falls back to enqueue when idle with no deps", () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    // No system turn deps set
    runner.sendSystemMessage("fix ci");
    expect(runner.queueLength).toBe(1);
    runner.dispose();
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
