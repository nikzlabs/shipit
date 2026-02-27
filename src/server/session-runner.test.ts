import { describe, it, expect, vi, afterEach } from "vitest";
import { SessionRunner, SessionRunnerRegistry } from "./session-runner.js";
import type { AgentId } from "./agents/agent-process.js";

describe("SessionRunner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("tracks running state", () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
      idleTimeoutMs: 60_000,
    });
    expect(runner.running).toBe(false);
    runner.running = true;
    expect(runner.running).toBe(true);
    runner.dispose();
  });

  it("manages message queue", () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
      idleTimeoutMs: 60_000,
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
      idleTimeoutMs: 60_000,
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
      idleTimeoutMs: 60_000,
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
      idleTimeoutMs: 60_000,
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
      idleTimeoutMs: 60_000,
    });
    const idleSpy = vi.fn();
    runner.on("idle", idleSpy);

    runner.enqueue({ text: "pending" });
    runner.running = false;
    runner.onAgentFinished();
    expect(idleSpy).not.toHaveBeenCalled();
    runner.dispose();
  });

  it("enforces message queue cap of 50", () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
      idleTimeoutMs: 60_000,
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
      idleTimeoutMs: 60_000,
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
    r1.dispose();
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

  it("evicts idle runners when at capacity", () => {
    const registry = new SessionRunnerRegistry({ maxConcurrentRunners: 2 });
    const r1 = registry.getOrCreate("s1", "/tmp/s1", "claude" as AgentId);
    registry.getOrCreate("s2", "/tmp/s2", "claude" as AgentId);

    const r3 = registry.getOrCreate("s3", "/tmp/s3", "claude" as AgentId);
    expect(r3.sessionId).toBe("s3");
    expect(r1.disposed).toBe(true);

    r3.dispose();
  });

  it("throws when all runners are active and at capacity", () => {
    const registry = new SessionRunnerRegistry({ maxConcurrentRunners: 1 });
    const r1 = registry.getOrCreate("s1", "/tmp/s1", "claude" as AgentId);
    r1.running = true;
    r1.attachViewer();

    expect(() => {
      registry.getOrCreate("s2", "/tmp/s2", "claude" as AgentId);
    }).toThrow("Maximum concurrent session runners reached");

    r1.dispose();
  });

  it("auto-removes disposed runners from registry", () => {
    const registry = new SessionRunnerRegistry();
    const r = registry.getOrCreate("s1", "/tmp/s1", "claude" as AgentId);
    r.dispose();
    expect(registry.get("s1")).toBeUndefined();
  });
});
