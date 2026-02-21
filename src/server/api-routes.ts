/**
 * HTTP API routes — replaces request-response WebSocket messages with proper
 * REST endpoints. All routes are prefixed with /api.
 *
 * Phase 0: Bootstrap endpoint and infrastructure.
 * Phase 1: Individual GET endpoints for all Tier 1 reads.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { SessionManager } from "./sessions.js";
import type { GitManager } from "./git.js";
import type { GitHubAuthManager } from "./github-auth.js";
import type { CredentialStore } from "./credential-store.js";
import type { AgentRegistry } from "./agents/agent-registry.js";
import type { AgentId } from "./agents/agent-process.js";
import type { ThreadManager } from "./threads.js";
import type { DeploymentManager } from "./deployment-manager.js";
import type { DeploymentStore } from "./deployment-store.js";
import type { FeatureManager } from "./features.js";
import type { UsageManager } from "./usage.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { ChatHistoryManager } from "./chat-history.js";
import {
  getBootstrapData,
  getFileTree,
  getFileContent,
  listDocs,
  getDocContent,
  getGitLog,
  getGitRemotes,
  getGitBranches,
  getTurnDiff,
  getSessionStatus,
  getDeployHistory,
  getDeploySetup,
  getUsageStats,
  getPrStatus,
  listThreads,
  listWorktrees,
  listFeatures,
  searchGitHubRepos,
  getWorkspaceState,
  getChatHistory,
  ServiceError,
} from "./services.js";
import { getErrorMessage } from "./validation.js";

/**
 * Dependencies needed by API routes. A subset of AppDeps — only the
 * app-level managers, no per-connection state.
 */
export interface ApiDeps {
  sessionManager: SessionManager;
  createGitManager: (dir: string) => GitManager;
  agentRegistry: AgentRegistry;
  githubAuthManager: GitHubAuthManager;
  credentialStore: CredentialStore;
  defaultAgentId: AgentId;
  workspaceDir: string;
  threadManager: ThreadManager;
  deploymentManager: DeploymentManager;
  deploymentStore: DeploymentStore;
  featureManager: FeatureManager;
  usageManager: UsageManager;
  runnerRegistry: SessionRunnerRegistry;
  chatHistoryManager: ChatHistoryManager;
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
  const { sessionManager, createGitManager } = deps;

  // ---- Error handler for ServiceError ----
  app.addHook("onError", (_request: FastifyRequest, reply: FastifyReply, error: Error, done: () => void) => {
    if (error instanceof ServiceError) {
      reply.code(error.statusCode).send({ error: error.message });
    }
    done();
  });

  // ---- GET /api/bootstrap ----
  app.get("/api/bootstrap", async () => {
    return getBootstrapData(deps);
  });

  // ---- Session-scoped reads ----

  // GET /api/sessions/:id/files — file tree
  app.get<{ Params: { id: string } }>("/api/sessions/:id/files", async (request, reply) => {
    const dir = resolveSessionDir(sessionManager, request.params.id, reply);
    if (!dir) return;
    return { tree: await getFileTree(dir) };
  });

  // GET /api/sessions/:id/files/* — file content
  app.get<{ Params: { id: string; "*": string }; Querystring: { tree?: string } }>(
    "/api/sessions/:id/files/*",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      const filePath = request.params["*"];
      if (!filePath) {
        reply.code(400).send({ error: "File path is required" });
        return;
      }
      try {
        const result = await getFileContent(dir, filePath);
        const response: Record<string, unknown> = {
          path: filePath,
          content: result.content,
          isBinary: result.isBinary,
        };
        if (request.query.tree === "true") {
          response.tree = await getFileTree(dir);
        }
        return response;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(404).send({ error: `File not found: ${getErrorMessage(err)}` });
      }
    },
  );

  // GET /api/sessions/:id/docs — doc list
  app.get<{ Params: { id: string } }>("/api/sessions/:id/docs", async (request, reply) => {
    const dir = resolveSessionDir(sessionManager, request.params.id, reply);
    if (!dir) return;
    return { files: await listDocs(dir) };
  });

  // GET /api/sessions/:id/docs/* — doc content
  app.get<{ Params: { id: string; "*": string } }>(
    "/api/sessions/:id/docs/*",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      const docPath = request.params["*"];
      if (!docPath) {
        reply.code(400).send({ error: "Doc path is required" });
        return;
      }
      try {
        const content = await getDocContent(dir, docPath);
        return { path: docPath, content };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(404).send({ error: `Doc not found: ${getErrorMessage(err)}` });
      }
    },
  );

  // GET /api/sessions/:id/git/log — git commit log
  app.get<{ Params: { id: string } }>("/api/sessions/:id/git/log", async (request, reply) => {
    const dir = resolveSessionDir(sessionManager, request.params.id, reply);
    if (!dir) return;
    try {
      const git = createGitManager(dir);
      return { commits: await getGitLog(git) };
    } catch (err) {
      reply.code(500).send({ error: `Failed to get git log: ${getErrorMessage(err)}` });
    }
  });

  // GET /api/sessions/:id/git/diff — turn diff between two commits
  app.get<{ Params: { id: string }; Querystring: { from: string; to: string } }>(
    "/api/sessions/:id/git/diff",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      const { from, to } = request.query;
      if (!from || !to) {
        reply.code(400).send({ error: "Query params 'from' and 'to' are required" });
        return;
      }
      try {
        const git = createGitManager(dir);
        return await getTurnDiff(git, from, to);
      } catch (err) {
        reply.code(500).send({ error: `Failed to get diff: ${getErrorMessage(err)}` });
      }
    },
  );

  // GET /api/sessions/:id/git/remotes — git remotes
  app.get<{ Params: { id: string } }>("/api/sessions/:id/git/remotes", async (request, reply) => {
    const dir = resolveSessionDir(sessionManager, request.params.id, reply);
    if (!dir) return;
    try {
      const git = createGitManager(dir);
      return { remotes: await getGitRemotes(git) };
    } catch (err) {
      reply.code(500).send({ error: `Failed to get remotes: ${getErrorMessage(err)}` });
    }
  });

  // GET /api/sessions/:id/git/branches — git branches
  app.get<{ Params: { id: string } }>("/api/sessions/:id/git/branches", async (request, reply) => {
    const dir = resolveSessionDir(sessionManager, request.params.id, reply);
    if (!dir) return;
    try {
      const git = createGitManager(dir);
      return await getGitBranches(git);
    } catch (err) {
      reply.code(500).send({ error: `Failed to get branches: ${getErrorMessage(err)}` });
    }
  });

  // GET /api/sessions/:id/status — session runtime status
  app.get<{ Params: { id: string } }>("/api/sessions/:id/status", async (request, reply) => {
    const session = sessionManager.get(request.params.id);
    if (!session) {
      reply.code(404).send({ error: "Session not found" });
      return;
    }
    return {
      sessionId: request.params.id,
      ...getSessionStatus(deps.runnerRegistry, request.params.id),
    };
  });

  // GET /api/sessions/:id/deploy/history — deployment history
  app.get<{ Params: { id: string } }>("/api/sessions/:id/deploy/history", async (request, reply) => {
    const session = sessionManager.get(request.params.id);
    if (!session) {
      reply.code(404).send({ error: "Session not found" });
      return;
    }
    return { deployments: getDeployHistory(deps.deploymentStore, request.params.id) };
  });

  // GET /api/sessions/:id/deploy/setup — deploy targets + project settings (combined)
  app.get<{ Params: { id: string } }>("/api/sessions/:id/deploy/setup", async (request, reply) => {
    const session = sessionManager.get(request.params.id);
    if (!session) {
      reply.code(404).send({ error: "Session not found" });
      return;
    }
    return getDeploySetup(deps.deploymentManager, deps.deploymentStore, request.params.id);
  });

  // GET /api/sessions/:id/workspace-state — git log + file tree (combined)
  app.get<{ Params: { id: string } }>("/api/sessions/:id/workspace-state", async (request, reply) => {
    const dir = resolveSessionDir(sessionManager, request.params.id, reply);
    if (!dir) return;
    try {
      const git = createGitManager(dir);
      return await getWorkspaceState(git, dir);
    } catch (err) {
      reply.code(500).send({ error: `Failed to get workspace state: ${getErrorMessage(err)}` });
    }
  });

  // GET /api/sessions/:id/history — read-only chat history (no session activation)
  app.get<{ Params: { id: string } }>("/api/sessions/:id/history", async (request, reply) => {
    const session = sessionManager.get(request.params.id);
    if (!session) {
      reply.code(404).send({ error: "Session not found" });
      return;
    }
    return { messages: getChatHistory(deps.chatHistoryManager, request.params.id) };
  });

  // GET /api/sessions/:id/usage — usage stats
  app.get<{ Params: { id: string } }>("/api/sessions/:id/usage", async (request, reply) => {
    const session = sessionManager.get(request.params.id);
    if (!session) {
      reply.code(404).send({ error: "Session not found" });
      return;
    }
    return { stats: getUsageStats(deps.usageManager) };
  });

  // GET /api/sessions/:id/pr/status — PR status
  app.get<{ Params: { id: string } }>("/api/sessions/:id/pr/status", async (request, reply) => {
    const dir = resolveSessionDir(sessionManager, request.params.id, reply);
    if (!dir) return;
    try {
      const git = createGitManager(dir);
      return { pr: await getPrStatus(deps.githubAuthManager, git) };
    } catch (err) {
      reply.code(500).send({ error: `Failed to get PR status: ${getErrorMessage(err)}` });
    }
  });

  // GET /api/sessions/:id/threads — thread list
  app.get<{ Params: { id: string } }>("/api/sessions/:id/threads", async (request, reply) => {
    const session = sessionManager.get(request.params.id);
    if (!session) {
      reply.code(404).send({ error: "Session not found" });
      return;
    }
    return listThreads(deps.threadManager, request.params.id);
  });

  // GET /api/sessions/:id/worktrees — sibling worktrees
  app.get<{ Params: { id: string } }>("/api/sessions/:id/worktrees", async (request, reply) => {
    const session = sessionManager.get(request.params.id);
    if (!session) {
      reply.code(404).send({ error: "Session not found" });
      return;
    }
    return { worktrees: listWorktrees(sessionManager, request.params.id) };
  });

  // ---- Global reads (no session context needed) ----

  // GET /api/features — feature list
  app.get("/api/features", async () => {
    return { features: await listFeatures(deps.featureManager) };
  });

  // GET /api/github/repos — search GitHub repos
  app.get<{ Querystring: { q?: string } }>("/api/github/repos", async (request) => {
    const query = request.query.q ?? "";
    return { repos: await searchGitHubRepos(deps.githubAuthManager, query) };
  });
}
