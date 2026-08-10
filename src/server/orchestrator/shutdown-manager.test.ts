/**
 * Guard tests for the graceful-shutdown hook.
 *
 * The load-bearing property here is a NEGATIVE one: shutting the orchestrator
 * down must not tear down session containers. docs/113 makes `Update Now`
 * zero-downtime by replacing only the orchestrator — `deploy.sh` deliberately
 * stopped killing session-worker containers, and the new process re-adopts the
 * survivors at boot (`rediscoverContainers()` + `reattachInFlightTurns()`).
 *
 * That guarantee was silently defeated for a year because the second kill path
 * lived inside this hook: `containerManager.dispose()` called `destroyAll()`.
 * On the 2026-08-10 production update six session containers were destroyed
 * nine seconds before the orchestrator container was even killed, taking two
 * live turns with them — one mid-tool-call.
 */

import { describe, it, expect, vi } from "vitest";
import { registerShutdownHook } from "./shutdown-manager.js";
import type { ShutdownDeps } from "./shutdown-manager.js";

/** Capture the `onClose` hook the way Fastify would. */
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

function buildDeps(): {
  deps: ShutdownDeps;
  containerManager: { dispose: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
  order: string[];
} {
  const order: string[] = [];
  const containerManager = {
    dispose: vi.fn(async () => { order.push("containerManager.dispose"); }),
    // Per-session teardown. Present so the test can assert the shutdown path
    // never reaches for it — a re-introduced sweep would show up here.
    destroy: vi.fn(async () => { order.push("containerManager.destroy"); }),
  };
  const deps = {
    startupTimer: setTimeout(() => {}, 60_000),
    authManagers: new Map(),
    runnerRegistry: {
      disposeAll: vi.fn(() => { order.push("runnerRegistry.disposeAll"); }),
    },
    // The armed post-turn pushes no longer live on the runners disposed above,
    // so shutdown has to drop them itself.
    autoPushScheduler: {
      cancelAll: vi.fn(() => { order.push("autoPushScheduler.cancelAll"); }),
    },
    dockerProxyServer: null,
    containerManager,
    databaseManager: {
      close: vi.fn(() => { order.push("databaseManager.close"); }),
    },
  } as unknown as ShutdownDeps;
  return { deps, containerManager, order };
}

describe("registerShutdownHook", () => {
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

    // Without this the forced dispose posts `/agent/kill`, the worker clears
    // `turnActive`, and `reattachInFlightTurns()` refuses to adopt the turn.
    // The behavior itself is guarded in `container-session-runner.test.ts`.
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
