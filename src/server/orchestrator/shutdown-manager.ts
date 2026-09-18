import type { LoginIntegrationId } from "../shared/catalogue/types.js";
import type { Server as HttpServer } from "node:http";
import type { FastifyInstance } from "fastify";
import type { AgentAuthManager } from "./agent-auth-manager.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { SessionContainerManager } from "./session-container.js";
import type { DatabaseManager } from "../shared/database.js";
import type { AutoPushScheduler } from "./services/auto-push-scheduler.js";
import { stopAllTokenWriteBackWatches } from "./session-token-publisher.js";

export interface ShutdownDeps {
  startupTimer: ReturnType<typeof setTimeout>;
  authManagers: Map<LoginIntegrationId, AgentAuthManager>;
  runnerRegistry: SessionRunnerRegistry;
  autoPushScheduler: AutoPushScheduler;
  dockerProxyServer: HttpServer | null;
  containerManager: SessionContainerManager | null;
  databaseManager: DatabaseManager;
  serviceManagers: Map<string, { stop: (opts?: { removeVolumes?: boolean }) => Promise<void> }>;
}

export function registerShutdownHook(
  app: FastifyInstance,
  shutdownDeps: ShutdownDeps,
): void {
  app.addHook("onClose", async () => {
    clearTimeout(shutdownDeps.startupTimer);
    // Include watches whose runners have already left the registry.
    stopAllTokenWriteBackWatches();
    for (const mgr of shutdownDeps.authManagers.values()) {
      mgr.kill();
    }
    // Preserve live agents for boot reattachment; Compose stacks are rebuilt.
    shutdownDeps.runnerRegistry.disposeAll({ preserveAgent: true });
    // Stops are best-effort here; the next boot reaps surviving stacks.
    for (const [sessionId, mgr] of shutdownDeps.serviceManagers) {
      if (shutdownDeps.runnerRegistry.get(sessionId)) continue;
      shutdownDeps.serviceManagers.delete(sessionId);
      void mgr.stop().catch((err: unknown) => {
        console.error(`[shutdown] Failed to stop orphaned compose stack for ${sessionId}:`, err);
      });
    }
    // Pending push timers belong to the app, not the disposed runners.
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
