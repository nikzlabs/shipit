import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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
        getWorkspaceDir: () => null,
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
        getWorkspaceDir: () => null,
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
        getWorkspaceDir: () => null,
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
        getWorkspaceDir: () => null,
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
        getWorkspaceDir: () => null,
      },

      "sess-1",
    );
    const tail = result.services[0]?.logTail.split("\n");
    expect(tail).toHaveLength(20);
    expect(tail?.[0]).toBe("line31");
    expect(tail?.[19]).toBe("line50");
  });

  describe("parsedConfig surfacing", () => {
    let tmpDir: string | undefined;

    afterEach(() => {
      if (tmpDir) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        tmpDir = undefined;
      }
    });

    function workspace(yaml?: string): string {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostics-cfg-"));
      if (yaml !== undefined) fs.writeFileSync(path.join(tmpDir, "shipit.yaml"), yaml);
      return tmpDir;
    }

    async function diagnose(workspaceDir: string | null) {
      return getSessionDiagnostics(
        {
          containerManager: fakeContainerManager({ container: null }),
          runnerRegistry: fakeRegistry(fakeRunner()),
          serviceManagers: new Map(),
          getLogBuffer: () => [],
          getWorkspaceDir: () => workspaceDir,
        },
        "sess-1",
      );
    }

    it("returns null when no workspace is assigned", async () => {
      const result = await diagnose(null);
      expect(result.parsedConfig).toBeNull();
    });

    it("returns the parsed agent block from the new schema", async () => {
      const dir = workspace("agent:\n  memory: 3072\n  cpu: 2.0\n  pids: 2048\ncompose: docker-compose.yml\n");
      const result = await diagnose(dir);
      expect(result.parsedConfig?.agent).toMatchObject({ memory: 3072, cpu: 2.0, pids: 2048 });
      expect(result.parsedConfig?.compose).toEqual({ file: "docker-compose.yml", dockerSocket: false });
      expect(result.parsedConfig?.warnings).toEqual([]);
      expect(result.parsedConfig?.parseError).toBeUndefined();
      // No env cap exceeded → effectiveAgent mirrors declared values.
      expect(result.parsedConfig?.effectiveAgent).toMatchObject({ memory: 3072, cpu: 2.0, pids: 2048 });
      // Breaker dep wasn't injected → payload reports null.
      expect(result.oomBreaker).toBeNull();
    });

    it("surfaces warnings for legacy `resources:` keys instead of silently using their values", async () => {
      // Regression: the old parser silently dropped `resources.memory: 3072`
      // to a 1 GiB default and the container OOM'd. Now the user sees both
      // the warning AND the actual default the container booted on.
      const dir = workspace("resources:\n  memory: 3072\n  cpu: 2.0\n  pids: 2048\n");
      const result = await diagnose(dir);
      expect(result.parsedConfig?.agent.memory).toBe(1024); // library default
      expect(result.parsedConfig?.warnings.join("\n")).toMatch(/`resources` block has been replaced/);
    });

    it("surfaces env-cap clamp warnings alongside the effective value", async () => {
      // Sibling regression: even when shipit.yaml is new-schema and parses
      // cleanly, a low MAX_SESSION_MEMORY_MB silently shrinks the declared
      // memory. The diagnostics panel must show both the declared and the
      // post-clamp value so the operator can spot the cap.
      const prevCap = process.env.MAX_SESSION_MEMORY_MB;
      process.env.MAX_SESSION_MEMORY_MB = "1024";
      try {
        const dir = workspace("agent:\n  memory: 3072\n");
        const result = await diagnose(dir);
        expect(result.parsedConfig?.agent.memory).toBe(3072);
        expect(result.parsedConfig?.effectiveAgent.memory).toBe(1024);
        expect(result.parsedConfig?.warnings.join("\n")).toMatch(/MAX_SESSION_MEMORY_MB/);
      } finally {
        if (prevCap === undefined) delete process.env.MAX_SESSION_MEMORY_MB;
        else process.env.MAX_SESSION_MEMORY_MB = prevCap;
      }
    });

    it("captures YAML parse errors without failing the request", async () => {
      const dir = workspace("agent: not_a_mapping\n");
      const result = await diagnose(dir);
      expect(result.parsedConfig?.parseError).toMatch(/agent/);
    });
  });

  describe("bootedLimits surfacing (W4b)", () => {
    let tmpDir: string | undefined;

    afterEach(() => {
      if (tmpDir) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        tmpDir = undefined;
      }
    });

    it("includes the container's bootedLimits in health", async () => {
      const sc = {
        id: "abcdef1234567890",
        workerUrl: "http://127.0.0.1:1",
        status: "running",
        bootedLimits: { memoryLimit: 1024 * 1024 * 1024, cpuQuota: 50_000, pidsLimit: 256 },
      } as SessionContainer;
      const result = await getSessionDiagnostics(
        {
          containerManager: fakeContainerManager({ container: sc }),
          runnerRegistry: fakeRegistry(fakeRunner()),
          serviceManagers: new Map(),
          getLogBuffer: () => [],
          getWorkspaceDir: () => null,
        },
        "sess-1",
      );
      expect(result.health).not.toHaveProperty("error");
      const health = result.health as Extract<typeof result.health, { containerState: string }>;
      expect(health.bootedLimits).toEqual({
        memoryLimit: 1024 * 1024 * 1024,
        cpuQuota: 50_000,
        pidsLimit: 256,
      });
    });

    it("surfaces booted vs parsed distinctly when they disagree (the warm→claim incident)", async () => {
      // The container booted on a 1 GiB cgroup...
      const sc = {
        id: "abcdef1234567890",
        workerUrl: "http://127.0.0.1:1",
        status: "running",
        bootedLimits: { memoryLimit: 1024 * 1024 * 1024, cpuQuota: 50_000, pidsLimit: 256 },
      } as SessionContainer;
      // ...while the workspace's shipit.yaml (read live) now declares 3 GiB.
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostics-booted-"));
      fs.writeFileSync(path.join(tmpDir, "shipit.yaml"), "agent:\n  memory: 3072\n");

      const result = await getSessionDiagnostics(
        {
          containerManager: fakeContainerManager({ container: sc }),
          runnerRegistry: fakeRegistry(fakeRunner()),
          serviceManagers: new Map(),
          getLogBuffer: () => [],
          getWorkspaceDir: () => tmpDir ?? null,
        },
        "sess-1",
      );

      const health = result.health as Extract<typeof result.health, { containerState: string }>;
      // Both values are present and distinct — the panel renders them side
      // by side so the mismatch is visible without kernel-log inspection.
      expect(health.bootedLimits?.memoryLimit).toBe(1024 * 1024 * 1024); // booted
      expect(result.parsedConfig?.effectiveAgent.memory).toBe(3072);     // parsed (MiB)
      expect(health.bootedLimits!.memoryLimit / 1024 / 1024).not.toBe(
        result.parsedConfig?.effectiveAgent.memory,
      );
    });

    it("reports bootedLimits: null when no container is tracked", async () => {
      const result = await getSessionDiagnostics(
        {
          containerManager: fakeContainerManager({ container: null }),
          runnerRegistry: fakeRegistry(fakeRunner()),
          serviceManagers: new Map(),
          getLogBuffer: () => [],
          getWorkspaceDir: () => null,
        },
        "sess-1",
      );
      const health = result.health as Extract<typeof result.health, { containerState: string }>;
      expect(health.bootedLimits).toBeNull();
    });
  });

  describe("oomBreaker surfacing", () => {
    it("returns the breaker state when a breaker is wired", async () => {
      const { createOomCircuitBreaker } = await import("../oom-circuit-breaker.js");
      const breaker = createOomCircuitBreaker({ windowMs: 60_000, threshold: 2 });
      breaker.recordOom("sess-1");
      breaker.recordOom("sess-1"); // trips

      const result = await getSessionDiagnostics(
        {
          containerManager: fakeContainerManager({ container: null }),
          runnerRegistry: fakeRegistry(fakeRunner()),
          serviceManagers: new Map(),
          getLogBuffer: () => [],
          getWorkspaceDir: () => null,
          oomBreaker: breaker,
        },
        "sess-1",
      );
      expect(result.oomBreaker?.tripped).toBe(true);
      expect(result.oomBreaker?.countInWindow).toBe(2);
      expect(result.oomBreaker?.threshold).toBe(2);
    });
  });

  it("trims recent logs to the last 50 entries", async () => {
    const all: WsLogEntry[] = Array.from({ length: 75 }, (_, i) => entry(`msg${i + 1}`));
    const result = await getSessionDiagnostics(
      {
        containerManager: fakeContainerManager({ container: null }),
        runnerRegistry: fakeRegistry(fakeRunner()),
        serviceManagers: new Map(),
        getLogBuffer: () => all,
        getWorkspaceDir: () => null,
      },
      "sess-1",
    );
    expect(result.recentLogs).toHaveLength(50);
    expect(result.recentLogs[0]?.text).toBe("msg26");
    expect(result.recentLogs[49]?.text).toBe("msg75");
  });
});
