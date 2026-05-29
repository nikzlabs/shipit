import type { Server as HttpServer } from "node:http";
import type { FastifyInstance } from "fastify";
import type { AgentAuthManager } from "./agent-auth-manager.js";
import type { AgentId } from "../shared/types.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { SessionContainerManager } from "./session-container.js";
import type { DatabaseManager } from "../shared/database.js";

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
    for (const mgr of shutdownDeps.authManagers.values()) {
      mgr.kill();
    }
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
