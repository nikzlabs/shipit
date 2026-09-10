import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { adoptExistingServiceManager } from "../app-lifecycle.js";
import { ContainerSessionRunner } from "../container-session-runner.js";
import type { ServiceManager } from "../service-manager.js";
import type { SessionContainerManager } from "../session-container.js";

function makeRunner(sessionId: string): ContainerSessionRunner {
  return new ContainerSessionRunner({
    sessionId,
    sessionDir: "/tmp/x",
    defaultAgentId: "claude",
    workerUrl: "http://0.0.0.0:0", // Defer readiness until setWorkerUrl.
  });
}

interface StubServiceManager extends EventEmitter {
  _stopCalls: number;
  _stackErrorListenerCount: number;
  _setInstallRunningCalls: boolean[];
  _setInstallRunningOpts: ({ failed?: boolean } | undefined)[];
  _setSecretsLoaderCalls: (() => Promise<Record<string, string>>)[];
  installGateFailed: boolean;
  setInstallRunning(running: boolean, opts?: { failed?: boolean }): boolean;
  setSecretsLoader(loader: () => Promise<Record<string, string>>): void;
  stop(): Promise<void>;
  getSecretsSnapshot(): {
    declared: string[];
    missingByService: Record<string, string[]>;
    missingRequired: string[];
    agentNames: string[];
    agentValues: Record<string, string>;
  };
  getServices(): { name: string; status: string; port?: number; preview: string; error?: string }[];
}

function makeStubServiceManager(): StubServiceManager {
  const emitter = new EventEmitter();
  const mgr = Object.assign(emitter, {
    _stopCalls: 0,
    _stackErrorListenerCount: 0,
    _setInstallRunningCalls: [] as boolean[],
    _setInstallRunningOpts: [] as ({ failed?: boolean } | undefined)[],
    _setSecretsLoaderCalls: [] as (() => Promise<Record<string, string>>)[],
    _gateOpen: false,
    installGateFailed: false,
    setInstallRunning(running: boolean, opts?: { failed?: boolean }): boolean {
      if (this._gateOpen === running) return false;
      this._gateOpen = running;
      if (running) this.installGateFailed = false;
      else if (opts?.failed) this.installGateFailed = true;
      this._setInstallRunningCalls.push(running);
      this._setInstallRunningOpts.push(opts);
      return true;
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

    // One listener reports errors; the other sends the rebuilt service list.
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

    await Promise.resolve();
    await Promise.resolve();
    expect(cm._connectCalls).toHaveLength(0);

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

    runner.preserveComposeOnDispose = true;
    runner.dispose({ force: true });

    await Promise.resolve();
    await Promise.resolve();

    expect(mgr._stopCalls).toBe(0);
    expect(serviceManagers.has("s1")).toBe(true);
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

    runner.dispose({ force: true });

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
    });

    expect(mgr._setSecretsLoaderCalls).toHaveLength(0);

    runner.dispose({ force: true });
  });

  describe("install gate on adoption (docs/288)", () => {
    function adoptWithRelay(mgr: StubServiceManager, opts: { latchedFailed?: boolean } = {}): {
      runner: ContainerSessionRunner;
      decide: (d: "skipped" | "started") => void;
      finish: (res: { ok: boolean; unverified?: boolean }) => void;
      settle: () => Promise<void>;
    } {
      const runner = makeRunner("s1");
      if (opts.latchedFailed) mgr.installGateFailed = true;
      let resolveInstall!: (r: { ok: boolean; unverified?: boolean }) => void;
      const installPromise = new Promise<{ ok: boolean; unverified?: boolean }>((r) => {
        resolveInstall = r;
      });
      let listener: ((d: "skipped" | "started") => void) | undefined;
      adoptExistingServiceManager(runner, mgr as unknown as ServiceManager, {
        serviceManagers: new Map(),
        composeStopPromises: new Map(),
        containerManager: buildContainerManager(),
        installPromise,
        onInstallDecision: (fn) => { listener = fn; },
      });
      return {
        runner,
        decide: (d) => listener?.(d),
        finish: (res) => resolveInstall(res),
        settle: async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); },
      };
    }

    it("does NOT touch the gate when the worker skips the install (marker present)", async () => {
      const mgr = makeStubServiceManager();
      const h = adoptWithRelay(mgr);

      expect(mgr._setInstallRunningCalls).toEqual([]);

      h.decide("skipped");
      h.finish({ ok: true });
      await h.settle();

      expect(mgr._setInstallRunningCalls).toEqual([]);
      h.runner.dispose({ force: true });
    });

    it("brackets the gate when the worker says the install really runs", async () => {
      const mgr = makeStubServiceManager();
      const h = adoptWithRelay(mgr);

      h.decide("started");
      expect(mgr._setInstallRunningCalls).toEqual([true]);

      h.finish({ ok: true });
      await h.settle();
      expect(mgr._setInstallRunningCalls).toEqual([true, false]);
      expect(mgr._setInstallRunningOpts[1]).toEqual({ failed: false });
      h.runner.dispose({ force: true });
    });

    it("fails closed when the install fails without the worker ever deciding", async () => {
      const mgr = makeStubServiceManager();
      const h = adoptWithRelay(mgr);

      h.finish({ ok: false });
      await h.settle();
      expect(mgr._setInstallRunningCalls).toEqual([true, false]);
      expect(mgr._setInstallRunningOpts[1]).toEqual({ failed: true });
      h.runner.dispose({ force: true });
    });

    it("repairs a gate already latched by an earlier failure, even on a skip", async () => {
      const mgr = makeStubServiceManager();
      const h = adoptWithRelay(mgr, { latchedFailed: true });

      h.decide("skipped");
      expect(mgr._setInstallRunningCalls).toEqual([]);

      h.finish({ ok: true });
      await h.settle();
      expect(mgr._setInstallRunningCalls).toEqual([true, false]);
      expect(mgr._setInstallRunningOpts[1]).toEqual({ failed: false });
      h.runner.dispose({ force: true });
    });

    it("does NOT repair a latched gate on an UNVERIFIED completion", async () => {
      const mgr = makeStubServiceManager();
      const h = adoptWithRelay(mgr, { latchedFailed: true });

      h.decide("skipped");
      h.finish({ ok: true, unverified: true });
      await h.settle();
      expect(mgr._setInstallRunningCalls).toEqual([]);
      h.runner.dispose({ force: true });
    });
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

    expect(mgr._setInstallRunningCalls).toEqual([true]);

    resolveInstall({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(mgr._setInstallRunningCalls).toEqual([true, false]);
    expect(mgr._setInstallRunningOpts[1]).toEqual({ failed: false });

    runner.dispose({ force: true });
  });

  describe("dep-dir overlay re-point (#2426)", () => {
    const SESSION = { remoteUrl: "https://github.com/acme/repo.git", kind: "repo" };
    const PAIRS = [{ depDir: "node_modules", volumeName: "shipit-s1_overlay-aaaa" }];

    function buildOverlayContainerManager() {
      return {
        connectToNetwork: async () => undefined,
        provisionedOverlayDepDirs: () => PAIRS,
        dockerClient: { getVolume: () => ({ inspect: async () => ({}) }) },
        consumeOverlayVolumesRecreated: () => false,
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
        session: SESSION as never,
        workspaceDir: "/ws/s1",
      });

      runner.setWorkerUrl("http://10.0.0.42:4000");
      for (let i = 0; i < 50; i++) await Promise.resolve();
      runner.dispose({ force: true });
      return { reconciles, applied };
    }

    it("reconciles when the new container's overlay set differs", async () => {
      const { reconciles, applied } = await driveAdoption(true);
      expect(applied).toEqual([PAIRS]);
      expect(reconciles).toBe(1);
    });

    it("reconciles once when adopting a warm pre-started stack, even with nothing else changed", async () => {
      const runner = makeRunner("s1");
      let reconciles = 0;
      const applied: { file: string; dockerSocket: boolean }[] = [];
      const mgr = makeStubServiceManager() as StubServiceManager & {
        setOverlayDepDirs: (v: unknown[]) => boolean;
        reconcile: () => Promise<void>;
        preStartedWarm: boolean;
        updateComposeConfig: (c: { file: string; dockerSocket: boolean }) => boolean;
      };
      mgr.setOverlayDepDirs = () => false;
      mgr.reconcile = async () => { reconciles += 1; };
      mgr.preStartedWarm = true;
      mgr.updateComposeConfig = (c) => { applied.push(c); return false; };

      adoptExistingServiceManager(runner, mgr as unknown as ServiceManager, {
        serviceManagers: new Map(),
        composeStopPromises: new Map(),
        containerManager: buildOverlayContainerManager(),
        installPromise: null,
        session: SESSION as never,
        workspaceDir: "/ws/s1",
        composeConfig: { file: "docker-compose.yml", dockerSocket: false },
        noProjectCompose: false,
      });

      runner.setWorkerUrl("http://10.0.0.42:4000");
      for (let i = 0; i < 50; i++) await Promise.resolve();

      expect(applied).toEqual([{ file: "docker-compose.yml", dockerSocket: false }]);
      expect(reconciles).toBe(1);
      expect(mgr.preStartedWarm).toBe(false);
      runner.dispose({ force: true });
    });

    it("does not reconcile when the set is identical", async () => {
      const { reconciles, applied } = await driveAdoption(false);
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

    resolveInstall({ ok: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(mgr._setInstallRunningCalls).toEqual([true, false]);
    expect(mgr._setInstallRunningOpts[1]).toEqual({ failed: true });

    runner.dispose({ force: true });
  });
});
