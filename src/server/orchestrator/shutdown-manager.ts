import type { Server as HttpServer } from "node:http";
import type { FastifyInstance } from "fastify";
import type { AgentAuthManager } from "./agent-auth-manager.js";
import type { AgentId } from "../shared/types.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { SessionContainerManager } from "./session-container.js";
import type { DatabaseManager } from "../shared/database.js";
import { stopAllTokenWriteBackWatches } from "./session-token-publisher.js";

// ---- Graceful shutdown ----

/** Dependencies for shutdown hook. */
export interface ShutdownDeps {
  startupTimer: ReturnType<typeof setTimeout>;
  /**
   * Every per-agent auth manager, keyed by agent id. The shutdown hook
   * iterates this map so adding a new backend doesn't require an explicit
   * `kill()` line here. (docs/155 Phase 2)
   */
  authManagers: Map<AgentId, AgentAuthManager>;
  runnerRegistry: SessionRunnerRegistry;
  dockerProxyServer: HttpServer | null;
  containerManager: SessionContainerManager | null;
  databaseManager: DatabaseManager;
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
    shutdownDeps.runnerRegistry.disposeAll();
    if (shutdownDeps.dockerProxyServer) {
      await new Promise<void>((resolve) => shutdownDeps.dockerProxyServer!.close(() => resolve()));
    }
    if (shutdownDeps.containerManager) {
      await shutdownDeps.containerManager.dispose();
    }
    shutdownDeps.databaseManager.close();
  });
}
