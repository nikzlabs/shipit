/**
 * Unit tests for `adoptExistingServiceManager` — the lifecycle handoff
 * that lets `restartAgent` recreate the agent container while leaving
 * the running compose stack attached to a new runner.
 *
 * See docs/127-restart-agent.
 */

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { adoptExistingServiceManager } from "../app-lifecycle.js";
import { ContainerSessionRunner } from "../container-session-runner.js";
import type { ServiceManager } from "../service-manager.js";
import type { SessionContainerManager } from "../session-container.js";

/**
 * Build a ContainerSessionRunner with a placeholder worker URL so
 * `whenWorkerReady()` is deferred until we manually call `setWorkerUrl`.
 * The runner instance is real (so `isContainerRunner(runner)` returns
 * true), but we never actually connect to a worker.
 */
function makeRunner(sessionId: string): ContainerSessionRunner {
  return new ContainerSessionRunner({
    sessionId,
    sessionDir: "/tmp/x",
    defaultAgentId: "claude",
    workerUrl: "http://0.0.0.0:0", // placeholder — defers _workerReady
  });
}

interface StubServiceManager extends EventEmitter {
  _stopCalls: number;
  _stackErrorListenerCount: number;
  _setInstallRunningCalls: boolean[];
  _setInstallRunningOpts: ({ failed?: boolean } | undefined)[];
  _setSecretsLoaderCalls: (() => Promise<Record<string, string>>)[];
  setInstallRunning(running: boolean, opts?: { failed?: boolean }): void;
  setSecretsLoader(loader: () => Promise<Record<string, string>>): void;
  stop(): Promise<void>;
  /** Real runner's setServiceManager calls this — return an empty snapshot. */
  getSecretsSnapshot(): {
    declared: string[];
    missingByService: Record<string, string[]>;
    missingRequired: string[];
    agentNames: string[];
    agentValues: Record<string, string>;
  };
  /** Real runner's setServiceManager also calls this. */
  getServices(): { name: string; status: string; port?: number; preview: string; error?: string }[];
}

/**
 * Build a stub ServiceManager that satisfies the surface the real
 * ContainerSessionRunner.setServiceManager touches. Tracks stack_error
 * listener count and stop() calls so tests can assert on lifecycle.
 */
function makeStubServiceManager(): StubServiceManager {
  const emitter = new EventEmitter();
  const mgr = Object.assign(emitter, {
    _stopCalls: 0,
    _stackErrorListenerCount: 0,
    _setInstallRunningCalls: [] as boolean[],
    _setInstallRunningOpts: [] as ({ failed?: boolean } | undefined)[],
    _setSecretsLoaderCalls: [] as (() => Promise<Record<string, string>>)[],
    setInstallRunning(running: boolean, opts?: { failed?: boolean }) {
      this._setInstallRunningCalls.push(running);
      this._setInstallRunningOpts.push(opts);
    },
    setSecretsLoader(loader: () => Promise<Record<string, string>>) {
      this._setSecretsLoaderCalls.push(loader);
    },
    async stop() { this._stopCalls += 1; },
    getSecretsSnapshot() {
      return {
        declared: [],
        missingByService: {},
        missingRequired: [],
        agentNames: [],
        agentValues: {},
      };
    },
    getServices() { return []; },
  });
  // Wrap on/off to track stack_error listener count for assertions.
  const originalOn = mgr.on.bind(mgr);
  mgr.on = ((ev: string, fn: (...args: unknown[]) => void) => {
    if (ev === "stack_error") mgr._stackErrorListenerCount += 1;
    return originalOn(ev, fn);
  }) as typeof mgr.on;
  const originalOff = mgr.off.bind(mgr);
  mgr.off = ((ev: string, fn: (...args: unknown[]) => void) => {
    if (ev === "stack_error") mgr._stackErrorListenerCount -= 1;
    return originalOff(ev, fn);
  }) as typeof mgr.off;
  return mgr as unknown as StubServiceManager;
}

function buildContainerManager(): SessionContainerManager & {
  _connectCalls: { sessionId: string; network: string; at: number }[];
} {
  const calls: { sessionId: string; network: string; at: number }[] = [];
  const cm = {
    connectToNetwork: async (sessionId: string, network: string) => {
      calls.push({ sessionId, network, at: Date.now() });
    },
    _connectCalls: calls,
  };
  return cm as unknown as SessionContainerManager & { _connectCalls: typeof calls };
}

describe("adoptExistingServiceManager (docs/127)", () => {
  it("wires the manager onto the new runner", () => {
    const runner = makeRunner("s1");
    const mgr = makeStubServiceManager();
    const cm = buildContainerManager();

    adoptExistingServiceManager(runner, mgr as unknown as ServiceManager, {
      serviceManagers: new Map(),
      composeStopPromises: new Map(),
      containerManager: cm,
      installPromise: null,
    });

    // Real runner exposes the manager via getter — confirms adoption wiring.
    expect(runner.serviceManager).toBe(mgr);

    runner.dispose({ force: true });
  });

  it("attaches one stack_error listener per concern, and no duplicates", () => {
    const runner = makeRunner("s1");
    const mgr = makeStubServiceManager();
    const cm = buildContainerManager();

    adoptExistingServiceManager(runner, mgr as unknown as ServiceManager, {
      serviceManagers: new Map(),
      composeStopPromises: new Map(),
      containerManager: cm,
      installPromise: null,
    });

    // Two, and each is a different job on the same event: the adoption path's
    // own listener reports the failure (banner + Logs), and the runner's
    // `setServiceManager` re-sends the service list, because a start that failed
    // rebuilt the map just as much as one that succeeded (#2325). What this
    // guards is that adoption does not STACK them — a third would mean the same
    // failure reported twice, which is the docs/127 regression.
    expect(mgr._stackErrorListenerCount).toBe(2);

    runner.dispose({ force: true });
  });

  it("defers connectToNetwork until whenWorkerReady() resolves (fixes the race)", async () => {
    const runner = makeRunner("s1");
    const mgr = makeStubServiceManager();
    const cm = buildContainerManager();

    adoptExistingServiceManager(runner, mgr as unknown as ServiceManager, {
      serviceManagers: new Map(),
      composeStopPromises: new Map(),
      containerManager: cm,
      installPromise: null,
    });

    // Synchronously after the call AND a couple of microtask drains,
    // connectToNetwork must NOT have fired — the runner is in placeholder
    // mode and whenWorkerReady() is unresolved.
    await Promise.resolve();
    await Promise.resolve();
    expect(cm._connectCalls).toHaveLength(0);

    // Drive the readiness signal (simulates the container manager calling
    // runner.setWorkerUrl once the new container's IP resolves).
    runner.setWorkerUrl("http://10.0.0.42:4000");
    await Promise.resolve();
    await Promise.resolve();

    expect(cm._connectCalls).toHaveLength(1);
    expect(cm._connectCalls[0]).toMatchObject({
      sessionId: "s1",
      network: "shipit-session-s1",
    });

    runner.dispose({ force: true });
  });

  it("stops the old-policy stack before waiting for worker readiness", async () => {
    const runner = makeRunner("s1");
    const mgr = makeStubServiceManager() as StubServiceManager & {
      updateEgressContainment: () => boolean;
      reconcile: () => Promise<void>;
    };
    mgr.updateEgressContainment = () => true;
    mgr.reconcile = async () => undefined;
    const cm = buildContainerManager();

    adoptExistingServiceManager(runner, mgr as unknown as ServiceManager, {
      serviceManagers: new Map(),
      composeStopPromises: new Map(),
      containerManager: cm,
      installPromise: null,
      containServicesFn: async () => undefined,
      resetSessionNetwork: async () => undefined,
    });

    await Promise.resolve();
    expect(mgr._stopCalls).toBe(1);
    expect(cm._connectCalls).toHaveLength(0);
    runner.dispose({ force: true });
  });

  it("disposed handler preserves the manager when preserveComposeOnDispose is true", async () => {
    const runner = makeRunner("s1");
    const mgr = makeStubServiceManager();
    const cm = buildContainerManager();
    const serviceManagers = new Map<string, ServiceManager>([
      ["s1", mgr as unknown as ServiceManager],
    ]);

    adoptExistingServiceManager(runner, mgr as unknown as ServiceManager, {
      serviceManagers,
      composeStopPromises: new Map(),
      containerManager: cm,
      installPromise: null,
    });

    // Simulate the restartAgent-style dispose path.
    runner.preserveComposeOnDispose = true;
    runner.dispose({ force: true });

    // Microtasks settle (stop is async even though we never call it here).
    await Promise.resolve();
    await Promise.resolve();

    // CRITICAL: stop() must NOT have been called — the point of the
    // preserve flag is to keep compose running.
    expect(mgr._stopCalls).toBe(0);
    // Map entry survives so the next setupServiceManager adopts it.
    expect(serviceManagers.has("s1")).toBe(true);
    // The OLD runner's stack_error listener is detached so it can't fire
    // for the (preserved) manager's future errors.
    expect(mgr._stackErrorListenerCount).toBe(0);
  });

  it("disposed handler tears down the manager when preserveComposeOnDispose is false", async () => {
    const runner = makeRunner("s1");
    const mgr = makeStubServiceManager();
    const cm = buildContainerManager();
    const serviceManagers = new Map<string, ServiceManager>([
      ["s1", mgr as unknown as ServiceManager],
    ]);

    adoptExistingServiceManager(runner, mgr as unknown as ServiceManager, {
      serviceManagers,
      composeStopPromises: new Map(),
      containerManager: cm,
      installPromise: null,
    });

    // Default flow: dispose WITHOUT preserve → tear down compose AND
    // evict from the map (same semantics as the create-path disposed handler).
    runner.dispose({ force: true });

    // mgr.stop() runs asynchronously — let it settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(mgr._stopCalls).toBe(1);
    expect(serviceManagers.has("s1")).toBe(false);
    expect(mgr._stackErrorListenerCount).toBe(0);
  });

  it("refreshes the manager's secretsLoader with the fresh closure", () => {
    const runner = makeRunner("s1");
    const mgr = makeStubServiceManager();
    const cm = buildContainerManager();
    const freshLoader = async () => ({ DATABASE_URL: "postgres://new" });

    adoptExistingServiceManager(runner, mgr as unknown as ServiceManager, {
      serviceManagers: new Map(),
      composeStopPromises: new Map(),
      containerManager: cm,
      installPromise: null,
      secretsLoader: freshLoader,
    });

    // The adopted manager must have been handed the new closure — the
    // OLD closure baked in at original construction referenced the now-
    // disposed previous runner.
    expect(mgr._setSecretsLoaderCalls).toHaveLength(1);
    expect(mgr._setSecretsLoaderCalls[0]).toBe(freshLoader);

    runner.dispose({ force: true });
  });

  it("skips setSecretsLoader when no loader is provided (no compose secrets configured)", () => {
    const runner = makeRunner("s1");
    const mgr = makeStubServiceManager();
    const cm = buildContainerManager();

    adoptExistingServiceManager(runner, mgr as unknown as ServiceManager, {
      serviceManagers: new Map(),
      composeStopPromises: new Map(),
      containerManager: cm,
      installPromise: null,
      // secretsLoader intentionally omitted
    });

    expect(mgr._setSecretsLoaderCalls).toHaveLength(0);

    runner.dispose({ force: true });
  });

  it("re-arms install-running gate around the new container's install", async () => {
    const runner = makeRunner("s1");
    const mgr = makeStubServiceManager();
    const cm = buildContainerManager();

    let resolveInstall!: (result: { ok: boolean }) => void;
    const installPromise = new Promise<{ ok: boolean }>((r) => { resolveInstall = r; });

    adoptExistingServiceManager(runner, mgr as unknown as ServiceManager, {
      serviceManagers: new Map(),
      composeStopPromises: new Map(),
      containerManager: cm,
      installPromise,
    });

    // Install starts → gate opens immediately
    expect(mgr._setInstallRunningCalls).toEqual([true]);

    // Install finishes → gate closes
    resolveInstall({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(mgr._setInstallRunningCalls).toEqual([true, false]);
    // Successful install closes the gate without the `failed` flag.
    expect(mgr._setInstallRunningOpts[1]).toEqual({ failed: false });

    runner.dispose({ force: true });
  });

  /**
   * #2426 — the compose override is written by `start()`/`reconcile()` and by
   * nothing else, so re-pointing an adopted manager at a different overlay set
   * has to be followed by a reconcile. Without it the stale override on disk
   * keeps feeding every later `compose up`, and a service container — whose
   * mount set is frozen at CREATE time — is merely `start`ed with the wrong
   * mounts, indefinitely.
   */
  describe("dep-dir overlay re-point (#2426)", () => {
    const SESSION = { remoteUrl: "https://github.com/acme/repo.git", kind: "repo" };
    const PAIRS = [{ depDir: "node_modules", volumeName: "shipit-s1_overlay-aaaa" }];

    function buildOverlayContainerManager() {
      return {
        connectToNetwork: async () => undefined,
        provisionedOverlayDepDirs: () => PAIRS,
        dockerClient: { getVolume: () => ({ inspect: async () => ({}) }) },
      } as unknown as SessionContainerManager;
    }

    async function driveAdoption(
      setOverlayChanged: boolean,
    ): Promise<{ reconciles: number; applied: unknown[][] }> {
      const runner = makeRunner("s1");
      let reconciles = 0;
      const applied: unknown[][] = [];
      const mgr = makeStubServiceManager() as StubServiceManager & {
        setOverlayDepDirs: (v: unknown[]) => boolean;
        reconcile: () => Promise<void>;
      };
      mgr.setOverlayDepDirs = (v: unknown[]) => { applied.push(v); return setOverlayChanged; };
      mgr.reconcile = async () => { reconciles += 1; };

      adoptExistingServiceManager(runner, mgr as unknown as ServiceManager, {
        serviceManagers: new Map(),
        composeStopPromises: new Map(),
        containerManager: buildOverlayContainerManager(),
        installPromise: null,
        // Containment deliberately UNCHANGED — the overlay set is the only
        // reason a reconcile could be owed here.
        session: SESSION as never,
        workspaceDir: "/ws/s1",
      });

      runner.setWorkerUrl("http://10.0.0.42:4000");
      // The chain is whenWorkerReady → applyOverlayDepDirs (two Docker awaits)
      // → reconcile → connectToNetwork; drain generously rather than counting.
      for (let i = 0; i < 50; i++) await Promise.resolve();
      runner.dispose({ force: true });
      return { reconciles, applied };
    }

    it("reconciles when the new container's overlay set differs", async () => {
      const { reconciles, applied } = await driveAdoption(true);
      expect(applied).toEqual([PAIRS]);
      expect(reconciles).toBe(1);
    });

    it("does not reconcile when the set is identical", async () => {
      // The common case: volume names are session-stable, so a recreate mints
      // the same names and the override on disk is still correct. Reconciling
      // anyway would restart the stack on every agent restart.
      const { reconciles, applied } = await driveAdoption(false);
      // Asserted so the negative can't pass vacuously: the re-point DID run,
      // it just had nothing to change.
      expect(applied).toEqual([PAIRS]);
      expect(reconciles).toBe(0);
    });
  });

  it("propagates install failure to the gate (failed: true)", async () => {
    const runner = makeRunner("s1");
    const mgr = makeStubServiceManager();
    const cm = buildContainerManager();

    let resolveInstall!: (result: { ok: boolean }) => void;
    const installPromise = new Promise<{ ok: boolean }>((r) => { resolveInstall = r; });

    adoptExistingServiceManager(runner, mgr as unknown as ServiceManager, {
      serviceManagers: new Map(),
      composeStopPromises: new Map(),
      containerManager: cm,
      installPromise,
    });

    expect(mgr._setInstallRunningCalls).toEqual([true]);

    // Install finishes with a failure → gate closes with failed: true so
    // gated services latch to error instead of starting.
    resolveInstall({ ok: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(mgr._setInstallRunningCalls).toEqual([true, false]);
    expect(mgr._setInstallRunningOpts[1]).toEqual({ failed: true });

    runner.dispose({ force: true });
  });
});
