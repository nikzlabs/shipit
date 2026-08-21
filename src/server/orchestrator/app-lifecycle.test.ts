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
  IDLE_GRACE_PERIOD_MS,
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
import type { AgentId, AgentProcess, SessionInfo } from "../shared/types.js";
import type { AgentMcpWriteContext } from "../shared/types/agent-types.js";
import type { AgentAuthManager } from "./agent-auth-manager.js";
import type { GitHubAuthManager } from "./github-auth.js";
import type { AgentRegistry } from "../shared/agent-registry.js";
import type { SessionContainerManager } from "./session-container.js";
import { TEST_CREDENTIALS_DIR } from "./credentials-test-helpers.js";

/**
 * These tests pin down the contract that protects running agents from being
 * killed by lifecycle events (idle cleanup, transient WebSocket disconnects).
 * The user's complaint was: "websocket should never affect how the server is
 * behaving" — the idle enforcer is the central enforcement point.
 */

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
}): SessionContainerManager {
  const standby = opts.standby ?? new Set<string>();
  return {
    getAll: () => opts.containers,
    isStandby: (sid: string) => standby.has(sid),
    destroy: opts.destroy ?? (async () => {}),
  } as unknown as SessionContainerManager;
}

function makeCredentialStore(maxIdle: number): CredentialStore {
  return { getMaxIdleContainers: () => maxIdle } as unknown as CredentialStore;
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
      credentialStore: makeCredentialStore(0),
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
    // Admission stopped counting archived rows, so protecting a surviving
    // container here would hold the RAM for a slot the books already handed to
    // someone else — two reservations' worth of host, one on the books.
    const containers = [{ sessionId: "stale" }];
    const destroy = vi.fn().mockResolvedValue(undefined);
    const cm = makeContainerManager({ containers, destroy });
    registry.getOrCreate("stale", "/tmp/stale", "claude" as AgentId);

    createIdleEnforcer({
      containerManager: cm,
      credentialStore: makeCredentialStore(0),
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

    // Create three runners, all with agents running. They should all be safe
    // even though we pretend the limit is 1.
    for (const c of containers) {
      const r = registry.getOrCreate(c.sessionId, `/tmp/${c.sessionId}`, "claude" as AgentId);
      r.running = true;
    }

    const enforce = createIdleEnforcer({
      containerManager: cm,
      credentialStore: makeCredentialStore(1),
      runnerRegistry: registry,
    });
    enforce();

    expect(destroy).not.toHaveBeenCalled();
    for (const c of containers) {
      expect(registry.get(c.sessionId)?.disposed).toBe(false);
    }

    // Cleanup
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
      credentialStore: makeCredentialStore(1),
      runnerRegistry: registry,
    })();

    expect(destroy).not.toHaveBeenCalled();
    for (const c of containers) {
      expect(registry.get(c.sessionId)?.disposed).toBe(false);
    }
  });

  // docs/235 — the reclaim guard reads `agentBusy`, not `running`. A session
  // whose agent woke ITSELF (a background task finished and the CLI started a
  // fresh turn), or that is merely holding pending background work between
  // turns, has `running === false` and would otherwise be reaped mid-work.
  it("never disposes a runner holding outstanding background tasks", () => {
    const containers = [
      { sessionId: "a" }, { sessionId: "b" }, { sessionId: "c" },
    ];
    const destroy = vi.fn().mockResolvedValue(undefined);
    const cm = makeContainerManager({ containers, destroy });

    for (const c of containers) {
      const r = registry.getOrCreate(c.sessionId, `/tmp/${c.sessionId}`, "claude" as AgentId);
      // No viewer, no running turn — idle by the old definition.
      r.isStreamingActive = true;
      r.setBackgroundTasks([{ id: `task-${c.sessionId}`, description: "npm test" }]);
      expect(r.running).toBe(false);
      expect(r.agentBusy).toBe(true);
    }

    createIdleEnforcer({
      containerManager: cm,
      credentialStore: makeCredentialStore(1),
      runnerRegistry: registry,
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
    // The backend reports an empty list — drained.
    for (const c of containers) registry.get(c.sessionId)!.setBackgroundTasks([]);

    createIdleEnforcer({
      containerManager: cm,
      credentialStore: makeCredentialStore(0),
      runnerRegistry: registry,
    })();

    expect(destroy).toHaveBeenCalledTimes(2);
  });

  // The count is only meaningful while a streaming process is resident: the CLI
  // reaps background work when it exits, so a stale list must not keep the
  // container alive after the process is gone.
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
      credentialStore: makeCredentialStore(0),
      runnerRegistry: registry,
    })();

    expect(destroy).toHaveBeenCalledWith("a");
  });

  // planning#298 — the prod incident: a BACKGROUNDED `shipit agent run` consult (the
  // shape docs/236 tells agents to prefer) ends the primary turn, so `running`
  // is false; and with no resident streaming process `backgroundTaskCount` reads
  // 0 too. The session looked perfectly idle and its container was destroyed 12
  // minutes into an `xhigh` Codex review, leaving only a `cancelled` card.
  //
  // The assertion that matters is `destroy` — the planning#280 runner-level guard
  // already made `dispose` decline, and it declined AFTER `container.stop` had
  // been issued, which is exactly why it didn't save the review.
  it("never destroys the container of a runner with an in-flight sub-agent spawn", async () => {
    const containers = [{ sessionId: "consulting" }, { sessionId: "idle" }];
    const destroy = vi.fn().mockResolvedValue(undefined);
    const cm = makeContainerManager({ containers, destroy });

    const consulting = registry.getOrCreate("consulting", "/tmp/consulting", "claude" as AgentId);
    registry.getOrCreate("idle", "/tmp/idle", "claude" as AgentId);

    // A fake adapter that never finishes — the spawn stays in flight until we
    // let it complete below.
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

    // No viewer ever attached (so `lastViewerDetachAt` is 0 and the grace period
    // never applies — the incident's exact shape), and no turn is running.
    expect(consulting.running).toBe(false);
    expect(consulting.viewerCount).toBe(0);
    expect(consulting.subAgentSpawnsInFlight).toBe(1);
    // Eligibility half of the fix: the scan must see this as busy. (The runner's
    // own dispose guard is the second half — either alone would have saved the
    // consult only if the enforcer stopped firing `destroy` unconditionally.)
    expect(consulting.agentBusy).toBe(true);

    const enforce = createIdleEnforcer({
      containerManager: cm,
      credentialStore: makeCredentialStore(0),
      runnerRegistry: registry,
    });
    enforce();

    expect(destroy).not.toHaveBeenCalledWith("consulting");
    expect(consulting.disposed).toBe(false);
    // The genuinely-idle sibling is still reaped — the guard is narrow.
    expect(destroy).toHaveBeenCalledWith("idle");

    // Once the consult lands, the session is reclaimable like any other.
    agent.emit("done");
    await spawned;
    expect(consulting.subAgentSpawnsInFlight).toBe(0);
    expect(consulting.agentBusy).toBe(false);

    enforce();
    expect(destroy).toHaveBeenCalledWith("consulting");
  });

  // planning#298, second half — the enforcer used to fire `destroy` and `dispose`
  // unconditionally in sequence, so a runner that declined disposal still lost
  // its container (and was left pointed at a dead one). A declined dispose must
  // now mean the container is left alone.
  it("leaves the container alone when the runner declines disposal", () => {
    const containers = [{ sessionId: "stubborn" }];
    const destroy = vi.fn().mockResolvedValue(undefined);
    const cm = makeContainerManager({ containers, destroy });

    const runner = registry.getOrCreate("stubborn", "/tmp/stubborn", "claude" as AgentId);
    // Pass the enforcer's own gates but refuse at the runner level — the shape
    // any future runner-owned guard takes.
    const declining = runner as unknown as { dispose: (opts?: { force?: boolean }) => void };
    const origDispose = declining.dispose.bind(runner);
    declining.dispose = (opts?: { force?: boolean }) => {
      if (!opts?.force) return;
      origDispose(opts);
    };

    createIdleEnforcer({
      containerManager: cm,
      credentialStore: makeCredentialStore(0),
      runnerRegistry: registry,
    })();

    expect(destroy).not.toHaveBeenCalled();
    expect(runner.disposed).toBe(false);
  });

  it("skips runners whose viewer just detached (within grace period)", () => {
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
      r.detachViewer(); // just disconnected — within grace period
    }

    createIdleEnforcer({
      containerManager: cm,
      credentialStore: makeCredentialStore(0), // limit is zero — every idle runner over limit
      runnerRegistry: registry,
    })();

    expect(destroy).not.toHaveBeenCalled();
    for (const c of containers) {
      expect(registry.get(c.sessionId)?.disposed).toBe(false);
    }
  });

  it("disposes only runners whose grace period has expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const containers = [
      { sessionId: "old1" }, { sessionId: "old2" }, { sessionId: "fresh" },
    ];
    const destroy = vi.fn().mockResolvedValue(undefined);
    const cm = makeContainerManager({ containers, destroy });

    // old1 + old2 detached long ago, "fresh" detached just now.
    const old1 = registry.getOrCreate("old1", "/tmp/old1", "claude" as AgentId);
    old1.attachViewer(); old1.detachViewer();
    const old2 = registry.getOrCreate("old2", "/tmp/old2", "claude" as AgentId);
    old2.attachViewer(); old2.detachViewer();

    // Advance past grace period.
    vi.advanceTimersByTime(IDLE_GRACE_PERIOD_MS + 1_000);

    const fresh = registry.getOrCreate("fresh", "/tmp/fresh", "claude" as AgentId);
    fresh.attachViewer(); fresh.detachViewer();

    // maxIdle = 0 so any eligible idle runner is over the limit.
    createIdleEnforcer({
      containerManager: cm,
      credentialStore: makeCredentialStore(0),
      runnerRegistry: registry,
    })();

    // Both old runners eligible (2 > 0); fresh one is in grace period and skipped.
    // Excess = 2, so both old1 and old2 disposed; fresh untouched.
    expect(destroy).toHaveBeenCalledWith("old1");
    expect(destroy).toHaveBeenCalledWith("old2");
    expect(destroy).not.toHaveBeenCalledWith("fresh");
    expect(registry.get("fresh")?.disposed).toBe(false);
  });

  it("grace-period boundary: a runner detached IDLE_GRACE_PERIOD_MS - 1 ms ago is skipped, +1 ms is disposed", () => {
    // Pins the exact grace-period semantics so future drift to the constant
    // (or to the comparison operator) is caught immediately.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const containers = [{ sessionId: "edge" }];
    const destroy = vi.fn().mockResolvedValue(undefined);
    const cm = makeContainerManager({ containers, destroy });

    const r = registry.getOrCreate("edge", "/tmp/edge", "claude" as AgentId);
    r.attachViewer();
    r.detachViewer();

    // Tick 1: advance to JUST inside the grace period — runner must be skipped.
    vi.advanceTimersByTime(IDLE_GRACE_PERIOD_MS - 1);
    createIdleEnforcer({
      containerManager: cm,
      credentialStore: makeCredentialStore(0),
      runnerRegistry: registry,
    })();
    expect(destroy).not.toHaveBeenCalled();
    expect(registry.get("edge")?.disposed).toBe(false);

    // Tick 2: advance JUST past the grace period — now disposable.
    vi.advanceTimersByTime(2);
    createIdleEnforcer({
      containerManager: cm,
      credentialStore: makeCredentialStore(0),
      runnerRegistry: registry,
    })();
    expect(destroy).toHaveBeenCalledWith("edge");
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

    vi.advanceTimersByTime(IDLE_GRACE_PERIOD_MS + 1_000);

    // Patch registry.get to flip "a" back to running between scan and dispose.
    // This simulates a viewer reattaching or a turn starting in the gap.
    let flipped = false;
    const origGet = registry.get.bind(registry);
    registry.get = (sid: string) => {
      const r = origGet(sid);
      if (r && sid === "a" && !flipped) {
        flipped = true;
        // First call (scan) sees runner as detached idle.
        return r;
      }
      if (r && sid === "a" && flipped) {
        // Second call (dispose) — pretend a new viewer attached.
        r.attachViewer();
      }
      return r;
    };

    createIdleEnforcer({
      containerManager: cm,
      credentialStore: makeCredentialStore(0),
      runnerRegistry: registry,
    })();

    // "a" should NOT be destroyed because it became active between scan and dispose.
    expect(destroy).not.toHaveBeenCalledWith("a");
    // "b" remained idle the whole time → eligible. With maxIdle=0 and 2 idle
    // candidates from scan, excess = 2, but "a" survived the TOCTOU re-check,
    // so only "b" is destroyed.
    expect(destroy).toHaveBeenCalledWith("b");

    a.detachViewer();
  });

  it("skips standby containers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const containers = [{ sessionId: "a" }, { sessionId: "warm" }];
    const destroy = vi.fn().mockResolvedValue(undefined);
    const cm = makeContainerManager({
      containers,
      standby: new Set(["warm"]),
      destroy,
    });

    const r = registry.getOrCreate("a", "/tmp/a", "claude" as AgentId);
    r.attachViewer(); r.detachViewer();
    vi.advanceTimersByTime(IDLE_GRACE_PERIOD_MS + 1_000);

    createIdleEnforcer({
      containerManager: cm,
      credentialStore: makeCredentialStore(0),
      runnerRegistry: registry,
    })();

    // "warm" is standby and skipped from idle scan; only "a" was eligible.
    expect(destroy).toHaveBeenCalledWith("a");
    expect(destroy).not.toHaveBeenCalledWith("warm");
  });

  // --- Memory-pressure-aware behavior (feature 122) ---

  it("under eviction pressure: bypasses grace period and disposes idle runners with no viewer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const containers = [{ sessionId: "a" }];
    const destroy = vi.fn().mockResolvedValue(undefined);
    const cm = makeContainerManager({ containers, destroy });

    const r = registry.getOrCreate("a", "/tmp/a", "claude" as AgentId);
    r.attachViewer();
    r.detachViewer(); // just disconnected — normally protected by grace period

    // High pressure (95% used) — grace period must be bypassed.
    createIdleEnforcer({
      containerManager: cm,
      credentialStore: makeCredentialStore(5),
      runnerRegistry: registry,
      getMemoryStats: () => ({ usedBytes: 0.95 * 16 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 }),
    })();

    expect(destroy).toHaveBeenCalledWith("a");
  });

  it("under eviction pressure: drops effective maxIdle to 0 even when configured higher", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    // 3 idle containers past the grace period; configured maxIdle is 5.
    // Without pressure, none would be reaped (3 ≤ 5). With pressure, all 3 go.
    const containers = [{ sessionId: "a" }, { sessionId: "b" }, { sessionId: "c" }];
    const destroy = vi.fn().mockResolvedValue(undefined);
    const cm = makeContainerManager({ containers, destroy });

    for (const c of containers) {
      const r = registry.getOrCreate(c.sessionId, `/tmp/${c.sessionId}`, "claude" as AgentId);
      r.attachViewer(); r.detachViewer();
    }
    vi.advanceTimersByTime(IDLE_GRACE_PERIOD_MS + 1_000);

    createIdleEnforcer({
      containerManager: cm,
      credentialStore: makeCredentialStore(5),
      runnerRegistry: registry,
      getMemoryStats: () => ({ usedBytes: 0.90 * 16 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 }),
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
      credentialStore: makeCredentialStore(0),
      runnerRegistry: registry,
      getMemoryStats: () => ({ usedBytes: 0.99 * 16 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 }),
    })();

    // Even under extreme pressure, an active agent must not be killed.
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
      credentialStore: makeCredentialStore(0),
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

    // 50% used — well below the 85% eviction threshold.
    createIdleEnforcer({
      containerManager: cm,
      credentialStore: makeCredentialStore(0),
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

    // Without force, dispose is a no-op while running.
    registry.dispose("s1");
    expect(r.disposed).toBe(false);
    expect(registry.get("s1")).toBe(r);

    // With force, dispose proceeds.
    registry.dispose("s1", { force: true });
    expect(r.disposed).toBe(true);
  });

  it("disposeAll() forces disposal even when agents are running", () => {
    const registry = new SessionRunnerRegistry();
    const r1 = registry.getOrCreate("s1", "/tmp/s1", "claude" as AgentId);
    const r2 = registry.getOrCreate("s2", "/tmp/s2", "claude" as AgentId);
    r1.running = true;
    r2.running = true;

    // Shutdown / full reset must tear everything down regardless of state.
    registry.disposeAll();
    expect(r1.disposed).toBe(true);
    expect(r2.disposed).toBe(true);
  });
});

describe("buildRunnerFactory — runtimeMode dispatch (feature 118)", () => {
  it("local mode returns a factory that produces in-process SessionRunner", () => {
    // The seam: when RUNTIME_MODE=local, the factory must produce
    // SessionRunner (not ContainerSessionRunner), even if the caller passes
    // a non-null containerManager. Local mode is the harder branch — local
    // wins even if some Docker environment is partially present.
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
    // No `localAgentFactory` was passed, so there is nothing to bind an
    // account-scoped spawn to and `createAgent` stays unset — the registry's
    // onRunnerCreated wiring falls through to the process-level agentFactory.
    expect(runner.createAgent).toBeUndefined();
    runner.dispose({ force: true });
  });

  // docs/251 — the `/agent-ops` host is per session and must not outlive its
  // runner. This also covers the wiring itself: the teardown is a `once`
  // listener in the factory, so a missing import or a renamed export shows up
  // here rather than as an unhandled rejection during `disposeAll()` on the
  // shutdown path (which is exactly how it surfaced in the dogfood).
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
    // Teardown is async behind the sync `disposed` emit.
    await vi.waitFor(() => {
      expect(localAgentOpsSpawnEnv("ops-teardown")).toEqual({});
    });

    await resetLocalAgentOpsForTests();
  });

  // docs/260 — local mode has no per-session credentials mount, so the account
  // the TURN selected reaches the CLI only if the spawn is told which HOME to
  // use. Env-prep stamps the selection on the runner (`residentRoute`) before
  // the spawn resolves; `createAgent` reads that stamp lazily.
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
      // What env-prep does immediately before each spawn (docs/260 §5).
      r1.residentRoute = { kind: "account", id: "acct-a" };
      r2.residentRoute = { kind: "account", id: "acct-b" };
      r1.createAgent!("claude");
      r2.createAgent!("claude");

      // Two sessions routed to different accounts spawn against different
      // credential roots — the whole point, and what a single process-global
      // HOME could not express.
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
      // The next turn's selection lands elsewhere; env-prep re-stamps and the
      // retry spawns from the same runner.
      runner.residentRoute = { kind: "account", id: "acct-b" };
      runner.createAgent!("claude");

      expect(calls.map((c) => c.home)).toEqual([
        `${TEST_CREDENTIALS_DIR}/provider-accounts/claude/acct-a`,
        `${TEST_CREDENTIALS_DIR}/provider-accounts/claude/acct-b`,
      ]);
      runner.dispose({ force: true });
    });
  });

  // planning#300 — the second thing a local spawn has no worker to do for it. The
  // adapter's MCP write and the MCP env both happen at `createAgent`, next to
  // the account-scoped HOME above.
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
      // No bridge: its tools are transports to a worker local mode doesn't have.
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
    // Defensive: we should never accidentally end up in containerized mode
    // because some test left a containerManager around.
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
    // Without an injected runnerFactory and without a containerManager (the
    // shape integration tests use), the factory is undefined so the registry
    // falls back to its own default (in-process SessionRunner).
    const factory = buildRunnerFactory({
      deps: {},
      containerManager: null,
      credentialsDir: TEST_CREDENTIALS_DIR,
      runtimeMode: "containerized",
    });
    expect(factory).toBeUndefined();
  });

  it("explicit deps.runnerFactory wins over runtimeMode", () => {
    // Preserves the test-injection escape hatch — integration tests that
    // hand-roll a runnerFactory (e.g. to produce stub runners) shouldn't
    // have it overridden by the local-mode branch.
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

    // Without force: skipped (verified in session-runner.test.ts as well).
    runner.dispose();
    expect(disposedSpy).not.toHaveBeenCalled();
    expect(fakeAgent.kill).not.toHaveBeenCalled();

    // With force: proceeds.
    runner.dispose({ force: true });
    expect(disposedSpy).toHaveBeenCalled();
    expect(fakeAgent.kill).toHaveBeenCalled();
  });
});

/**
 * docs/088 Phase 2 follow-up — the startup-time MCP OAuth token refresh
 * sweep. The function is fire-and-forget from `scheduleStartupTasks`, but
 * exported separately so the wiring contract is testable without spinning
 * up the full orchestrator.
 *
 * Why these tests matter: without a startup refresh, a token that expired
 * while the orchestrator was down would be carried into the first agent
 * turn after restart and the worker would emit a `needs-auth` failure on
 * the next MCP tool call. The sweep closes that race.
 */
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
    // Token is 1 minute from expiry — well inside the 5-minute safety margin.
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
    // 1 hour from expiry — safely outside the safety margin.
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

    // Token still in place, unchanged.
    expect(store.getMcpOAuthTokens("notion_oauth")?.accessToken).toBe("fresh");
  });

  it("swallows refresh failures so startup is never blocked", async () => {
    store.setMcpOAuthTokens("notion_oauth", {
      accessToken: "stale",
      refreshToken: "rt-1",
      clientId: "cid",
      expiresAt: Date.now() - 1000, // already expired
    });

    const fakeFetch: typeof fetch = async () =>
      new Response("upstream blew up", { status: 500 });

    // Must not throw — the contract is "log and continue".
    await expect(
      runMcpOAuthStartupRefresh({ credentialStore: store, fetchImpl: fakeFetch }),
    ).resolves.toBeUndefined();

    // Stale token left in place so the worker can still surface a meaningful
    // `mcp_server_status` failure when the first MCP tool call lands.
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

/**
 * Regression: every `ready` repo gets warmed at boot, going through the
 * standard warm-pool flow — which now unconditionally creates a standby
 * container + pre-installs (docs/148). The previous bug here was that
 * startup-tasks bypassed pre-install by passing no opts to a function whose
 * `{ withStandby?: boolean }` opt-in defaulted to `false`. The opt was
 * removed (every caller wanted it `true`), so the regression class is
 * structurally impossible — this test now just pins that every ready repo
 * is in fact warmed at boot.
 */
describe("scheduleStartupTasks — warms every ready repo at boot (docs/148)", () => {
  it("calls warmSessionForRepo for stale, migrated, and fresh repos", async () => {
    const calls: string[] = [];
    const warmSessionForRepo = async (url: string): Promise<void> => {
      calls.push(url);
    };

    // Three repos covering the three startup branches:
    //  - `stale`: warm session id present but its workspace dir is missing → re-warm
    //  - `migrated`: in `migratedRepoUrls` → re-warm
    //  - `fresh`: ready repo with no warm session at all → re-warm
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-startup-warm-"));
    const staleClonePath = path.join(tmpDir, "missing"); // intentionally absent

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

    // The body is in a setTimeout(0); flush by waiting one tick.
    await new Promise((r) => setTimeout(r, 0));
    clearTimeout(timer);

    expect(calls.length).toBe(3);
    expect([...calls].sort()).toEqual(["fresh", "migrated", "stale"]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("wireEventHandlers — account-scoped auth SSE (docs/150)", () => {
  let tmp: string;

  /** Fake auth manager exposing a settable active account id. */
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

  /** Write what a completed Claude sign-in leaves in an account's root. */
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

  // docs/150-multiple-provider-subscriptions req 22 — the refusal has to happen on this event, not later. Once
  // the row goes `ready` it is selectable, and a duplicate is worst exactly
  // when it is picked as the failover target for the account it duplicates.
  it("refuses a completion that resolves to an already-connected account", () => {
    const { providerAccountManager, mgr, events, account } = setup();
    writeClaudeSignIn(providerAccountManager, account.id, "uuid-1", "dev@example.com");
    mgr.activeAccountId = account.id;
    mgr.emit("complete");

    const second = providerAccountManager.create("anthropic");
    writeClaudeSignIn(providerAccountManager, second.id, "uuid-1", "dev@example.com");
    mgr.activeAccountId = second.id;
    mgr.emit("complete");

    // No "connected" signal for the refused flow, and no second row.
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

  // docs/150-multiple-provider-subscriptions req 19 — a scope-less completion is no longer a supported flow
  // (`AgentAuthManager.start` requires the account), so this is the defensive
  // case: a manager emitting `complete` without a start. It must not fabricate
  // an account, and must not re-run the default-account migration the singleton
  // branch used to.
  it("a completion with no account scope marks nothing and invents no accountId", () => {
    const { mgr, events, providerAccountManager } = setup();
    const before = providerAccountManager.list("anthropic").map((a) => a.id);
    mgr.activeAccountId = null;

    mgr.emit("complete");

    const complete = events.find((e) => e.event === "agent_auth_complete");
    expect(complete?.data).toMatchObject({ loginId: "anthropic-oauth" });
    expect(complete?.data.accountId).toBeUndefined();
    // No row invented (the old `else` called migrateDefaultAccounts here) and
    // none flipped to ready off an unattributable completion.
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
      // Same fan-out mirror as `buildRegistry` below.
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
      // The status that changed belongs to the shared account route, so the
      // refresh must go out per LOGIN. Asserting the effect alone
      // (`refreshAuth("claude")`) would also pass a revert to the old
      // single-harness call, since the fan-out reaches Claude either way.
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
    // Mirrors the real registry: a login refresh fans out to every harness the
    // catalogue says that login serves. Keeping the real mapping here is what
    // makes the `refreshAuth` assertions below actually exercise the fan-out.
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
      // See the sibling test: assert the fan-out was chosen, not just its effect.
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
      // Idempotent means no refresh at all — neither the fan-out nor a direct one.
      expect(refreshAuthForLogin).not.toHaveBeenCalled();
      expect(events).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
