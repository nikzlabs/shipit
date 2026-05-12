/**
 * Tests for the silent-death breadcrumbs added when an agent container
 * disappears. Two paths:
 *
 *   1. `handleContainerExited` — fires when the Docker event subscriber
 *      sees a `die`/`oom` event. Must write to the per-session log ring
 *      via `broadcastLog` BEFORE disposing the runner, otherwise the
 *      diagnostic snapshot 70 minutes later shows only "Agent process
 *      started" with no trace of the failure.
 *
 *   2. `createMissingContainerReconciler` — the periodic poll that
 *      catches runners whose container vanished without a `die` event
 *      reaching the orchestrator (daemon restart, missed event during
 *      the health-monitor reconnect window, external `docker rm`).
 */

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import {
  handleContainerExited,
  createMissingContainerReconciler,
  setupContainerHealthMonitoring,
} from "../app-lifecycle.js";
import { createOomCircuitBreaker } from "../oom-circuit-breaker.js";
import { createSessionLoopDetector } from "../loop-detector.js";
import type { SessionContainerManager, SessionContainer } from "../session-container.js";
import type { SessionRunnerRegistry, SessionRunnerInterface } from "../session-runner.js";
import type { WsServerMessage, WsLogEntry } from "../../shared/types.js";

interface FakeRunner {
  runner: SessionRunnerInterface;
  emitted: WsServerMessage[];
  disposeCalls: { force?: boolean }[];
}

function makeFakeRunner(sessionId: string): FakeRunner {
  const emitted: WsServerMessage[] = [];
  const disposeCalls: { force?: boolean }[] = [];
  const runner = Object.assign(new EventEmitter(), {
    sessionId,
    sessionDir: "/tmp/x",
    workspaceDir: "/tmp/x",
    running: false,
    queueLength: 0,
    viewerCount: 0,
    lastSseEventAt: 0,
    disposed: false,
    wasInterrupted: false,
    emitMessage: (msg: WsServerMessage) => { emitted.push(msg); },
    getAgent: () => null,
    setAgent: () => undefined,
    getTurnEventBuffer: () => [],
    attachViewer: () => undefined,
    detachViewer: () => undefined,
    waitForPreviewStatus: async () => undefined,
    previewStatusKnown: true,
    buildPreviewStatus: () => ({ type: "preview_status", running: false } as WsServerMessage),
    dispose: (opts?: { force?: boolean }) => { disposeCalls.push(opts ?? {}); },
  }) as unknown as SessionRunnerInterface;
  return { runner, emitted, disposeCalls };
}

function makeFakeRegistry(entries: Map<string, SessionRunnerInterface>): SessionRunnerRegistry {
  return {
    get: (sid: string) => entries.get(sid),
    ids: () => [...entries.keys()],
    dispose: (sid: string, opts?: { force?: boolean }) => {
      entries.get(sid)?.dispose(opts);
    },
  } as unknown as SessionRunnerRegistry;
}

function makeFakeContainerManager(
  containers: Map<string, Partial<SessionContainer>>,
  standby: Set<string>,
): SessionContainerManager {
  return {
    get: (sid: string) => containers.get(sid) as SessionContainer | undefined,
    isStandby: (sid: string) => standby.has(sid),
  } as unknown as SessionContainerManager;
}

describe("handleContainerExited (container_exited breadcrumb)", () => {
  it("writes a server log entry to the per-session ring", () => {
    const { runner } = makeFakeRunner("sess-1");
    const registry = makeFakeRegistry(new Map([["sess-1", runner]]));
    const calls: { sid: string; source: WsLogEntry["source"]; text: string }[] = [];

    handleContainerExited(
      "sess-1",
      137,
      "OOMKilled",
      registry,
      (sid, source, text) => calls.push({ sid, source, text }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      sid: "sess-1",
      source: "server",
      text: expect.stringContaining("OOMKilled") as string,
    });
  });

  it("annotates exit 137 as OOMKilled when no explicit error string is given", () => {
    const { runner } = makeFakeRunner("sess-1");
    const registry = makeFakeRegistry(new Map([["sess-1", runner]]));
    const calls: { sid: string; source: WsLogEntry["source"]; text: string }[] = [];

    handleContainerExited(
      "sess-1",
      137,
      undefined,
      registry,
      (sid, source, text) => calls.push({ sid, source, text }),
    );

    expect(calls[0]?.text).toContain("likely OOMKilled");
  });

  it("emits session_status to the runner and force-disposes", () => {
    const { runner, emitted, disposeCalls } = makeFakeRunner("sess-2");
    const registry = makeFakeRegistry(new Map([["sess-2", runner]]));

    handleContainerExited("sess-2", 1, "crash", registry);

    const status = emitted.find((m) => m.type === "session_status");
    expect(status).toMatchObject({
      type: "session_status",
      sessionId: "sess-2",
      running: false,
      error: expect.stringContaining("crash") as string,
    });
    expect(disposeCalls).toHaveLength(1);
    expect(disposeCalls[0]).toEqual({ force: true });
  });

  it("works when broadcastLog is not wired (defensive)", () => {
    const { runner, disposeCalls } = makeFakeRunner("sess-3");
    const registry = makeFakeRegistry(new Map([["sess-3", runner]]));

    expect(() => handleContainerExited("sess-3", 0, undefined, registry)).not.toThrow();
    expect(disposeCalls).toHaveLength(1);
  });

  it("writes the log ring entry even when the runner is already gone", () => {
    const registry = makeFakeRegistry(new Map());
    const calls: { sid: string; source: WsLogEntry["source"]; text: string }[] = [];

    handleContainerExited(
      "sess-missing",
      137,
      "OOMKilled",
      registry,
      (sid, source, text) => calls.push({ sid, source, text }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sid).toBe("sess-missing");
  });
});

describe("createMissingContainerReconciler (orphan-runner detector)", () => {
  it("force-disposes a runner whose container has vanished and writes a log entry", () => {
    const { runner, emitted, disposeCalls } = makeFakeRunner("sess-orphan");
    const registry = makeFakeRegistry(new Map([["sess-orphan", runner]]));
    // No container for sess-orphan — simulates a missed `die` event.
    const containerManager = makeFakeContainerManager(new Map(), new Set());
    const calls: { sid: string; source: WsLogEntry["source"]; text: string }[] = [];

    const reconcile = createMissingContainerReconciler({
      containerManager,
      runnerRegistry: registry,
      broadcastLog: (sid, source, text) => calls.push({ sid, source, text }),
    });
    reconcile();

    expect(disposeCalls).toEqual([{ force: true }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sid).toBe("sess-orphan");
    expect(calls[0]?.text).toMatch(/vanished/i);
    expect(emitted.find((m) => m.type === "session_status")).toBeDefined();
  });

  it("leaves healthy runners alone when their container is present", () => {
    const { runner, disposeCalls } = makeFakeRunner("sess-ok");
    const registry = makeFakeRegistry(new Map([["sess-ok", runner]]));
    const containerManager = makeFakeContainerManager(
      new Map([["sess-ok", { id: "c1", sessionId: "sess-ok" } as Partial<SessionContainer>]]),
      new Set(),
    );
    const calls: unknown[] = [];

    const reconcile = createMissingContainerReconciler({
      containerManager,
      runnerRegistry: registry,
      broadcastLog: (...args) => calls.push(args),
    });
    reconcile();

    expect(disposeCalls).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("skips standby sessions (warm pool transient race)", () => {
    const { runner, disposeCalls } = makeFakeRunner("sess-warm");
    const registry = makeFakeRegistry(new Map([["sess-warm", runner]]));
    // Container missing AND standby — the warm pool may have a registered
    // runner briefly during claim; don't dispose it.
    const containerManager = makeFakeContainerManager(new Map(), new Set(["sess-warm"]));

    const reconcile = createMissingContainerReconciler({
      containerManager,
      runnerRegistry: registry,
      broadcastLog: () => undefined,
    });
    reconcile();

    expect(disposeCalls).toEqual([]);
  });

  it("handles multiple runners — orphans go, healthy stay", () => {
    const a = makeFakeRunner("sess-a");
    const b = makeFakeRunner("sess-b");
    const c = makeFakeRunner("sess-c");
    const registry = makeFakeRegistry(new Map([
      ["sess-a", a.runner],
      ["sess-b", b.runner],
      ["sess-c", c.runner],
    ]));
    // Only sess-b has a container.
    const containerManager = makeFakeContainerManager(
      new Map([["sess-b", { id: "c-b", sessionId: "sess-b" } as Partial<SessionContainer>]]),
      new Set(),
    );
    const logged: string[] = [];

    const reconcile = createMissingContainerReconciler({
      containerManager,
      runnerRegistry: registry,
      broadcastLog: (sid) => logged.push(sid),
    });
    reconcile();

    expect(a.disposeCalls).toEqual([{ force: true }]);
    expect(b.disposeCalls).toEqual([]);
    expect(c.disposeCalls).toEqual([{ force: true }]);
    expect(logged.sort()).toEqual(["sess-a", "sess-c"]);
  });

  it("is a no-op when no containerManager is wired (local mode)", () => {
    const { runner, disposeCalls } = makeFakeRunner("sess-x");
    const registry = makeFakeRegistry(new Map([["sess-x", runner]]));

    const reconcile = createMissingContainerReconciler({
      containerManager: null,
      runnerRegistry: registry,
      broadcastLog: () => undefined,
    });
    reconcile();

    expect(disposeCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// setupContainerHealthMonitoring: OOM detection + loop force-trip
// ---------------------------------------------------------------------------
// Regression coverage for the bug where field diagnostics showed 3 container
// exits in 3 minutes but breaker.countInWindow stuck at 1 — Docker emitted
// `die` before `oom` for OOM-killed containers, the container-health handler
// deleted the record on the first event, and the subsequent `oom` event hit
// the "not found" early-out, losing the OOM signal entirely.

/**
 * Minimal `SessionContainerManager` stub — just needs to be an EventEmitter
 * the wiring under test can subscribe to. We never invoke create/destroy.
 */
function makeManagerEmitter(): SessionContainerManager {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    getAll: () => [],
    get: () => undefined,
    isStandby: () => false,
  }) as unknown as SessionContainerManager;
}

describe("setupContainerHealthMonitoring → oomBreaker integration", () => {
  function setup(sessionId = "sess-1") {
    const manager = makeManagerEmitter();
    const fake = makeFakeRunner(sessionId);
    const registry = makeFakeRegistry(new Map([[sessionId, fake.runner]]));
    const logs: { sid: string; source: WsLogEntry["source"]; text: string }[] = [];
    const breaker = createOomCircuitBreaker({ windowMs: 60_000, threshold: 3 });
    const loopDetector = createSessionLoopDetector({ threshold: 3, windowMs: 60_000 });
    setupContainerHealthMonitoring(
      manager,
      registry,
      (sid, source, text) => logs.push({ sid, source, text }),
      loopDetector,
      breaker,
    );
    return { manager, fake, breaker, loopDetector, logs, sessionId };
  }

  it("counts exit code 137 as OOM even when error is undefined (die-before-oom case)", () => {
    const { manager, breaker, sessionId } = setup();
    manager.emit("container_exited", sessionId, 137, undefined);
    expect(breaker.getState(sessionId).countInWindow).toBe(1);
  });

  it("counts an explicit error='Out of memory' as OOM (oom-first case)", () => {
    const { manager, breaker, sessionId } = setup();
    manager.emit("container_exited", sessionId, 137, "Out of memory");
    expect(breaker.getState(sessionId).countInWindow).toBe(1);
  });

  it("ignores non-OOM exits (exit 0 / exit 1, no OOM marker)", () => {
    const { manager, breaker, sessionId } = setup();
    manager.emit("container_exited", sessionId, 0, undefined);
    manager.emit("container_exited", sessionId, 1, "crash");
    expect(breaker.getState(sessionId).countInWindow).toBe(0);
  });

  it("trips after 3 mixed OOM signals (1 explicit + 2 die-only with exit 137)", () => {
    // Mirrors the user's prod diagnostic: 1 entry tagged "Out of memory",
    // 2 tagged only by exit code. Pre-fix the breaker stuck at countInWindow=1
    // and never tripped. With Fix A all three count and the 3rd trips.
    const { manager, fake, breaker, logs, sessionId } = setup();
    manager.emit("container_exited", sessionId, 137, "Out of memory");
    manager.emit("container_exited", sessionId, 137, undefined);
    manager.emit("container_exited", sessionId, 137, undefined);
    expect(breaker.isTripped(sessionId)).toBe(true);
    expect(breaker.getState(sessionId).countInWindow).toBe(3);
    expect(fake.emitted.some((m) => m.type === "session_memory_exhausted")).toBe(true);
    expect(logs.some((l) => l.text.includes("Session disabled"))).toBe(true);
  });

  it("force-trips the breaker when the loop detector fires (Fix B)", () => {
    // 3 container_started events in the same window — the loop detector
    // fires, and we force-trip the breaker so the runner factory refuses
    // the 4th create even when individual exits weren't tagged as OOM.
    const { manager, fake, breaker, logs, sessionId } = setup();
    manager.emit("container_started", sessionId);
    manager.emit("container_started", sessionId);
    manager.emit("container_started", sessionId);
    expect(breaker.isTripped(sessionId)).toBe(true);
    expect(fake.emitted.some((m) => m.type === "session_memory_exhausted")).toBe(true);
    expect(logs.some((l) => l.text.includes("LOOP DETECTED"))).toBe(true);
    expect(logs.some((l) => l.text.includes("Session disabled"))).toBe(true);
  });

  it("emits session_memory_exhausted exactly once across both trip paths", () => {
    // OOM record-tripped the breaker; a subsequent loop alert must NOT
    // re-emit because forceTrip is idempotent (justTripped=false after
    // the first trip).
    const { manager, fake, sessionId } = setup();
    manager.emit("container_exited", sessionId, 137, undefined);
    manager.emit("container_exited", sessionId, 137, undefined);
    manager.emit("container_exited", sessionId, 137, undefined);
    // …then a 4th start somehow happens and would re-alert the loop:
    manager.emit("container_started", sessionId);
    manager.emit("container_started", sessionId);
    manager.emit("container_started", sessionId);
    const memoryMsgs = fake.emitted.filter((m) => m.type === "session_memory_exhausted");
    expect(memoryMsgs).toHaveLength(1);
  });
});
