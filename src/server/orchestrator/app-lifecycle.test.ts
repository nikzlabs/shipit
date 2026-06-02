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
} from "./app-lifecycle.js";
import { SessionRunner, SessionRunnerRegistry } from "./session-runner.js";
import { ContainerSessionRunner } from "./container-session-runner.js";
import { CredentialStore } from "./credential-store.js";
import { ProviderAccountManager } from "./provider-account-manager.js";
import { SessionManager } from "./sessions.js";
import { createTestDatabaseManager } from "./integration_tests/test-helpers.js";
import type { AgentId } from "../shared/types.js";
import type { AgentAuthManager } from "./agent-auth-manager.js";
import type { GitHubAuthManager } from "./github-auth.js";
import type { AgentRegistry } from "../shared/agent-registry.js";
import type { SessionContainerManager } from "./session-container.js";

/**
 * These tests pin down the contract that protects running agents from being
 * killed by lifecycle events (idle cleanup, transient WebSocket disconnects).
 * The user's complaint was: "websocket should never affect how the server is
 * behaving" — the idle enforcer is the central enforcement point.
 */

interface FakeContainer { sessionId: string }

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
      credentialsDir: "/credentials",
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
    // Local runners have no in-container agent worker — `createAgent` should
    // be undefined so the registry's onRunnerCreated wiring falls through to
    // the process-level agentFactory.
    expect(runner.createAgent).toBeUndefined();
    runner.dispose({ force: true });
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
      credentialsDir: "/credentials",
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
      credentialsDir: "/credentials",
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
      credentialsDir: "/credentials",
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
    store.setMcpOAuthTokens("linear_oauth", {
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
    expect(store.getMcpOAuthTokens("linear_oauth")?.accessToken).toBe("fresh");
  });

  it("leaves a fresh token untouched", async () => {
    // 1 hour from expiry — safely outside the safety margin.
    store.setMcpOAuthTokens("linear_oauth", {
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
    expect(store.getMcpOAuthTokens("linear_oauth")?.accessToken).toBe("fresh");
  });

  it("swallows refresh failures so startup is never blocked", async () => {
    store.setMcpOAuthTokens("linear_oauth", {
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
    expect(store.getMcpOAuthTokens("linear_oauth")?.accessToken).toBe("stale");
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
    readonly agentId: AgentId = "claude";
    getActiveAccountId(): string | null { return this.activeAccountId; }
    start() {}
    cancel() {}
    signOut() {}
    isConfigured() { return true; }
    kill() {}
    getPendingPayload() { return null; }
  }

  function setup() {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-wire-auth-"));
    const credentialStore = new CredentialStore(tmp);
    const providerAccountManager = new ProviderAccountManager({ credentialsDir: tmp, credentialStore });
    const account = providerAccountManager.create("claude", "Work");
    const sessionManager = new SessionManager(createTestDatabaseManager());
    const mgr = new FakeAuthManager();
    const events: { event: string; data: Record<string, unknown> }[] = [];
    wireEventHandlers({
      authManagers: new Map<AgentId, AgentAuthManager>([["claude", mgr as unknown as AgentAuthManager]]),
      githubAuthManager: new EventEmitter() as unknown as GitHubAuthManager,
      agentRegistry: { refreshAuth: () => {}, list: () => [] } as unknown as AgentRegistry,
      providerAccountManager,
      sseBroadcast: (event, data) => events.push({ event, data: data as Record<string, unknown> }),
      credentialsDir: tmp,
      sessionManager,
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

    expect(providerAccountManager.get("claude", account.id)?.status).toBe("ready");
    const complete = events.find((e) => e.event === "agent_auth_complete");
    expect(complete?.data).toMatchObject({ agentId: "claude", accountId: account.id });
  });

  it("scoped failure marks the row auth_failed and qualifies the SSE", () => {
    const { providerAccountManager, mgr, events, account } = setup();
    mgr.activeAccountId = account.id;
    mgr.emit("failed", { reason: "error" });

    expect(providerAccountManager.get("claude", account.id)?.status).toBe("auth_failed");
    const failed = events.find((e) => e.event === "agent_auth_failed");
    expect(failed?.data).toMatchObject({ agentId: "claude", accountId: account.id, reason: "error" });
  });

  it("scoped pending qualifies the SSE with accountId", () => {
    const { mgr, events, account } = setup();
    mgr.activeAccountId = account.id;
    mgr.emit("pending", { kind: "code-paste-url", verificationUri: "https://example.com" });

    const pending = events.find((e) => e.event === "agent_auth_pending");
    expect(pending?.data).toMatchObject({ agentId: "claude", accountId: account.id });
  });

  it("singleton complete omits accountId", () => {
    const { mgr, events } = setup();
    mgr.activeAccountId = null;
    mgr.emit("complete");

    const complete = events.find((e) => e.event === "agent_auth_complete");
    expect(complete?.data).toMatchObject({ agentId: "claude" });
    expect(complete?.data.accountId).toBeUndefined();
  });
});
