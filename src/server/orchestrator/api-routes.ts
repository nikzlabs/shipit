/**
 * HTTP API routes — barrel module.
 *
 * Delegates route registration to domain-specific modules while preserving
 * the original `registerApiRoutes()` signature for backwards compatibility.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { SessionManager } from "./sessions.js";
import type { RepoStore } from "./repo-store.js";
import type { GitManager } from "../shared/git.js";
import type { RepoGit } from "./repo-git.js";
import type { GitHubAuthManager } from "./github-auth.js";
import type { CredentialStore } from "./credential-store.js";
import type { AgentRegistry } from "../shared/agent-registry.js";
import type { AgentId } from "../shared/types.js";
import type { DeploymentManager } from "./deployment-manager.js";
import type { DeploymentStore } from "./deployment-store.js";
import type { UsageManager } from "./usage.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { SessionContainerManager } from "./session-container.js";
import type { ChatHistoryManager } from "./chat-history.js";
import type { AuthManager } from "./auth.js";
import type { PrStatusPoller } from "./pr-status-poller.js";
import type { DatabaseManager } from "../shared/database.js";

import { ServiceError } from "./services/index.js";

import { registerBootstrapRoutes } from "./api-routes-bootstrap.js";
import { registerFileRoutes } from "./api-routes-files.js";
import { registerGitRoutes } from "./api-routes-git.js";
import { registerSessionRoutes } from "./api-routes-session.js";
import { registerPreviewRoutes } from "./api-routes-preview.js";
import { registerGitHubRoutes } from "./api-routes-github.js";
import { registerDeployRoutes } from "./api-routes-deploy.js";

/**
 * Dependencies needed by API routes. A subset of AppDeps — only the
 * app-level managers, no per-connection state.
 */
export interface ApiDeps {
  sessionManager: SessionManager;
  repoStore: RepoStore;
  createGitManager: (dir: string) => GitManager;
  createRepoGit: (dir: string) => RepoGit;
  agentRegistry: AgentRegistry;
  githubAuthManager: GitHubAuthManager;
  credentialStore: CredentialStore;
  defaultAgentId: AgentId;
  workspaceDir: string;
  deploymentManager: DeploymentManager;
  deploymentStore: DeploymentStore;
  usageManager: UsageManager;
  runnerRegistry: SessionRunnerRegistry;
  chatHistoryManager: ChatHistoryManager;
  authManager: AuthManager;
  broadcastLog: (source: "stderr" | "stdout" | "server" | "preview" | "deploy" | "install", text: string) => void;
  sseBroadcast: (event: string, data: unknown) => void;
  getSharedRepoDir: (repoUrl: string) => string;
  createSessionDir: (title: string) => Promise<{ appSessionId: string; sessionDir: string }>;
  // Phase 3 additions
  generateText: (prompt: string, cwd?: string) => Promise<string>;
  sessionsRoot: string;
  /** Warm a session for a repo (called after clone, after graduation, etc.). */
  warmSessionForRepo?: (repoUrl: string, opts?: { withStandby?: boolean }) => void;
  /** Returns the in-flight warming promise for a repo, if any. */
  waitForWarmSession?: (repoUrl: string) => Promise<void> | undefined;
  /** Create session dir (same as createSessionDir — alias for claim-session). */
  createSessionDirFull: (title: string) => Promise<{ appSessionId: string; sessionDir: string }>;
  /** Container manager — needed for standby cleanup on repo delete. */
  containerManager?: SessionContainerManager;
  /** PR status poller — needed for tracking new PRs. */
  prStatusPoller?: PrStatusPoller;
  /** Database manager — needed for full reset to clear all tables atomically. */
  databaseManager?: DatabaseManager;
}

/**
 * Resolve a session ID to its workspace directory. Returns the session dir
 * or sends a 404 error and returns null.
 */
export function resolveSessionDir(
  sessionManager: SessionManager,
  sessionId: string,
  reply: FastifyReply,
): string | null {
  const session = sessionManager.get(sessionId);
  if (!session) {
    reply.code(404).send({ error: "Session not found" });
    return null;
  }
  if (!session.workspaceDir) {
    reply.code(404).send({ error: "Session has no workspace directory" });
    return null;
  }
  return session.workspaceDir;
}

/**
 * Register all HTTP API routes on the Fastify instance.
 * Called from buildApp() after managers are initialized.
 */
export async function registerApiRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  // ---- Error handler for ServiceError ----
  app.addHook("onError", (_request: FastifyRequest, reply: FastifyReply, error: Error, done: () => void) => {
    if (error instanceof ServiceError) {
      reply.code(error.statusCode).send({ error: error.message });
    }
    done();
  });

  // Register all domain-specific route modules
  await registerBootstrapRoutes(app, deps);
  await registerFileRoutes(app, deps);
  await registerGitRoutes(app, deps);
  await registerSessionRoutes(app, deps);
  await registerPreviewRoutes(app, deps);
  await registerGitHubRoutes(app, deps);
  await registerDeployRoutes(app, deps);
}
