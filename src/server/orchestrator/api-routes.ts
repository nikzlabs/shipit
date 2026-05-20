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
import type { AgentId, AgentProcess } from "../shared/types.js";
import type { UsageManager } from "./usage.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { SessionContainerManager } from "./session-container.js";
import type { ChatHistoryManager } from "./chat-history.js";
import type { AuthManager } from "./auth.js";
import type { CodexAuthManager } from "./codex-auth.js";
import type { PrStatusPoller } from "./pr-status-poller.js";
import type { DatabaseManager } from "../shared/database.js";
import type { ServiceManager } from "./service-manager.js";
import type { WsLogEntry } from "../shared/types.js";
import type { SessionOomCircuitBreaker } from "./oom-circuit-breaker.js";
import type { SessionLoopDetector } from "./loop-detector.js";
import type { RuntimeMode } from "../shared/types.js";

import { ServiceError } from "./services/index.js";

import { registerBootstrapRoutes } from "./api-routes-bootstrap.js";
import { registerContainerRoutes } from "./api-routes-container.js";
import { registerFileRoutes } from "./api-routes-files.js";
import { registerGitRoutes } from "./api-routes-git.js";
import { registerSessionRoutes } from "./api-routes-session.js";
import { registerPreviewRoutes } from "./api-routes-preview.js";
import { registerGitHubRoutes } from "./api-routes-github.js";
import { registerSecretsRoutes } from "./api-routes-secrets.js";
import { registerMcpRoutes } from "./api-routes-mcp.js";
import { registerReviewRoutes } from "./api-routes-reviews.js";
import { registerUpdateRoutes } from "./api-routes-updates.js";
import type { SecretStore } from "./secret-store.js";
import type { FileReviewStore } from "./review-store.js";

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
  /**
   * Orchestrator runtime mode (feature 118). Forwarded into the bootstrap
   * payload so the client can surface local-mode UI. Defaults to
   * `"containerized"` when omitted.
   */
  runtimeMode?: RuntimeMode;
  /**
   * docs/138 — source-of-truth credentials root (e.g. `/credentials`). Used by
   * `fullReset` to drop all per-session credential subtrees. Omitted in
   * runtimes without container credentials (tests, local mode).
   */
  credentialsDir?: string;
  usageManager: UsageManager;
  runnerRegistry: SessionRunnerRegistry;
  chatHistoryManager: ChatHistoryManager;
  authManager: AuthManager;
  codexAuthManager: CodexAuthManager;
  broadcastLog: (sessionId: string, source: "stderr" | "stdout" | "server" | "preview" | "install", text: string) => void;
  sseBroadcast: (event: string, data: unknown) => void;
  getSharedRepoDir: (repoUrl: string) => string;
  createSessionDir: (title: string) => Promise<{ appSessionId: string; sessionDir: string; workspaceDir: string }>;
  // Phase 3 additions
  generateText: (prompt: string, cwd: string) => Promise<string>;
  sessionsRoot: string;
  /** Warm a session for a repo (called after clone, after graduation, etc.). */
  warmSessionForRepo?: (repoUrl: string, opts?: { withStandby?: boolean }) => Promise<void>;
  /** Returns the in-flight warming promise for a repo, if any. */
  waitForWarmSession?: (repoUrl: string) => Promise<void> | undefined;
  /** Create session dir (same as createSessionDir — alias for claim-session). */
  createSessionDirFull: (title: string) => Promise<{ appSessionId: string; sessionDir: string; workspaceDir: string }>;
  /** Container manager — needed for standby cleanup on repo delete. */
  containerManager?: SessionContainerManager;
  /** PR status poller — needed for tracking new PRs. */
  prStatusPoller?: PrStatusPoller;
  /** Database manager — needed for full reset to clear all tables atomically. */
  databaseManager?: DatabaseManager;
  /** Secret store — per-repo env var secrets for preview containers. */
  secretStore?: SecretStore;
  /** File review store — unified review surface persistence (per session/file). */
  reviewStore?: FileReviewStore;
  /** Service managers — per-session compose lifecycle (keyed by sessionId). */
  serviceManagers?: Map<string, ServiceManager>;
  /**
   * In-flight `mgr.stop()` promises keyed by sessionId. Used by `fullReset`
   * to await per-session compose-downs before wiping the workspace dir,
   * so we don't race the docker tool that's still tearing volumes down.
   */
  composeStopPromises?: Map<string, Promise<void>>;
  /**
   * Fallback volume prune for `archiveSession` when no runner is in the
   * registry (so `removeVolumesOnDispose` can't fire). Shells out to
   * `docker volume prune` filtered by `shipit-session=<id>`. Omitted in
   * test mode so tests don't touch the host Docker daemon.
   */
  pruneSessionVolumes?: (sessionId: string) => Promise<void>;
  /**
   * Read the per-session orchestrator log ring. Used by the diagnostics
   * endpoint to include the most recent log entries in the bug-report
   * payload. Optional — test setups may omit it (the endpoint then
   * returns an empty `recentLogs` array).
   */
  getLogBuffer?: (sessionId: string) => WsLogEntry[];
  /**
   * OOM circuit breaker — passed into recovery service handlers so
   * user-initiated restarts reset the trip, and into the diagnostics
   * service so the panel can render the current breaker state.
   */
  oomBreaker?: SessionOomCircuitBreaker;
  /**
   * SIGTERM/recreate loop detector — passed into recovery service handlers
   * so a user-initiated restart clears the per-session event window. The
   * loop detector and the OOM breaker both gate the runner factory;
   * resetting one without the other leaves the restart blocked.
   */
  loopDetector?: SessionLoopDetector;
  /**
   * Optional fallback agent factory. Container runners create their own agents
   * via `runner.createAgent()`; this is only used when the runner has no
   * factory of its own (in-process tests).
   */
  agentFactory?: (agentId: AgentId) => AgentProcess;
  /**
   * Override the `fetch` used by MCP OAuth code-exchange / refresh
   * (docs/088 Phase 2). Tests inject a fake; production leaves this
   * undefined and the OAuth service uses the global `fetch`.
   */
  mcpOAuthFetchImpl?: typeof fetch;
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
  await registerContainerRoutes(app, deps);
  await registerPreviewRoutes(app, deps);
  await registerGitHubRoutes(app, deps);
  if (deps.reviewStore) {
    await registerReviewRoutes(app, deps);
  }
  if (deps.secretStore) {
    // serviceManagers is always available in production; we default to an
    // empty Map so test setups without compose can still mount the route.
    const serviceManagers: Map<string, ServiceManager> =
      deps.serviceManagers ?? new Map<string, ServiceManager>();
    await registerSecretsRoutes(app, {
      secretStore: deps.secretStore,
      sessionManager: deps.sessionManager,
      serviceManagers,
    });
  }
  await registerUpdateRoutes(app);

  // MCP server CRUD + connectivity test (docs/088-mcp-integration).
  await registerMcpRoutes(app, {
    credentialStore: deps.credentialStore,
    runnerRegistry: deps.runnerRegistry,
    serviceManagers: deps.serviceManagers ?? new Map<string, ServiceManager>(),
    ...(deps.mcpOAuthFetchImpl !== undefined
      ? { oauthFetchImpl: deps.mcpOAuthFetchImpl }
      : {}),
  });
}
