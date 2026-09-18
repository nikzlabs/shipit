import { describe, it, expect, vi } from "vitest";
import { registerShutdownHook } from "./shutdown-manager.js";
import type { ShutdownDeps } from "./shutdown-manager.js";

function captureOnClose(): { app: any; run: () => Promise<void> } {
  let hook: (() => Promise<void>) | null = null;
  const app = {
    addHook: (name: string, fn: () => Promise<void>) => {
      if (name === "onClose") hook = fn;
    },
  };
  return {
    app,
    run: async () => {
      if (!hook) throw new Error("onClose hook was never registered");
      await hook();
    },
  };
}

function buildDeps(opts: { orphanedStacks?: string[] } = {}): {
  deps: ShutdownDeps;
  containerManager: { dispose: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
  serviceManagers: Map<string, { stop: ReturnType<typeof vi.fn> }>;
  order: string[];
} {
  const order: string[] = [];
  const containerManager = {
    dispose: vi.fn(async () => { order.push("containerManager.dispose"); }),
    destroy: vi.fn(async () => { order.push("containerManager.destroy"); }),
  };
  const serviceManagers = new Map<string, { stop: ReturnType<typeof vi.fn> }>(
    (opts.orphanedStacks ?? []).map((sid) => [
      sid,
      { stop: vi.fn(async () => { order.push(`serviceManagers.stop:${sid}`); }) },
    ]),
  );
  const deps = {
    startupTimer: setTimeout(() => {}, 60_000),
    authManagers: new Map(),
    runnerRegistry: {
      disposeAll: vi.fn(() => { order.push("runnerRegistry.disposeAll"); }),
      get: vi.fn(() => undefined),
    },
    serviceManagers,
    autoPushScheduler: {
      cancelAll: vi.fn(() => { order.push("autoPushScheduler.cancelAll"); }),
    },
    dockerProxyServer: null,
    containerManager,
    databaseManager: {
      close: vi.fn(() => { order.push("databaseManager.close"); }),
    },
  } as unknown as ShutdownDeps;
  return { deps, containerManager, serviceManagers, order };
}

describe("registerShutdownHook", () => {
  it("stops compose stacks left with no runner (tier-1 preserved previews)", async () => {
    const { app, run } = captureOnClose();
    const { deps, serviceManagers, order } = buildDeps({ orphanedStacks: ["orphan"] });

    registerShutdownHook(app, deps);
    await run();

    expect(serviceManagers.get("orphan")).toBeUndefined();
    expect(order).toContain("serviceManagers.stop:orphan");
  });

  it("leaves a stack alone while its session still has a live runner", async () => {
    const { app, run } = captureOnClose();
    const { deps, order } = buildDeps({ orphanedStacks: ["live"] });
    (deps.runnerRegistry as unknown as { get: ReturnType<typeof vi.fn> }).get =
      vi.fn(() => ({}) as never);

    registerShutdownHook(app, deps);
    await run();

    expect(order).not.toContain("serviceManagers.stop:live");
  });

  it("disposes the container manager without destroying any container", async () => {
    const { app, run } = captureOnClose();
    const { deps, containerManager } = buildDeps();

    registerShutdownHook(app, deps);
    await run();

    expect(containerManager.dispose).toHaveBeenCalledTimes(1);
    expect(containerManager.destroy).not.toHaveBeenCalled();
  });

  it("disposes runners before the container manager, and closes the DB last", async () => {
    const { app, run } = captureOnClose();
    const { deps, order } = buildDeps();

    registerShutdownHook(app, deps);
    await run();

    expect(order).toEqual([
      "runnerRegistry.disposeAll",
      "autoPushScheduler.cancelAll",
      "containerManager.dispose",
      "databaseManager.close",
    ]);
  });

  it("disposes runners with preserveAgent, so live turns are left for the next boot to adopt", async () => {
    const { app, run } = captureOnClose();
    const { deps } = buildDeps();

    registerShutdownHook(app, deps);
    await run();

    expect(deps.runnerRegistry.disposeAll).toHaveBeenCalledWith({ preserveAgent: true });
  });

  it("tolerates a missing container manager (local runtime mode)", async () => {
    const { app, run } = captureOnClose();
    const { deps } = buildDeps();
    (deps as { containerManager: unknown }).containerManager = null;

    registerShutdownHook(app, deps);
    await expect(run()).resolves.toBeUndefined();
  });
});
