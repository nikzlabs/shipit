import { harnessesForLoginIntegration } from "../shared/catalogue/index.js";
import type { LoginIntegrationId } from "../shared/catalogue/types.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  buildRunnerFactory,
  createIdleEnforcer,
  runMcpOAuthStartupRefresh,
  scheduleStartupTasks,
  wireEventHandlers,
  markProviderAccountUnauthenticated,
  markProviderAccountReauthenticated,
  resolveAutoStartDeps,
} from "./app-lifecycle.js";
import {
  ensureLocalAgentOpsHost,
  localAgentOpsSpawnEnv,
  resetLocalAgentOpsForTests,
} from "./local-agent-ops.js";
import { SessionRunner, SessionRunnerRegistry } from "./session-runner.js";
import type { SystemTurnDeps } from "./session-runner.js";
import { ContainerSessionRunner } from "./container-session-runner.js";
import { CredentialStore } from "./credential-store.js";
import { ProviderAccountManager } from "./provider-account-manager.js";
import { SessionManager } from "./sessions.js";
import { createTestDatabaseManager } from "./integration_tests/test-helpers.js";
import type { DockerMemoryStats } from "../shared/types.js";
import type { AgentId, AgentProcess, SessionInfo } from "../shared/types.js";
import type { AgentMcpWriteContext } from "../shared/types/agent-types.js";
import type { AgentAuthManager } from "./agent-auth-manager.js";
import type { GitHubAuthManager } from "./github-auth.js";
import type { AgentRegistry } from "../shared/agent-registry.js";
import type { SessionContainerManager } from "./session-container.js";
import { TEST_CREDENTIALS_DIR } from "./credentials-test-helpers.js";

interface FakeContainer { sessionId: string }

describe("resolveAutoStartDeps", () => {
  it("keeps local-mode credentials in the writable ShipIt state directory", () => {
    expect(resolveAutoStartDeps({
      RUNTIME_MODE: "local",
      SHIPIT_STATE_DIR: "/workspace/.inner-shipit",
    })).toEqual({
      serveStatic: true,
      credentialsDir: "/workspace/.inner-shipit/credentials",
    });
  });

  it("preserves the containerized credentials default outside local mode", () => {
    expect(resolveAutoStartDeps({
      RUNTIME_MODE: "containerized",
      SHIPIT_STATE_DIR: "/workspace/.inner-shipit",
    })).toEqual({ serveStatic: true });
  });
});

function makeContainerManager(opts: {
  containers: FakeContainer[];
  standby?: Set<string>;
  destroy?: (sid: string) => Promise<void>;
  destroyAgentContainer?: (sid: string) => Promise<void>;
}): SessionContainerManager {
  const standby = opts.standby ?? new Set<string>();
  return {
    getAll: () => opts.containers,
    isStandby: (sid: string) => standby.has(sid),
    destroy: opts.destroy ?? (async () => {}),
    destroyAgentContainer: opts.destroyAgentContainer ?? opts.destroy ?? (async () => {}),
  } as unknown as SessionContainerManager;
}

function overBudget(): DockerMemoryStats {
  return { usedBytes: 95, totalBytes: 100, budgetBytes: 100 };
}

function overBudgetWith(bySession: Record<string, { agentBytes?: number; serviceBytes?: number }>): DockerMemoryStats {
  return {
    usedBytes: 95,
    totalBytes: 100,
    budgetBytes: 100,
    bySession: Object.fromEntries(
      Object.entries(bySession).map(([k, v]) => [k, { agentBytes: v.agentBytes ?? 0, serviceBytes: v.serviceBytes ?? 0 }]),
    ),
  };
}

function underBudget(): DockerMemoryStats {
  return { usedBytes: 10, totalBytes: 100, budgetBytes: 100 };
}

describe("createIdleEnforcer", () => {
  let registry: SessionRunnerRegistry;

  beforeEach(() => {
    registry = new SessionRunnerRegistry();
  });

  afterEach(() => {
    vi.useRealTimers();
    registry.disposeAll();
  });

  it("exempts reserved sessions from both idle and memory-pressure eviction", () => {
    const containers = [{ sessionId: "reserved" }, { sessionId: "ordinary" }];
    const destroy = vi.fn().mockResolvedValue(undefined);
    const cm = makeContainerManager({ containers, destroy });
    registry.getOrCreate("reserved", "/tmp/reserved", "claude" as AgentId);
    registry.getOrCreate("ordinary", "/tmp/ordinary", "claude" as AgentId);

    createIdleEnforcer({
      containerManager: cm,
      runnerRegistry: registry,
      sessionManager: {
        get: (id: string) => id === "reserved" ? { keepPreviewRunning: true } : undefined,
      } as any,
      getMemoryStats: () => ({ usedBytes: 95, totalBytes: 100 }),
    })();

    expect(destroy).toHaveBeenCalledWith("ordinary");
    expect(destroy).not.toHaveBeenCalledWith("reserved");
    expect(registry.get("reserved")).toBeDefined();
  });

  it("docs/241: does not exempt an archived session carrying a stale reservation", () => {
    const containers = [{ sessionId: "stale" }];
    const destroy = vi.fn().mockResolvedValue(undefined);
    const cm = makeContainerManager({ containers, destroy });
    registry.getOrCreate("stale", "/tmp/stale", "claude" as AgentId);

    createIdleEnforcer({
      containerManager: cm,
      runnerRegistry: registry,
      sessionManager: {
        get: () => ({ keepPreviewRunning: true, userArchived: true, archived: true }),
      } as any,
      getMemoryStats: () => ({ usedBytes: 95, totalBytes: 100 }),
    })();

    expect(destroy).toHaveBeenCalledWith("stale");
  });

  it("never disposes a runner whose agent is running, even when over the limit", () => {
    const containers = [
      { sessionId: "a" }, { sessionId: "b" }, { sessionId: "c" },
    ];
    const destroy = vi.fn().mockResolvedValue(undefined);
    const cm = makeContainerManager({ containers, destroy });

    for (const c of containers) {
      const r = registry.getOrCreate(c.sessionId, `/tmp/${c.sessionId}`, "claude" as AgentId);
      r.running = true;
    }

    const enforce = createIdleEnforcer({
      containerManager: cm,
      runnerRegistry: registry,
      getMemoryStats: overBudget,
    });
    enforce();

    expect(destroy).not.toHaveBeenCalled();
    for (const c of containers) {
      expect(registry.get(c.sessionId)?.disposed).toBe(false);
    }

    for (const c of containers) {
      registry.dispose(c.sessionId, { force: true });
    }
  });

  it("never disposes a runner whose viewer is attached, even when over the limit", () => {
    const containers = [
      { sessionId: "a" }, { sessionId: "b" }, { sessionId: "c" },
    ];
    const destroy = vi.fn().mockResolvedValue(undefined);
    const cm = makeContainerManager({ containers, destroy });

    for (const c of containers) {
      const r = registry.getOrCreate(c.sessionId, `/tmp/${c.sessionId}`, "claude" as AgentId);
      r.attachViewer();
    }

    createIdleEnforcer({
      containerManager: cm,
      runnerRegistry: registry,
      getMemoryStats: overBudget,
    })();

    expect(destroy).not.toHaveBeenCalled();
    for (const c of containers) {
      expect(registry.get(c.sessionId)?.disposed).toBe(false);
    }
  });

  it("never disposes a runner holding outstanding background tasks", () => {
    const containers = [
      { sessionId: "a" }, { sessionId: "b" }, { sessionId: "c" },
    ];
    const destroy = vi.fn().mockResolvedValue(undefined);
    const cm = makeContainerManager({ containers, destroy });

    for (const c of containers) {
      const r = registry.getOrCreate(c.sessionId, `/tmp/${c.sessionId}`, "claude" as AgentId);
      r.isStreamingActive = true;
      r.setBackgroundTasks([{ id: `task-${c.sessionId}`, description: "npm test" }]);
      expect(r.running).toBe(false);
      expect(r.agentBusy).toBe(true);
    }

    createIdleEnforcer({
      containerManager: cm,
      runnerRegistry: registry,
      getMemoryStats: overBudget,
    })();

    expect(destroy).not.toHaveBeenCalled();
    for (const c of containers) {
      expect(registry.get(c.sessionId)?.disposed).toBe(false);
    }
  });

  it("reaps a runner once its background tasks drain", () => {
    const containers = [{ sessionId: "a" }, { sessionId: "b" }];
    const destroy = vi.fn().mockResolvedValue(undefined);
    const cm = makeContainerManager({ containers, destroy });

    for (const c of containers) {
      const r = registry.getOrCreate(c.sessionId, `/tmp/${c.sessionId}`, "claude" as AgentId);
      r.isStreamingActive = true;
      r.setBackgroundTasks([{ id: "t1" }]);
    }
    for (const c of containers) registry.get(c.sessionId)!.setBackgroundTasks([]);

    createIdleEnforcer({
      containerManager: cm,
      runnerRegistry: registry,
      getMemoryStats: () => overBudgetWith({ a: { agentBytes: 1 }, b: { agentBytes: 1 } }),
    })();

    expect(destroy).toHaveBeenCalledTimes(2);
  });

  it("ignores background tasks when no streaming process is resident", () => {
    const containers = [{ sessionId: "a" }];
    const destroy = vi.fn().mockResolvedValue(undefined);
    const cm = makeContainerManager({ containers, destroy });

    const r = registry.getOrCreate("a", "/tmp/a", "claude" as AgentId);
    r.setBackgroundTasks([{ id: "t1" }]);
    r.isStreamingActive = false;
    expect(r.agentBusy).toBe(false);

    createIdleEnforcer({
      containerManager: cm,
      runnerRegistry: registry,
      getMemoryStats: overBudget,
    })();

    expect(destroy).toHaveBeenCalledWith("a");
  });

  it("never destroys the container of a runner with an in-flight sub-agent spawn", async () => {
    const containers = [{ sessionId: "consulting" }, { sessionId: "idle" }];
    const destroy = vi.fn().mockResolvedValue(undefined);
    const cm = makeContainerManager({ containers, destroy });

    const consulting = registry.getOrCreate("consulting", "/tmp/consulting", "claude" as AgentId);
    registry.getOrCreate("idle", "/tmp/idle", "claude" as AgentId);

    const agent = Object.assign(new EventEmitter(), { run: vi.fn(), kill: vi.fn() });
    consulting.setSystemTurnDeps({
      agentFactory: () => agent as unknown as AgentProcess,
    } as unknown as SystemTurnDeps);
    const spawned = consulting.spawnSubAgent({
      agentId: "codex" as AgentId,
      prompt: "review this branch",
      spawnId: "spawn-1",
      depth: 0,
      model: "gpt-5.6-sol",
      timeoutMs: 10 * 60_000,
    });

    expect(consulting.running).toBe(false);
    expect(consulting.viewerCount).toBe(0);
    expect(consulting.subAgentSpawnsInFlight).toBe(1);
    expect(consulting.agentBusy).toBe(true);

    const enforce = createIdleEnforcer({
      containerManager: cm,
      runnerRegistry: registry,
      getMemoryStats: overBudget,
    });
    enforce();

    expect(destroy).not.toHaveBeenCalledWith("consulting");
    expect(consulting.disposed).toBe(false);
    expect(destroy).toHaveBeenCalledWith("idle");

    agent.emit("done");
    await spawned;
    expect(consulting.subAgentSpawnsInFlight).toBe(0);
    expect(consulting.agentBusy).toBe(false);

    enforce();
    expect(destroy).toHaveBeenCalledWith("consulting");
  });

  it("leaves the container alone when the runner declines disposal", () => {
    const containers = [{ sessionId: "stubborn" }];
    const destroy = vi.fn().mockResolvedValue(undefined);
    const cm = makeContainerManager({ containers, destroy });

    const runner = registry.getOrCreate("stubborn", "/tmp/stubborn", "claude" as AgentId);
    const declining = runner as unknown as { dispose: (opts?: { force?: boolean }) => void };
    const origDispose = declining.dispose.bind(runner);
    declining.dispose = (opts?: { force?: boolean }) => {
      if (!opts?.force) return;
      origDispose(opts);
    };

    createIdleEnforcer({
      containerManager: cm,
      runnerRegistry: registry,
      getMemoryStats: overBudget,
    })();

    expect(destroy).not.toHaveBeenCalled();
    expect(runner.disposed).toBe(false);
  });

  it("reclaims nothing while ShipIt is inside its memory budget", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const containers = [
      { sessionId: "a" }, { sessionId: "b" }, { sessionId: "c" },
    ];
    const destroy = vi.fn().mockResolvedValue(undefined);
    const cm = makeContainerManager({ containers, destroy });

    for (const c of containers) {
      const r = registry.getOrCreate(c.sessionId, `/tmp/${c.sessionId}`, "claude" as AgentId);
      r.attachViewer();
      r.detachViewer();
    }

    createIdleEnforcer({
      containerManager: cm,
      runnerRegistry: registry,
      getMemoryStats: underBudget,
    })();

    expect(destroy).not.toHaveBeenCalled();
    for (const c of containers) {
      expect(registry.get(c.sessionId)?.disposed).toBe(false);
    }
  });

  it("reclaims longest-idle first and stops once back inside the budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const containers = [
      { sessionId: "old1" }, { sessionId: "old2" }, { sessionId: "fresh" },
    ];
    const destroy = vi.fn().mockResolvedValue(undefined);
    const cm = makeContainerManager({ containers, destroy });

    const old1 = registry.getOrCreate("old1", "/tmp/old1", "claude" as AgentId);
    old1.attachViewer(); old1.detachViewer();
    const old2 = registry.getOrCreate("old2", "/tmp/old2", "claude" as AgentId);
    old2.attachViewer(); old2.detachViewer();

    vi.advanceTimersByTime(600_000);

    const fresh = registry.getOrCreate("fresh", "/tmp/fresh", "claude" as AgentId);
    fresh.attachViewer(); fresh.detachViewer();

    createIdleEnforcer({
      containerManager: cm,
      runnerRegistry: registry,
      getMemoryStats: () => overBudgetWith({ old1: { agentBytes: 6 }, old2: { agentBytes: 6 } }),
    })();

    expect(destroy).toHaveBeenCalledWith("old1");
    expect(destroy).toHaveBeenCalledWith("old2");
    expect(destroy).not.toHaveBeenCalledWith("fresh");
    expect(registry.get("fresh")?.disposed).toBe(false);
  });

  it("re-checks runner state at dispose time (TOCTOU defense)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const containers = [{ sessionId: "a" }, { sessionId: "b" }];
    const destroy = vi.fn().mockResolvedValue(undefined);
    const cm = makeContainerManager({ containers, destroy });

    const a = registry.getOrCreate("a", "/tmp/a", "claude" as AgentId);
    a.attachViewer(); a.detachViewer();
    const b = registry.getOrCreate("b", "/tmp/b", "claude" as AgentId);
    b.attachViewer(); b.detachViewer();

    vi.advanceTimersByTime(600_000);

    let flipped = false;
    const origGet = registry.get.bind(registry);
    registry.get = (sid: string) => {
      const r = origGet(sid);
      if (r && sid === "a" && !flipped) {
        flipped = true;
        return r;
      }
      if (r && sid === "a" && flipped) {
        r.attachViewer();
      }
      return r;
    };

    createIdleEnforcer({
      containerManager: cm,
      runnerRegistry: registry,
      getMemoryStats: overBudget,
    })();

    expect(destroy).not.toHaveBeenCalledWith("a");
    expect(destroy).toHaveBeenCalledWith("b");

    a.detachViewer();
  });

  function makeServiceHooks(live: string[]) {
    const set = new Set(live);
    const stop = vi.fn((sid: string) => { set.delete(sid); });
    return {
      hooks: { liveSessions: () => [...set], has: (sid: string) => set.has(sid), stop },
      stop,
      set,
    };
  }

  function idleRunner(sessionId: string) {
    const r = registry.getOrCreate(sessionId, `/tmp/${sessionId}`, "claude" as AgentId);
    r.attachViewer(); r.detachViewer();
    return r;
  }

  describe("docs/284 reclaim ladder", () => {
    it("tier 1 stops the agent container and leaves the preview stack running", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const destroy = vi.fn().mockResolvedValue(undefined);
      const destroyAgentContainer = vi.fn().mockResolvedValue(undefined);
      const cm = makeContainerManager({
        containers: [{ sessionId: "a" }], destroy, destroyAgentContainer,
      });
      const runner = idleRunner("a");
      vi.advanceTimersByTime(600_000);
      const services = makeServiceHooks(["a"]);
      const sseBroadcast = vi.fn();

      createIdleEnforcer({
        containerManager: cm,
        runnerRegistry: registry,
        getMemoryStats: overBudget,
        services: services.hooks,
        sseBroadcast,
      })();

      expect(destroyAgentContainer).toHaveBeenCalledWith("a");
      expect(destroy).not.toHaveBeenCalled();
      expect(services.stop).not.toHaveBeenCalled();
      expect((runner as unknown as { preserveComposeOnDispose: boolean }).preserveComposeOnDispose).toBe(true);
      expect(sseBroadcast).toHaveBeenCalledWith("session_status", expect.objectContaining({
        sessionId: "a",
        reason: "agent-reclaimed",
      }));
    });

    it("does not set the preserve flag for a session with no stack to keep", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const destroy = vi.fn().mockResolvedValue(undefined);
      const cm = makeContainerManager({ containers: [{ sessionId: "a" }], destroy });
      const runner = idleRunner("a");
      vi.advanceTimersByTime(600_000);
      const sseBroadcast = vi.fn();

      createIdleEnforcer({
        containerManager: cm,
        runnerRegistry: registry,
        getMemoryStats: overBudget,
        services: makeServiceHooks([]).hooks,
        sseBroadcast,
      })();

      expect((runner as unknown as { preserveComposeOnDispose?: boolean }).preserveComposeOnDispose).not.toBe(true);
      expect(sseBroadcast).toHaveBeenCalledWith("session_status", expect.objectContaining({
        sessionId: "a",
        reason: "memory-pressure",
      }));
    });

    it("leaves the stack alone when tier 1 alone covered the shortfall", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const destroy = vi.fn().mockResolvedValue(undefined);
      const cm = makeContainerManager({ containers: [{ sessionId: "b" }], destroy });
      idleRunner("b");
      vi.advanceTimersByTime(600_000);
      const services = makeServiceHooks(["b"]);

      createIdleEnforcer({
        containerManager: cm,
        runnerRegistry: registry,
        getMemoryStats: () => overBudgetWith({ b: { agentBytes: 12, serviceBytes: 5 } }),
        services: services.hooks,
      })();

      expect(destroy).toHaveBeenCalledWith("b");
      expect(services.stop).not.toHaveBeenCalled();
    });

    it("tier 2 stops the stack when tier 1 did not free enough", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const destroy = vi.fn().mockResolvedValue(undefined);
      const cm = makeContainerManager({ containers: [{ sessionId: "b" }], destroy });
      idleRunner("b");
      vi.advanceTimersByTime(600_000);
      const services = makeServiceHooks(["b"]);

      createIdleEnforcer({
        containerManager: cm,
        runnerRegistry: registry,
        getMemoryStats: () => overBudgetWith({ b: { agentBytes: 1, serviceBytes: 20 } }),
        services: services.hooks,
      })();

      expect(services.stop).toHaveBeenCalledWith("b");
    });

    it("never stops a stack it did not orphan itself (agent restart in flight)", () => {
      const destroy = vi.fn().mockResolvedValue(undefined);
      const cm = makeContainerManager({ containers: [], destroy });
      const services = makeServiceHooks(["restarting"]);

      createIdleEnforcer({
        containerManager: cm,
        runnerRegistry: registry,
        getMemoryStats: () => overBudgetWith({ restarting: { serviceBytes: 50 } }),
        services: services.hooks,
      })();

      expect(services.stop).not.toHaveBeenCalled();
    });

    it("never stops the stack of a session that still has a viewer", () => {
      const destroy = vi.fn().mockResolvedValue(undefined);
      const cm = makeContainerManager({ containers: [], destroy });
      const busy = registry.getOrCreate("busy", "/tmp/busy", "claude" as AgentId);
      busy.attachViewer();
      const services = makeServiceHooks(["busy"]);

      createIdleEnforcer({
        containerManager: cm,
        runnerRegistry: registry,
        getMemoryStats: overBudget,
        services: services.hooks,
      })();

      expect(services.stop).not.toHaveBeenCalled();
    });

    it("docs/241: a reserved session keeps both its container and its preview", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const destroy = vi.fn().mockResolvedValue(undefined);
      const cm = makeContainerManager({ containers: [{ sessionId: "reserved" }], destroy });
      idleRunner("reserved");
      vi.advanceTimersByTime(600_000);
      const services = makeServiceHooks(["reserved"]);

      createIdleEnforcer({
        containerManager: cm,
        runnerRegistry: registry,
        sessionManager: { get: () => ({ keepPreviewRunning: true }) } as never,
        getMemoryStats: overBudget,
        services: services.hooks,
      })();

      expect(destroy).not.toHaveBeenCalled();
      expect(services.stop).not.toHaveBeenCalled();
    });

    it("reclaims nothing when every session is in use", () => {
      const destroy = vi.fn().mockResolvedValue(undefined);
      const cm = makeContainerManager({ containers: [{ sessionId: "a" }], destroy });
      const r = registry.getOrCreate("a", "/tmp/a", "claude" as AgentId);
      r.attachViewer();
      const services = makeServiceHooks(["a"]);

      createIdleEnforcer({
        containerManager: cm,
        runnerRegistry: registry,
        getMemoryStats: overBudget,
        services: services.hooks,
      })();

      expect(destroy).not.toHaveBeenCalled();
      expect(services.stop).not.toHaveBeenCalled();
    });

    it("gives back speculative standby capacity before touching a session", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const destroy = vi.fn().mockResolvedValue(undefined);
      const destroyAgentContainer = vi.fn().mockResolvedValue(undefined);
      const cm = makeContainerManager({
        containers: [{ sessionId: "warm" }, { sessionId: "mine" }],
        standby: new Set(["warm"]),
        destroy,
        destroyAgentContainer,
      });
      idleRunner("mine");
      vi.advanceTimersByTime(600_000);

      createIdleEnforcer({
        containerManager: cm,
        runnerRegistry: registry,
        getMemoryStats: () => overBudgetWith({ warm: { agentBytes: 20 }, mine: { agentBytes: 20 } }),
      })();

      expect(destroy).toHaveBeenCalledWith("warm");
      expect(destroyAgentContainer).not.toHaveBeenCalled();
      expect(registry.get("mine")?.disposed).toBe(false);
    });

    it("takes the warm preview with the standby, and counts both", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const destroy = vi.fn().mockResolvedValue(undefined);
      const destroyAgentContainer = vi.fn().mockResolvedValue(undefined);
      const cm = makeContainerManager({
        containers: [{ sessionId: "warm" }, { sessionId: "mine" }],
        standby: new Set(["warm"]),
        destroy,
        destroyAgentContainer,
      });
      const services = makeServiceHooks(["warm"]);
      idleRunner("mine");
      vi.advanceTimersByTime(600_000);

      createIdleEnforcer({
        containerManager: cm,
        runnerRegistry: registry,
        getMemoryStats: () => overBudgetWith({
          warm: { agentBytes: 2, serviceBytes: 18 },
          mine: { agentBytes: 20 },
        }),
        services: services.hooks,
      })();

      expect(services.stop).toHaveBeenCalledWith("warm");
      expect(destroy).toHaveBeenCalledWith("warm");
      expect(destroyAgentContainer).not.toHaveBeenCalled();
      expect(services.stop).not.toHaveBeenCalledWith("mine");
      expect(registry.get("mine")?.disposed).toBe(false);
    });

    it("leaves a standby with no pre-started stack exactly as it was", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const destroy = vi.fn().mockResolvedValue(undefined);
      const cm = makeContainerManager({
        containers: [{ sessionId: "warm" }],
        standby: new Set(["warm"]),
        destroy,
      });
      const services = makeServiceHooks([]);

      createIdleEnforcer({
        containerManager: cm,
        runnerRegistry: registry,
        getMemoryStats: () => overBudgetWith({ warm: { agentBytes: 20 } }),
        services: services.hooks,
      })();

      expect(destroy).toHaveBeenCalledWith("warm");
      expect(services.stop).not.toHaveBeenCalled();
    });

    it("does not act twice on the same memory snapshot", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const destroy = vi.fn().mockResolvedValue(undefined);
      const cm = makeContainerManager({
        containers: [{ sessionId: "a" }, { sessionId: "b" }],
        destroy,
      });
      idleRunner("a");
      idleRunner("b");
      vi.advanceTimersByTime(600_000);
      const snapshot = overBudgetWith({ a: { agentBytes: 1 }, b: { agentBytes: 1 } });

      const enforce = createIdleEnforcer({
        containerManager: cm,
        runnerRegistry: registry,
        getMemoryStats: () => snapshot,
      });
      enforce();
      const afterFirst = destroy.mock.calls.length;
      enforce();

      expect(destroy.mock.calls.length).toBe(afterFirst);
    });
  });

  it("under eviction pressure: bypasses grace period and disposes idle runners with no viewer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const containers = [{ sessionId: "a" }];
    const destroy = vi.fn().mockResolvedValue(undefined);
    const cm = makeContainerManager({ containers, destroy });

    const r = registry.getOrCreate("a", "/tmp/a", "claude" as AgentId);
    r.attachViewer();
    r.detachViewer();

    createIdleEnforcer({
      containerManager: cm,
      runnerRegistry: registry,
      getMemoryStats: () => ({ usedBytes: 0.95 * 16 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 }),
    })();

    expect(destroy).toHaveBeenCalledWith("a");
  });

  it("keeps reclaiming until usage is back under the budget", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const containers = [{ sessionId: "a" }, { sessionId: "b" }, { sessionId: "c" }];
    const destroy = vi.fn().mockResolvedValue(undefined);
    const cm = makeContainerManager({ containers, destroy });

    for (const c of containers) {
      const r = registry.getOrCreate(c.sessionId, `/tmp/${c.sessionId}`, "claude" as AgentId);
      r.attachViewer(); r.detachViewer();
    }
    vi.advanceTimersByTime(600_000);

    createIdleEnforcer({
      containerManager: cm,
      runnerRegistry: registry,
      getMemoryStats: () => overBudgetWith({
        a: { agentBytes: 4 }, b: { agentBytes: 4 }, c: { agentBytes: 4 },
      }),
    })();

    expect(destroy).toHaveBeenCalledWith("a");
    expect(destroy).toHaveBeenCalledWith("b");
    expect(destroy).toHaveBeenCalledWith("c");
  });

  it("under eviction pressure: still refuses to dispose runners whose agent is running", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const containers = [{ sessionId: "a" }];
    const destroy = vi.fn().mockResolvedValue(undefined);
    const cm = makeContainerManager({ containers, destroy });

    const r = registry.getOrCreate("a", "/tmp/a", "claude" as AgentId);
    r.running = true;

    createIdleEnforcer({
      containerManager: cm,
      runnerRegistry: registry,
      getMemoryStats: () => ({ usedBytes: 0.99 * 16 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 }),
    })();

    expect(destroy).not.toHaveBeenCalled();
    expect(registry.get("a")?.disposed).toBe(false);

    registry.dispose("a", { force: true });
  });

  it("under eviction pressure: still refuses to dispose runners with attached viewers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const containers = [{ sessionId: "a" }];
    const destroy = vi.fn().mockResolvedValue(undefined);
    const cm = makeContainerManager({ containers, destroy });

    const r = registry.getOrCreate("a", "/tmp/a", "claude" as AgentId);
    r.attachViewer();

    createIdleEnforcer({
      containerManager: cm,
      runnerRegistry: registry,
      getMemoryStats: () => ({ usedBytes: 0.95 * 16 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 }),
    })();

    expect(destroy).not.toHaveBeenCalled();
  });

  it("below the eviction threshold: behaves like the legacy enforcer (grace period honored)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const containers = [{ sessionId: "a" }];
    const destroy = vi.fn().mockResolvedValue(undefined);
    const cm = makeContainerManager({ containers, destroy });

    const r = registry.getOrCreate("a", "/tmp/a", "claude" as AgentId);
    r.attachViewer(); r.detachViewer();

    createIdleEnforcer({
      containerManager: cm,
      runnerRegistry: registry,
      getMemoryStats: () => ({ usedBytes: 0.50 * 16 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 }),
    })();

    expect(destroy).not.toHaveBeenCalled();
    expect(registry.get("a")?.disposed).toBe(false);
  });
});

describe("Runner dispose protection", () => {
  it("registry.dispose() respects the running guard", () => {
    const registry = new SessionRunnerRegistry();
    const r = registry.getOrCreate("s1", "/tmp/s1", "claude" as AgentId);
    r.running = true;

    registry.dispose("s1");
    expect(r.disposed).toBe(false);
    expect(registry.get("s1")).toBe(r);

    registry.dispose("s1", { force: true });
    expect(r.disposed).toBe(true);
  });

  it("disposeAll() forces disposal even when agents are running", () => {
    const registry = new SessionRunnerRegistry();
    const r1 = registry.getOrCreate("s1", "/tmp/s1", "claude" as AgentId);
    const r2 = registry.getOrCreate("s2", "/tmp/s2", "claude" as AgentId);
    r1.running = true;
    r2.running = true;

    registry.disposeAll();
    expect(r1.disposed).toBe(true);
    expect(r2.disposed).toBe(true);
  });
});

describe("buildRunnerFactory — runtimeMode dispatch (feature 118)", () => {
  it("local mode returns a factory that produces in-process SessionRunner", () => {
    const factory = buildRunnerFactory({
      deps: {},
      containerManager: null,
      credentialsDir: TEST_CREDENTIALS_DIR,
      runtimeMode: "local",
    });

    expect(factory).toBeDefined();
    const runner = factory!({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    expect(runner).toBeInstanceOf(SessionRunner);
    expect(runner).not.toBeInstanceOf(ContainerSessionRunner);
    expect(runner.createAgent).toBeUndefined();
    runner.dispose({ force: true });
  });

  it("local mode closes the session's /agent-ops host when the runner is disposed", async () => {
    const factory = buildRunnerFactory({
      deps: {},
      containerManager: null,
      credentialsDir: TEST_CREDENTIALS_DIR,
      runtimeMode: "local",
    });
    const runner = factory!({
      sessionId: "ops-teardown",
      sessionDir: "/tmp/ops-teardown",
      defaultAgentId: "claude" as AgentId,
    });

    const url = await ensureLocalAgentOpsHost({ sessionId: "ops-teardown" });
    expect(localAgentOpsSpawnEnv("ops-teardown")).toEqual({ SHIPIT_AGENT_OPS_URL: url });

    runner.dispose({ force: true });
    await vi.waitFor(() => {
      expect(localAgentOpsSpawnEnv("ops-teardown")).toEqual({});
    });

    await resetLocalAgentOpsForTests();
  });

  describe("account-scoped local spawns (docs/260)", () => {
    const claudeSession = (sessionId: string): SessionInfo => ({
      id: sessionId,
      agentId: "claude" as AgentId,
    } as SessionInfo);

    function localFactoryWith(sessions: Record<string, SessionInfo>) {
      const calls: { agentId: AgentId; home: string | undefined }[] = [];
      const localAgentFactory = vi.fn((agentId: AgentId, resolveHome?: () => string | undefined) => {
        calls.push({ agentId, home: resolveHome?.() });
        return { agentId } as unknown as AgentProcess;
      });
      const factory = buildRunnerFactory({
        deps: {},
        containerManager: null,
        credentialsDir: TEST_CREDENTIALS_DIR,
        sessionManager: { get: (id: string) => sessions[id] } as unknown as SessionManager,
        runtimeMode: "local",
        localAgentFactory,
      });
      return { factory: factory!, calls };
    }

    it("resolves each runner's own stamped account root", () => {
      const { factory, calls } = localFactoryWith({
        s1: claudeSession("s1"),
        s2: claudeSession("s2"),
      });

      const r1 = factory({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
      const r2 = factory({ sessionId: "s2", sessionDir: "/tmp/s2", defaultAgentId: "claude" as AgentId });
      r1.residentRoute = { kind: "account", id: "acct-a" };
      r2.residentRoute = { kind: "account", id: "acct-b" };
      r1.createAgent!("claude");
      r2.createAgent!("claude");

      expect(calls[0].home).toBe(`${TEST_CREDENTIALS_DIR}/provider-accounts/claude/acct-a`);
      expect(calls[1].home).toBe(`${TEST_CREDENTIALS_DIR}/provider-accounts/claude/acct-b`);
      r1.dispose({ force: true });
      r2.dispose({ force: true });
    });

    it("re-reads the stamp on each spawn so a per-turn move is picked up", () => {
      const { factory, calls } = localFactoryWith({ s1: claudeSession("s1") });
      const runner = factory({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });

      runner.residentRoute = { kind: "account", id: "acct-a" };
      runner.createAgent!("claude");
      runner.residentRoute = { kind: "account", id: "acct-b" };
      runner.createAgent!("claude");

      expect(calls.map((c) => c.home)).toEqual([
        `${TEST_CREDENTIALS_DIR}/provider-accounts/claude/acct-a`,
        `${TEST_CREDENTIALS_DIR}/provider-accounts/claude/acct-b`,
      ]);
      runner.dispose({ force: true });
    });
  });

  describe("MCP on a local spawn (planning#300)", () => {
    function localFactoryWithMcp(opts: { credentialStore?: CredentialStore } = {}) {
      const written: (AgentMcpWriteContext | null)[] = [];
      const localAgentFactory = vi.fn((): AgentProcess => {
        const agent = new EventEmitter() as unknown as AgentProcess;
        agent.writeMcpConfig = (ctx: AgentMcpWriteContext) => {
          written.push(ctx);
          return {};
        };
        agent.run = () => { /* no spawn in this test */ };
        return agent;
      });
      const factory = buildRunnerFactory({
        deps: {},
        containerManager: null,
        credentialsDir: TEST_CREDENTIALS_DIR,
        sessionManager: { get: () => undefined } as unknown as SessionManager,
        runtimeMode: "local",
        localAgentFactory,
        ...(opts.credentialStore ? { credentialStore: opts.credentialStore } : {}),
      });
      return { factory: factory!, written };
    }

    it("wraps the spawn so the adapter's MCP config is written", () => {
      const store = new CredentialStore(
        fs.mkdtempSync(path.join(os.tmpdir(), "shipit-mcp-")),
      );
      store.setAgentEnv("mcp__linear__TOKEN", "sk-1");
      const { factory, written } = localFactoryWithMcp({ credentialStore: store });

      const runner = factory({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
      const agent = runner.createAgent!("claude");
      agent.run({ prompt: "hi", cwd: "/tmp/s1" });

      expect(written).toHaveLength(1);
      expect(written[0]?.shipitBridge).toBeNull();
      runner.dispose({ force: true });
    });

    it("without a credential store the spawn is unwrapped (pre-planning#300 behavior)", () => {
      const { factory, written } = localFactoryWithMcp();
      const runner = factory({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
      runner.createAgent!("claude").run({ prompt: "hi", cwd: "/tmp/s1" });
      expect(written).toHaveLength(0);
      runner.dispose({ force: true });
    });
  });

  it("local mode wins over a non-null containerManager", () => {
    const fakeContainerManager = {
      get: () => undefined,
    } as unknown as SessionContainerManager;

    const factory = buildRunnerFactory({
      deps: {},
      containerManager: fakeContainerManager,
      credentialsDir: TEST_CREDENTIALS_DIR,
      runtimeMode: "local",
    });

    const runner = factory!({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    expect(runner).toBeInstanceOf(SessionRunner);
    expect(runner).not.toBeInstanceOf(ContainerSessionRunner);
    runner.dispose({ force: true });
  });

  it("containerized mode without containerManager returns undefined (test-mode default)", () => {
    const factory = buildRunnerFactory({
      deps: {},
      containerManager: null,
      credentialsDir: TEST_CREDENTIALS_DIR,
      runtimeMode: "containerized",
    });
    expect(factory).toBeUndefined();
  });

  it("explicit deps.runnerFactory wins over runtimeMode", () => {
    const customRunner = new SessionRunner({
      sessionId: "x", sessionDir: "/tmp/x", defaultAgentId: "claude" as AgentId,
    });
    const customFactory = vi.fn().mockReturnValue(customRunner);

    const factory = buildRunnerFactory({
      deps: { runnerFactory: customFactory },
      containerManager: null,
      credentialsDir: TEST_CREDENTIALS_DIR,
      runtimeMode: "local",
    });

    const runner = factory!({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    expect(customFactory).toHaveBeenCalledOnce();
    expect(runner).toBe(customRunner);
    customRunner.dispose({ force: true });
  });
});

describe("SessionRunner forced dispose with running agent", () => {
  it("force kills the agent and emits disposed", () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    const fakeAgent = { kill: vi.fn() } as unknown as { kill: ReturnType<typeof vi.fn> };
    runner.setAgent(fakeAgent as never);
    runner.running = true;

    const disposedSpy = vi.fn();
    runner.on("disposed", disposedSpy);

    runner.dispose();
    expect(disposedSpy).not.toHaveBeenCalled();
    expect(fakeAgent.kill).not.toHaveBeenCalled();

    runner.dispose({ force: true });
    expect(disposedSpy).toHaveBeenCalled();
    expect(fakeAgent.kill).toHaveBeenCalled();
  });
});

describe("runMcpOAuthStartupRefresh (docs/088 Phase 2)", () => {
  let tmpDir: string;
  let store: CredentialStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-startup-refresh-"));
    store = new CredentialStore(tmpDir);
  });

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rotates a token within the safety margin via the injected fetch", async () => {
    store.setMcpOAuthTokens("notion_oauth", {
      accessToken: "stale",
      refreshToken: "rt-1",
      clientId: "cid",
      expiresAt: Date.now() + 60 * 1000,
    });

    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls++;
      return new Response(
        JSON.stringify({ access_token: "fresh", expires_in: 3600 }),
        { status: 200 },
      );
    };

    await runMcpOAuthStartupRefresh({ credentialStore: store, fetchImpl: fakeFetch });

    expect(calls).toBe(1);
    expect(store.getMcpOAuthTokens("notion_oauth")?.accessToken).toBe("fresh");
  });

  it("leaves a fresh token untouched", async () => {
    store.setMcpOAuthTokens("notion_oauth", {
      accessToken: "fresh",
      refreshToken: "rt-1",
      clientId: "cid",
      expiresAt: Date.now() + 60 * 60 * 1000,
    });

    const fakeFetch: typeof fetch = async () => {
      throw new Error("should not be called for a fresh token");
    };

    await runMcpOAuthStartupRefresh({ credentialStore: store, fetchImpl: fakeFetch });

    expect(store.getMcpOAuthTokens("notion_oauth")?.accessToken).toBe("fresh");
  });

  it("swallows refresh failures so startup is never blocked", async () => {
    store.setMcpOAuthTokens("notion_oauth", {
      accessToken: "stale",
      refreshToken: "rt-1",
      clientId: "cid",
      expiresAt: Date.now() - 1000,
    });

    const fakeFetch: typeof fetch = async () =>
      new Response("upstream blew up", { status: 500 });

    await expect(
      runMcpOAuthStartupRefresh({ credentialStore: store, fetchImpl: fakeFetch }),
    ).resolves.toBeUndefined();

    expect(store.getMcpOAuthTokens("notion_oauth")?.accessToken).toBe("stale");
  });

  it("is a no-op when no OAuth tokens are persisted", async () => {
    const fakeFetch: typeof fetch = async () => {
      throw new Error("should not be called when there are no tokens");
    };
    await expect(
      runMcpOAuthStartupRefresh({ credentialStore: store, fetchImpl: fakeFetch }),
    ).resolves.toBeUndefined();
  });
});

describe("scheduleStartupTasks — warms every ready repo at boot (docs/148)", () => {
  it("calls warmSessionForRepo for stale, migrated, and fresh repos", async () => {
    const calls: string[] = [];
    const warmSessionForRepo = async (url: string): Promise<void> => {
      calls.push(url);
    };

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-startup-warm-"));
    const staleClonePath = path.join(tmpDir, "missing");

    const repos = [
      { url: "stale", status: "ready" as const, warmSessionId: "warm-stale" },
      { url: "migrated", status: "ready" as const },
      { url: "fresh", status: "ready" as const },
    ];
    const repoStore = {
      list: () => repos,
      setWarmSessionId: () => {},
    } as unknown as Parameters<typeof scheduleStartupTasks>[0]["repoStore"];

    const sessionManager = {
      get: (id: string) => id === "warm-stale" ? { workspaceDir: staleClonePath } : undefined,
      allIds: () => [],
      delete: () => true,
    } as unknown as Parameters<typeof scheduleStartupTasks>[0]["sessionManager"];

    const noop = () => {};
    const noopMgr = (): { delete?: (id: string) => void } => ({ delete: noop });

    const timer = scheduleStartupTasks(
      {
        repoStore,
        sessionManager,
        chatHistoryManager: { delete: noop } as unknown as Parameters<typeof scheduleStartupTasks>[0]["chatHistoryManager"],
        usageManager: noopMgr() as Parameters<typeof scheduleStartupTasks>[0]["usageManager"],
        containerManager: null,
        getBareCacheDir: (u: string) => path.join(tmpDir, "cache", u),
        warmSessionForRepo,
      },
      ["migrated"],
    );

    await new Promise((r) => setTimeout(r, 0));
    clearTimeout(timer);

    expect(calls.length).toBe(3);
    expect([...calls].sort()).toEqual(["fresh", "migrated", "stale"]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("wireEventHandlers — account-scoped auth SSE (docs/150)", () => {
  let tmp: string;

  class FakeAuthManager extends EventEmitter {
    activeAccountId: string | null = null;
    readonly loginId: LoginIntegrationId = "anthropic-oauth";
    getActiveAccountId(): string | null { return this.activeAccountId; }
    start() {}
    cancel() {}
    signOut() {}
    isConfigured() { return true; }
    kill() {}
    getPendingPayload() { return null; }
  }

  function setup(onCredentialReplaced?: (agentId: AgentId, accountId: string) => void) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-wire-auth-"));
    const credentialStore = new CredentialStore(tmp);
    const providerAccountManager = new ProviderAccountManager({ credentialsDir: tmp, credentialStore });
    const account = providerAccountManager.create("anthropic", "Work");
    const sessionManager = new SessionManager(createTestDatabaseManager());
    const mgr = new FakeAuthManager();
    const events: { event: string; data: Record<string, unknown> }[] = [];
    wireEventHandlers({
      authManagers: new Map<LoginIntegrationId, AgentAuthManager>([["anthropic-oauth", mgr as unknown as AgentAuthManager]]),
      githubAuthManager: new EventEmitter() as unknown as GitHubAuthManager,
      agentRegistry: { refreshAuth: () => {}, refreshAuthForLogin: () => {}, list: () => [] } as unknown as AgentRegistry,
      providerAccountManager,
      sseBroadcast: (event, data) => events.push({ event, data: data as Record<string, unknown> }),
      credentialsDir: tmp,
      sessionManager,
      credentialStore,
      onCredentialReplaced,
    });
    return { providerAccountManager, mgr, events, account };
  }

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("scoped complete flips the row to ready and qualifies the SSE with accountId", () => {
    const { providerAccountManager, mgr, events, account } = setup();
    mgr.activeAccountId = account.id;
    mgr.emit("complete");

    expect(providerAccountManager.get("anthropic", account.id)?.status).toBe("ready");
    const complete = events.find((e) => e.event === "agent_auth_complete");
    expect(complete?.data).toMatchObject({ loginId: "anthropic-oauth", accountId: account.id });
  });

  it("clears the replaced credential's exhaustion before making the row selectable", () => {
    let statusDuringInvalidation: string | undefined;
    const managerRef: { current?: ProviderAccountManager } = {};
    const rig = setup((_agentId, accountId) => {
      statusDuringInvalidation = managerRef.current?.get("anthropic", accountId)?.status;
    });
    managerRef.current = rig.providerAccountManager;
    const until = Date.now() + 3_600_000;
    rig.providerAccountManager.markAccountExhausted("anthropic", rig.account.id, until);
    rig.mgr.activeAccountId = rig.account.id;

    rig.mgr.emit("complete");

    expect(statusDuringInvalidation).not.toBe("ready");
    expect(rig.providerAccountManager.get("anthropic", rig.account.id)).toMatchObject({
      status: "ready",
      exhaustedUntil: null,
    });
    expect(rig.providerAccountManager.selectRouteForTurn("anthropic")?.id).toBe(rig.account.id);
  });

  function writeClaudeSignIn(
    providerAccountManager: ProviderAccountManager,
    accountId: string,
    uuid: string,
    email: string,
  ): void {
    const dir = providerAccountManager.resolveCredentialRoot("claude", accountId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: uuid, emailAddress: email } }),
    );
  }

  it("refuses a completion that resolves to an already-connected account", () => {
    const { providerAccountManager, mgr, events, account } = setup();
    writeClaudeSignIn(providerAccountManager, account.id, "uuid-1", "dev@example.com");
    mgr.activeAccountId = account.id;
    mgr.emit("complete");

    const second = providerAccountManager.create("anthropic");
    writeClaudeSignIn(providerAccountManager, second.id, "uuid-1", "dev@example.com");
    mgr.activeAccountId = second.id;
    mgr.emit("complete");

    expect(events.filter((e) => e.event === "agent_auth_complete")).toHaveLength(1);
    expect(providerAccountManager.list("anthropic").map((a) => a.id)).toEqual([account.id]);
    const failed = events.filter((e) => e.event === "agent_auth_failed").at(-1);
    expect(failed?.data).toMatchObject({ loginId: "anthropic-oauth", accountId: second.id, reason: "duplicate" });
    expect(String(failed?.data.message)).toContain("already connected");
  });

  it("scoped failure marks the row auth_failed and qualifies the SSE", () => {
    const { providerAccountManager, mgr, events, account } = setup();
    mgr.activeAccountId = account.id;
    mgr.emit("failed", { reason: "error" });

    expect(providerAccountManager.get("anthropic", account.id)?.status).toBe("auth_failed");
    const failed = events.find((e) => e.event === "agent_auth_failed");
    expect(failed?.data).toMatchObject({ loginId: "anthropic-oauth", accountId: account.id, reason: "error" });
  });

  it("scoped pending qualifies the SSE with accountId", () => {
    const { mgr, events, account } = setup();
    mgr.activeAccountId = account.id;
    mgr.emit("pending", { kind: "code-paste-url", verificationUri: "https://example.com" });

    const pending = events.find((e) => e.event === "agent_auth_pending");
    expect(pending?.data).toMatchObject({ loginId: "anthropic-oauth", accountId: account.id });
  });

  it("rebroadcasts auth progress and log diagnostics", () => {
    const { mgr, events, account } = setup();
    mgr.activeAccountId = account.id;
    mgr.emit("progress", {
      loginId: "anthropic-oauth",
      accountId: account.id,
      attemptId: "attempt-1",
      phase: "waiting_for_url",
      message: "Waiting for Claude CLI.",
    });
    mgr.emit("log", {
      loginId: "anthropic-oauth",
      accountId: account.id,
      attemptId: "attempt-1",
      timestamp: "2026-07-11T00:00:00.000Z",
      level: "info",
      source: "shipit",
      message: "Spawned claude /login.",
    });

    expect(events.find((e) => e.event === "agent_auth_progress")?.data).toMatchObject({
      loginId: "anthropic-oauth",
      accountId: account.id,
      attemptId: "attempt-1",
      phase: "waiting_for_url",
    });
    expect(events.find((e) => e.event === "agent_auth_log")?.data).toMatchObject({
      loginId: "anthropic-oauth",
      accountId: account.id,
      attemptId: "attempt-1",
      source: "shipit",
    });
  });

  it("a completion with no account scope marks nothing and invents no accountId", () => {
    const { mgr, events, providerAccountManager } = setup();
    const before = providerAccountManager.list("anthropic").map((a) => a.id);
    mgr.activeAccountId = null;

    mgr.emit("complete");

    const complete = events.find((e) => e.event === "agent_auth_complete");
    expect(complete?.data).toMatchObject({ loginId: "anthropic-oauth" });
    expect(complete?.data.accountId).toBeUndefined();
    expect(providerAccountManager.list("anthropic").map((a) => a.id)).toEqual(before);
    expect(providerAccountManager.list("anthropic").every((a) => a.status !== "ready")).toBe(true);
  });
});

describe("markProviderAccountUnauthenticated", () => {
  it("marks the account auth_failed, refreshes registry auth, and broadcasts agent list", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-provider-unauth-"));
    try {
      const credentialStore = new CredentialStore(tmp);
      const providerAccountManager = new ProviderAccountManager({ credentialsDir: tmp, credentialStore });
      const account = providerAccountManager.create("anthropic", "Work");
      providerAccountManager.setAccountStatus("anthropic", account.id, "ready");
      let hasRunnableModels = true;
      const refreshAuth = vi.fn((_harnessId?: AgentId) => { hasRunnableModels = false; });
      const refreshAuthForLogin = vi.fn((loginId: LoginIntegrationId) => {
        for (const harnessId of harnessesForLoginIntegration(loginId)) refreshAuth(harnessId);
      });
      const agentRegistry = {
        refreshAuth,
        refreshAuthForLogin,
        list: () => [{
          id: "claude",
          name: "Claude Code",
          installed: true,
          hasRunnableModels,
          capabilities: {
            models: ["sonnet"],
            supportsReview: true,
            supportsSteering: true,
            supportsCompaction: true,
            supportedPermissionModes: ["auto"],
            skillInvocationPrefix: "/",
          },
        }],
      } as unknown as AgentRegistry;
      const events: { event: string; data: Record<string, unknown> }[] = [];

      markProviderAccountUnauthenticated({
        agentId: "claude",
        accountId: account.id,
        providerAccountManager,
        agentRegistry,
        sseBroadcast: (event, data) => events.push({ event, data: data as Record<string, unknown> }),
        credentialStore,
      });

      expect(providerAccountManager.get("anthropic", account.id)?.status).toBe("auth_failed");
      expect(refreshAuthForLogin).toHaveBeenCalledWith("anthropic-oauth");
      expect(refreshAuth).toHaveBeenCalledWith("claude");
      expect(events.find((e) => e.event === "provider_accounts")?.data.accounts)
        .toEqual(expect.arrayContaining([expect.objectContaining({ id: account.id, status: "auth_failed" })]));
      expect(events.find((e) => e.event === "agent_list")?.data.agents)
        .toEqual(expect.arrayContaining([expect.objectContaining({ id: "claude", hasRunnableModels: false })]));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("markProviderAccountReauthenticated", () => {
  function buildRegistry(initialAuth: boolean): { agentRegistry: AgentRegistry; refreshAuth: ReturnType<typeof vi.fn>; refreshAuthForLogin: ReturnType<typeof vi.fn>; getAuth: () => boolean } {
    let hasRunnableModels = initialAuth;
    const refreshAuth = vi.fn((_harnessId?: AgentId) => { hasRunnableModels = true; });
    const refreshAuthForLogin = vi.fn((loginId: LoginIntegrationId) => {
      for (const harnessId of harnessesForLoginIntegration(loginId)) refreshAuth(harnessId);
    });
    const agentRegistry = {
      refreshAuth,
      refreshAuthForLogin,
      list: () => [{
        id: "claude",
        name: "Claude Code",
        installed: true,
        hasRunnableModels,
        capabilities: {
          models: ["sonnet"],
          supportsReview: true,
          supportsSteering: true,
          supportsCompaction: true,
          supportedPermissionModes: ["auto"],
          skillInvocationPrefix: "/",
        },
      }],
    } as unknown as AgentRegistry;
    return { agentRegistry, refreshAuth, refreshAuthForLogin, getAuth: () => hasRunnableModels };
  }

  it("flips a auth_failed account back to ready, refreshes registry auth, and broadcasts the agent list", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-provider-reauth-"));
    try {
      const credentialStore = new CredentialStore(tmp);
      const providerAccountManager = new ProviderAccountManager({ credentialsDir: tmp, credentialStore });
      const account = providerAccountManager.create("anthropic", "Work");
      providerAccountManager.setAccountStatus("anthropic", account.id, "auth_failed");
      const { agentRegistry, refreshAuth, refreshAuthForLogin } = buildRegistry(false);
      const events: { event: string; data: Record<string, unknown> }[] = [];

      markProviderAccountReauthenticated({
        agentId: "claude",
        accountId: account.id,
        providerAccountManager,
        agentRegistry,
        sseBroadcast: (event, data) => events.push({ event, data: data as Record<string, unknown> }),
        credentialStore,
      });

      expect(providerAccountManager.get("anthropic", account.id)?.status).toBe("ready");
      expect(refreshAuthForLogin).toHaveBeenCalledWith("anthropic-oauth");
      expect(refreshAuth).toHaveBeenCalledWith("claude");
      expect(events.find((e) => e.event === "provider_accounts")?.data.accounts)
        .toEqual(expect.arrayContaining([expect.objectContaining({ id: account.id, status: "ready" })]));
      expect(events.find((e) => e.event === "agent_list")?.data.agents)
        .toEqual(expect.arrayContaining([expect.objectContaining({ id: "claude", hasRunnableModels: true })]));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("is a no-op when the account is already ready (no redundant refresh or broadcast)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-provider-reauth-noop-"));
    try {
      const credentialStore = new CredentialStore(tmp);
      const providerAccountManager = new ProviderAccountManager({ credentialsDir: tmp, credentialStore });
      const account = providerAccountManager.create("anthropic", "Work");
      providerAccountManager.setAccountStatus("anthropic", account.id, "ready");
      const { agentRegistry, refreshAuth, refreshAuthForLogin } = buildRegistry(true);
      const events: { event: string; data: Record<string, unknown> }[] = [];

      markProviderAccountReauthenticated({
        agentId: "claude",
        accountId: account.id,
        providerAccountManager,
        agentRegistry,
        sseBroadcast: (event, data) => events.push({ event, data: data as Record<string, unknown> }),
        credentialStore,
      });

      expect(refreshAuth).not.toHaveBeenCalled();
      expect(refreshAuthForLogin).not.toHaveBeenCalled();
      expect(events).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("buildRunnerFactory — container ready after the runner was disposed", () => {
  const SESSION = "disposed-mid-create";

  async function containerReadyAfterDispose(opts: { disposeBeforeRelease: boolean }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-dispose-race-"));
    fs.mkdirSync(path.join(dir, "workspace"), { recursive: true });

    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    let reachedCreate!: () => void;
    const atCreate = new Promise<void>((resolve) => { reachedCreate = resolve; });

    let markSettled!: () => void;
    const createSettled = new Promise<void>((resolve) => { markSettled = resolve; });

    const containerManager = {
      get: () => undefined,
      teardownEpoch: () => 0,
      preparePnpmStore: () => undefined,
      prepareOverlaySpecs: async () => [],
      buildConfigForWorkspace: (c: unknown) => c,
      recordCreateError: () => {},
      clearCreateError: () => { markSettled(); },
      destroy: async () => {},
      create: async () => {
        reachedCreate();
        await paused;
        return { id: "cid-1", workerUrl: "http://172.20.0.9:9100", containerIp: "172.20.0.9", status: "running" };
      },
    } as unknown as SessionContainerManager;

    const setWorkerUrl = vi.spyOn(ContainerSessionRunner.prototype, "setWorkerUrl")
      .mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const factory = buildRunnerFactory({
      deps: {},
      containerManager,
      credentialsDir: TEST_CREDENTIALS_DIR,
      runtimeMode: "containerized",
    });
    const runner = factory!({
      sessionId: SESSION,
      sessionDir: path.join(dir, "workspace"),
      defaultAgentId: "claude" as AgentId,
    });

    await atCreate;
    if (opts.disposeBeforeRelease) runner.dispose({ force: true });
    release();
    // Wait for the create continuation, not disposal, before checking the spy.
    await createSettled;

    const calls = setWorkerUrl.mock.calls.length;
    setWorkerUrl.mockRestore();
    warn.mockRestore();
    log.mockRestore();
    runner.dispose({ force: true });
    fs.rmSync(dir, { recursive: true, force: true });
    return calls;
  }

  it("does not wire the worker URL into a runner that was disposed mid-create", async () => {
    expect(await containerReadyAfterDispose({ disposeBeforeRelease: true })).toBe(0);
  });

  it("still wires it when the runner is alive", async () => {
    expect(await containerReadyAfterDispose({ disposeBeforeRelease: false })).toBe(1);
  });
});

describe("buildRunnerFactory — teardown during the create preflight", () => {
  const SESSION = "archived-during-preflight";

  it("hands create the epoch from before the preflight, not after it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-preflight-race-"));
    fs.mkdirSync(path.join(dir, "workspace"), { recursive: true });

    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    let reachedPreflight!: () => void;
    const atPreflight = new Promise<void>((resolve) => { reachedPreflight = resolve; });

    let epoch = 0;
    let seenIntentEpoch: number | undefined;

    const containerManager = {
      get: () => undefined,
      teardownEpoch: () => epoch,
      destroy: async () => { epoch += 1; },
      preparePnpmStore: () => undefined,
      prepareOverlaySpecs: async () => { reachedPreflight(); await paused; return []; },
      buildConfigForWorkspace: (c: unknown) => c,
      recordCreateError: () => {},
      clearCreateError: () => {},
      create: async (_config: unknown, opts?: { intentEpoch?: number }) => {
        seenIntentEpoch = opts?.intentEpoch;
        return { id: "cid-1", workerUrl: "http://172.20.0.9:9100", containerIp: "172.20.0.9", status: "running" };
      },
    } as unknown as SessionContainerManager;

    const setWorkerUrl = vi.spyOn(ContainerSessionRunner.prototype, "setWorkerUrl").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const factory = buildRunnerFactory({
        deps: {},
        containerManager,
        credentialsDir: TEST_CREDENTIALS_DIR,
        // Overlay preflight requires a known session.
        sessionManager: { get: () => ({ id: SESSION }) } as unknown as SessionManager,
        runtimeMode: "containerized",
      });
      const runner = factory!({
        sessionId: SESSION,
        sessionDir: path.join(dir, "workspace"),
        defaultAgentId: "claude" as AgentId,
      });

      await atPreflight;
      await containerManager.destroy(SESSION);
      release();
      await vi.waitFor(() => { expect(seenIntentEpoch).toBeDefined(); });

      expect(seenIntentEpoch).toBe(0);
      expect(epoch).toBe(1);

      runner.dispose({ force: true });
    } finally {
      setWorkerUrl.mockRestore();
      warn.mockRestore();
      log.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
