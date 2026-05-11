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
} from "../app-lifecycle.js";
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
