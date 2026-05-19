import type { Server as HttpServer } from "node:http";
import type { FastifyInstance } from "fastify";
import type { AuthManager } from "./auth.js";
import type { CodexAuthManager } from "./codex-auth.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { SessionContainerManager } from "./session-container.js";
import type { DatabaseManager } from "../shared/database.js";

// ---- Graceful shutdown ----

/** Dependencies for shutdown hook. */
export interface ShutdownDeps {
  startupTimer: ReturnType<typeof setTimeout>;
  authManager: AuthManager;
  codexAuthManager: CodexAuthManager;
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
    shutdownDeps.authManager.kill();
    shutdownDeps.codexAuthManager.kill();
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
