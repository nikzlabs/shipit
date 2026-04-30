import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createIdleEnforcer, IDLE_GRACE_PERIOD_MS } from "./app-lifecycle.js";
import { SessionRunner, SessionRunnerRegistry } from "./session-runner.js";
import type { AgentId } from "../shared/types.js";
import type { CredentialStore } from "./credential-store.js";
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
