import type { LoginIntegrationId } from "../shared/catalogue/types.js";
import type { Server as HttpServer } from "node:http";
import type { FastifyInstance } from "fastify";
import type { AgentAuthManager } from "./agent-auth-manager.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { SessionContainerManager } from "./session-container.js";
import type { DatabaseManager } from "../shared/database.js";
import type { AutoPushScheduler } from "./services/auto-push-scheduler.js";
import { stopAllTokenWriteBackWatches } from "./session-token-publisher.js";

// ---- Graceful shutdown ----

/** Dependencies for shutdown hook. */
export interface ShutdownDeps {
  startupTimer: ReturnType<typeof setTimeout>;
  /**
   * Every login flow, keyed by `LoginIntegrationId`. The shutdown hook iterates
   * this map so adding a new login flow doesn't require an explicit `kill()`
   * line here. (docs/155 Phase 2)
   */
  authManagers: Map<LoginIntegrationId, AgentAuthManager>;
  runnerRegistry: SessionRunnerRegistry;
  /**
   * Pending post-turn auto-pushes. Session-keyed and app-scoped rather than
   * stored on the runners disposed below (`services/auto-push-scheduler.ts`), so
   * teardown has to drop them explicitly — nothing else will.
   */
  autoPushScheduler: AutoPushScheduler;
  dockerProxyServer: HttpServer | null;
  containerManager: SessionContainerManager | null;
  databaseManager: DatabaseManager;
  /**
   * docs/284 — per-session Compose stacks. Needed here because a tier-1
   * reclaim leaves a stack running with no runner, so nothing else would fire
   * its teardown. See the loop below.
   */
  serviceManagers: Map<string, { stop: (opts?: { removeVolumes?: boolean }) => Promise<void> }>;
}

/**
 * Register the graceful shutdown hook on the Fastify app.
 */
export function registerShutdownHook(
  app: FastifyInstance,
  shutdownDeps: ShutdownDeps,
): void {
  app.addHook("onClose", async () => {
    clearTimeout(shutdownDeps.startupTimer);
    // docs/153 — drop the mid-turn token watches before anything else. The
    // per-runner `disposed` backstop below would catch them too, but only for
    // runners the registry still holds; this is unconditional and cheap.
    stopAllTokenWriteBackWatches();
    for (const mgr of shutdownDeps.authManagers.values()) {
      mgr.kill();
    }
    // `preserveAgent` — the container surviving the swap is only half of
    // "running turns survive an update" (docs/113). An ordinary forced dispose
    // posts `/agent/kill` to the worker, which clears its `turnActive`, and the
    // next orchestrator's `reattachInFlightTurns()` (docs/240) adopts a turn
    // only while that flag is true. So without this the CLI dies inside a
    // perfectly healthy container, its transcript tail is never persisted and
    // its post-turn commit never runs — the second half of the 2026-08-10
    // incident. Full reset deliberately does NOT pass it.
    //
    // `disposeAll()` also fires each runner's `disposed` handler, which runs
    // `docker compose down` for the session's stack (service-manager-setup.ts).
    // That is deliberately LEFT ALONE: unlike the agent container, a Compose
    // stack is not adopted across the swap — `ServiceManager.start()` opens with
    // `killStaleContainers()`, which force-removes every
    // `shipit-parent-session=<sid>` container before `compose up`, so the next
    // orchestrator rebuilds the stack whether or not it survived. Preserving it
    // here would only leave a dev server running for a session nobody reopens.
    // The agent container is the opposite case, which is why `dispose()` below
    // must not touch it — see `session-container.ts`.
    shutdownDeps.runnerRegistry.disposeAll({ preserveAgent: true });
    // docs/284 — the same reasoning, for the stacks that have no runner left to
    // fire a `disposed` handler. Tier-1 reclaim keeps a session's Compose stack
    // running after disposing its runner, and `serviceManagers` is process-local:
    // the next orchestrator cannot route to such a stack (`preview-proxy.ts`
    // resolves through that map) or reclaim it, so leaving it up is exactly the
    // "dev server running for a session nobody reopens" this hook already
    // refuses. The user reopening the session rebuilds it, as it always did.
    for (const [sessionId, mgr] of shutdownDeps.serviceManagers) {
      if (shutdownDeps.runnerRegistry.get(sessionId)) continue;
      shutdownDeps.serviceManagers.delete(sessionId);
      void mgr.stop().catch((err: unknown) => {
        console.error(`[shutdown] Failed to stop orphaned compose stack for ${sessionId}:`, err);
      });
    }
    // The armed pushes no longer live on those runners, so drop them here. A
    // push that has already fired is unaffected — it is an awaited git call, not
    // a timer.
    shutdownDeps.autoPushScheduler.cancelAll();
    if (shutdownDeps.dockerProxyServer) {
      await new Promise<void>((resolve) => shutdownDeps.dockerProxyServer!.close(() => resolve()));
    }
    if (shutdownDeps.containerManager) {
      await shutdownDeps.containerManager.dispose();
    }
    shutdownDeps.databaseManager.close();
  });
}
