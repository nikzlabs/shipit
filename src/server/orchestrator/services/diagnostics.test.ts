import { describe, it, expect } from "vitest";
import type { SessionContainerManager, SessionContainer } from "../session-container.js";
import type { SessionRunnerRegistry, SessionRunnerInterface } from "../session-runner.js";
import type { ServiceManager, ManagedService } from "../service-manager.js";
import type { WsLogEntry, WsServerMessage } from "../../shared/types.js";
import { getSessionDiagnostics } from "./diagnostics.js";

// ---- Test doubles ----

function fakeContainerManager(opts: { container: SessionContainer | null; lastErr?: { error: string; at: number } | null } = { container: null }): SessionContainerManager {
  const sc = opts.container;
  const lastErr = opts.lastErr ?? null;
  return {
    get: () => sc ?? undefined,
    getLastCreateError: () => lastErr,
  } as unknown as SessionContainerManager;
}

function fakeRunner(overrides: Partial<SessionRunnerInterface> & { turnEvents?: WsServerMessage[]; lastSseEventAt?: number } = {}): SessionRunnerInterface {
  const turnEvents = overrides.turnEvents ?? [];
  return {
    sessionId: "sess-1",
    running: false,
    viewerCount: 0,
    queueLength: 0,
    lastSseEventAt: 0,
    getTurnEventBuffer: () => turnEvents,
    ...overrides,
  } as unknown as SessionRunnerInterface;
}

function fakeRegistry(runner: SessionRunnerInterface | null): SessionRunnerRegistry {
  return {
    get: () => runner ?? undefined,
  } as unknown as SessionRunnerRegistry;
}

function fakeServiceManager(opts: {
  services: ManagedService[];
  logs?: Record<string, string>;
  startError?: string | null;
}): ServiceManager {
  const logs = opts.logs ?? {};
  return {
    getServices: () => opts.services,
    getLogBuffer: (name: string) => logs[name] ?? "",
    startError: opts.startError ?? null,
  } as unknown as ServiceManager;
}

function entry(text: string, ts = "2026-05-07T12:00:00.000Z"): WsLogEntry {
  return { type: "log_entry", source: "server", text, timestamp: ts };
}

// ---- Tests ----

describe("getSessionDiagnostics", () => {
  it("returns the full payload when everything is wired", async () => {
    const sc = { id: "abcdef1234567890", workerUrl: "http://w", status: "running" } as SessionContainer;
    const runner = fakeRunner({
      running: true,
      viewerCount: 2,
      queueLength: 1,
      lastSseEventAt: 1_700_000_000_000,
      turnEvents: [{ type: "agent_started" } as unknown as WsServerMessage],
    });
    const mgr = fakeServiceManager({
      services: [
        { name: "web", status: "running", preview: "auto", port: 3000, containerIp: "172.18.0.5" } as ManagedService,
        { name: "db", status: "error", preview: "manual", error: "exit 137" } as ManagedService,
      ],
      logs: { web: "line1\nline2\nline3\n" },
      startError: null,
    });
    const result = await getSessionDiagnostics(
      {
        containerManager: fakeContainerManager({ container: sc }),
        runnerRegistry: fakeRegistry(runner),
        serviceManagers: new Map([["sess-1", mgr]]),
        getLogBuffer: () => [entry("hello")],
      },
      "sess-1",
    );
    // The health probe will try to reach the worker — in the test env it'll
    // fail fast (workerReachable: false). That's fine; we just check the shape.
    expect(result.sessionId).toBe("sess-1");
    expect(result.health).toMatchObject({ containerState: "running" });
    expect(result.services).toHaveLength(2);
    expect(result.services[0]).toMatchObject({ name: "web", status: "running", port: 3000, containerIp: "172.18.0.5" });
    expect(result.services[0]?.logTail).toBe("line1\nline2\nline3");
    expect(result.services[1]).toMatchObject({ name: "db", status: "error", error: "exit 137" });
    expect(result.runner).toEqual({
      running: true,
      viewerCount: 2,
      queueLength: 1,
      lastSseEventAt: 1_700_000_000_000,
      turnEventBufferSize: 1,
      disposed: false,
    });
    expect(result.recentLogs).toHaveLength(1);
    expect(result.stackStartError).toBeNull();
    expect(typeof result.generatedAt).toBe("number");
  });

  it("degrades gracefully when no container manager is configured", async () => {
    const result = await getSessionDiagnostics(
      {
        containerManager: null,
        runnerRegistry: fakeRegistry(fakeRunner()),
        serviceManagers: new Map(),
        getLogBuffer: () => [],
      },
      "sess-1",
    );
    expect(result.health).toEqual({ error: "Container manager not available" });
    expect(result.services).toEqual([]);
    expect(result.runner).not.toBeNull();
    expect(result.recentLogs).toEqual([]);
  });

  it("returns null runner when the registry has no entry", async () => {
    const result = await getSessionDiagnostics(
      {
        containerManager: fakeContainerManager({ container: null }),
        runnerRegistry: fakeRegistry(null),
        serviceManagers: new Map(),
        getLogBuffer: () => [],
      },
      "sess-missing",
    );
    expect(result.runner).toBeNull();
  });

  it("surfaces the compose stack startError", async () => {
    const mgr = fakeServiceManager({ services: [], startError: "compose up failed: image pull denied" });
    const result = await getSessionDiagnostics(
      {
        containerManager: fakeContainerManager({ container: null }),
        runnerRegistry: fakeRegistry(fakeRunner()),
        serviceManagers: new Map([["sess-1", mgr]]),
        getLogBuffer: () => [],
      },
      "sess-1",
    );
    expect(result.stackStartError).toBe("compose up failed: image pull denied");
  });

  it("trims service log tails to 20 lines", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line${i + 1}`);
    const mgr = fakeServiceManager({
      services: [{ name: "web", status: "running", preview: "auto" } as ManagedService],
      logs: { web: `${lines.join("\n")}\n` },
    });
    const result = await getSessionDiagnostics(
      {
        containerManager: fakeContainerManager({ container: null }),
        runnerRegistry: fakeRegistry(fakeRunner()),
        serviceManagers: new Map([["sess-1", mgr]]),
        getLogBuffer: () => [],
      },
      "sess-1",
    );
    const tail = result.services[0]?.logTail.split("\n");
    expect(tail).toHaveLength(20);
    expect(tail?.[0]).toBe("line31");
    expect(tail?.[19]).toBe("line50");
  });

  it("trims recent logs to the last 50 entries", async () => {
    const all: WsLogEntry[] = Array.from({ length: 75 }, (_, i) => entry(`msg${i + 1}`));
    const result = await getSessionDiagnostics(
      {
        containerManager: fakeContainerManager({ container: null }),
        runnerRegistry: fakeRegistry(fakeRunner()),
        serviceManagers: new Map(),
        getLogBuffer: () => all,
      },
      "sess-1",
    );
    expect(result.recentLogs).toHaveLength(50);
    expect(result.recentLogs[0]?.text).toBe("msg26");
    expect(result.recentLogs[49]?.text).toBe("msg75");
  });
});
