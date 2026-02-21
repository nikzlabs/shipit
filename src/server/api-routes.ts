/**
 * HTTP API routes — replaces request-response WebSocket messages with proper
 * REST endpoints. All routes are prefixed with /api.
 *
 * Phase 0: Bootstrap endpoint and infrastructure.
 * Phase 1: Individual GET endpoints for all Tier 1 reads.
 * Phase 2: POST/PATCH/DELETE endpoints for Tier 2 mutations.
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
import type { PreviewManager } from "./preview-manager.js";
import type { AuthManager } from "./auth.js";
import type { WsServerMessage } from "./types.js";
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
  // Phase 2: mutation service functions
  renameSession,
  archiveSession,
  gitRollback,
  rejectChanges,
  setGitRemote,
  gitPush,
  gitPull,
  createPullRequest,
  mergePullRequest,
  saveDeployConfig,
  deleteDeployConfig,
  createCheckpoint,
  setGitIdentity,
  saveGlobalSettings,
  setAgent,
  setAgentEnv,
  setApiKey,
  clearApiKey,
  setGitHubToken,
  gitHubLogout,
  applyTemplate,
  fullReset,
  validatePreviewError,
  ServiceError,
} from "./services/index.js";
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
  // Phase 2 additions
  previewManager: PreviewManager;
  authManager: AuthManager;
  broadcast: (msg: WsServerMessage) => void;
  broadcastLog: (source: "stderr" | "stdout" | "server" | "preview" | "deploy" | "install", text: string) => void;
  getSharedRepoDir: (repoUrl: string) => string;
  createSessionDir: (title: string) => Promise<{ appSessionId: string; sessionDir: string }>;
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

  // ===========================================================================
  // Phase 0+1: GET endpoints (reads)
  // ===========================================================================

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

  // ===========================================================================
  // Phase 2: POST/PATCH/DELETE endpoints (mutations)
  // ===========================================================================

  // ---- Session mutations ----

  // PATCH /api/sessions/:id — rename session
  app.patch<{ Params: { id: string }; Body: { title: string } }>(
    "/api/sessions/:id",
    async (request, reply) => {
      try {
        const session = renameSession(sessionManager, request.params.id, request.body.title);
        return { session };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to rename session: ${getErrorMessage(err)}` });
      }
    },
  );

  // DELETE /api/sessions/:id — archive session
  app.delete<{ Params: { id: string } }>(
    "/api/sessions/:id",
    async (request, reply) => {
      try {
        const result = await archiveSession(
          sessionManager,
          deps.runnerRegistry,
          createGitManager,
          deps.getSharedRepoDir,
          request.params.id,
        );
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to archive session: ${getErrorMessage(err)}` });
      }
    },
  );

  // ---- Git mutations ----

  // POST /api/sessions/:id/git/rollback — rollback to a commit
  app.post<{ Params: { id: string }; Body: { commitHash: string } }>(
    "/api/sessions/:id/git/rollback",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const git = createGitManager(dir);
        const result = await gitRollback(git, request.body.commitHash);
        deps.previewManager.restart(dir);
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Rollback failed: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/sessions/:id/git/reject — reject (revert) changes
  app.post<{ Params: { id: string }; Body: { fromCommit: string; files: string[] } }>(
    "/api/sessions/:id/git/reject",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const git = createGitManager(dir);
        const result = await rejectChanges(git, request.body.fromCommit, request.body.files ?? []);
        deps.previewManager.restart(dir);
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to reject changes: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/sessions/:id/git/remotes — add/update a remote
  app.post<{ Params: { id: string }; Body: { name: string; url: string } }>(
    "/api/sessions/:id/git/remotes",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const git = createGitManager(dir);
        return await setGitRemote(git, sessionManager, request.params.id, request.body.name, request.body.url);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to set remote: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/sessions/:id/git/push — git push
  app.post<{ Params: { id: string }; Body: { remote?: string; branch?: string } }>(
    "/api/sessions/:id/git/push",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const git = createGitManager(dir);
        return await gitPush(git, deps.githubAuthManager, request.body?.remote, request.body?.branch);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        return { success: false, message: `Push failed: ${getErrorMessage(err)}`, branch: "" };
      }
    },
  );

  // POST /api/sessions/:id/git/pull — git pull
  app.post<{ Params: { id: string }; Body: { remote?: string; branch?: string } }>(
    "/api/sessions/:id/git/pull",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const git = createGitManager(dir);
        return await gitPull(git, deps.githubAuthManager, request.body?.remote, request.body?.branch);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        return { success: false, message: `Pull failed: ${getErrorMessage(err)}` };
      }
    },
  );

  // ---- PR mutations ----

  // POST /api/sessions/:id/pr — create pull request
  app.post<{ Params: { id: string }; Body: { title: string; body: string; base: string; draft?: boolean } }>(
    "/api/sessions/:id/pr",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const git = createGitManager(dir);
        return await createPullRequest(
          git, deps.githubAuthManager,
          request.body.title, request.body.body, request.body.base, request.body.draft,
        );
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to create PR: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/sessions/:id/pr/merge — merge pull request
  app.post<{ Params: { id: string }; Body: { method?: string } }>(
    "/api/sessions/:id/pr/merge",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const git = createGitManager(dir);
        return await mergePullRequest(git, deps.githubAuthManager, request.body?.method);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        return { success: false, message: `Merge failed: ${getErrorMessage(err)}` };
      }
    },
  );

  // ---- Deploy mutations ----

  // POST /api/sessions/:id/deploy/config — save deploy configuration
  app.post<{ Params: { id: string }; Body: { targetId: string; credentials: Record<string, string>; projectName?: string } }>(
    "/api/sessions/:id/deploy/config",
    async (request, reply) => {
      try {
        return saveDeployConfig(
          deps.deploymentManager, deps.deploymentStore, request.params.id,
          request.body.targetId, request.body.credentials, request.body.projectName,
        );
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to save deploy config: ${getErrorMessage(err)}` });
      }
    },
  );

  // DELETE /api/sessions/:id/deploy/config/:targetId — delete deploy configuration
  app.delete<{ Params: { id: string; targetId: string } }>(
    "/api/sessions/:id/deploy/config/:targetId",
    async (request, reply) => {
      const session = sessionManager.get(request.params.id);
      if (!session) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      return deleteDeployConfig(deps.deploymentStore, request.params.id, request.params.targetId);
    },
  );

  // ---- Thread mutations ----

  // POST /api/sessions/:id/threads/checkpoint — create checkpoint
  app.post<{ Params: { id: string }; Body: { label?: string } }>(
    "/api/sessions/:id/threads/checkpoint",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const git = createGitManager(dir);
        return await createCheckpoint(
          git, deps.threadManager, deps.chatHistoryManager,
          request.params.id, request.body?.label,
        );
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to create checkpoint: ${getErrorMessage(err)}` });
      }
    },
  );

  // ---- Settings mutations ----

  // POST /api/settings/git-identity — set git identity (global)
  app.post<{ Body: { name: string; email: string } }>(
    "/api/settings/git-identity",
    async (request, reply) => {
      try {
        return setGitIdentity(deps.credentialStore, request.body.name, request.body.email);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to set git identity: ${getErrorMessage(err)}` });
      }
    },
  );

  // PUT /api/settings — save global settings
  app.put<{ Body: { gitIdentity?: { name: string; email: string }; systemPrompt?: string } }>(
    "/api/settings",
    async (request, reply) => {
      try {
        return await saveGlobalSettings(
          deps.credentialStore, deps.agentRegistry, deps.defaultAgentId, deps.workspaceDir,
          request.body.gitIdentity, request.body.systemPrompt,
        );
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to save settings: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/settings/agent — set active agent
  app.post<{ Body: { agentId: AgentId } }>(
    "/api/settings/agent",
    async (request, reply) => {
      try {
        return setAgent(deps.agentRegistry, request.body.agentId);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to set agent: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/agents/:id/env — set agent environment variable
  app.post<{ Params: { id: string }; Body: { key: string; value: string } }>(
    "/api/agents/:id/env",
    async (request, reply) => {
      try {
        const result = setAgentEnv(
          deps.agentRegistry, deps.credentialStore,
          request.params.id as AgentId, request.body.key, request.body.value,
        );
        return { agentId: result.agentId, key: result.key, success: true, agents: result.agents, defaultAgentId: deps.defaultAgentId };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to set agent env: ${getErrorMessage(err)}` });
      }
    },
  );

  // ---- Auth mutations ----

  // POST /api/auth/api-key — set API key
  app.post<{ Body: { key: string } }>(
    "/api/auth/api-key",
    async (request, reply) => {
      try {
        setApiKey(request.body.key);
        deps.authManager.kill();
        deps.authManager.checkCredentials();
        deps.broadcast({ type: "auth_complete" });
        return { success: true };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to set API key: ${getErrorMessage(err)}` });
      }
    },
  );

  // DELETE /api/auth/api-key — clear API key
  app.delete(
    "/api/auth/api-key",
    async () => {
      clearApiKey();
      const stillAuthenticated = deps.authManager.checkCredentials();
      if (!stillAuthenticated) {
        deps.authManager.startOAuthFlow();
      }
      return { success: true, stillAuthenticated };
    },
  );

  // ---- GitHub auth mutations ----

  // POST /api/github/token — set GitHub token
  app.post<{ Body: { token: string } }>(
    "/api/github/token",
    async (request, reply) => {
      try {
        const result = await setGitHubToken(deps.githubAuthManager, request.body.token);
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to set GitHub token: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/github/logout — logout from GitHub
  app.post(
    "/api/github/logout",
    async () => {
      return gitHubLogout(deps.githubAuthManager);
    },
  );

  // ---- Template mutations ----

  // POST /api/sessions/:id/template — apply a template
  app.post<{ Params: { id: string }; Body: { templateId: string } }>(
    "/api/sessions/:id/template",
    async (request, reply) => {
      try {
        const result = await applyTemplate(
          sessionManager, createGitManager, deps.createSessionDir,
          request.body.templateId, request.params.id === "new" ? undefined : request.params.id,
        );
        deps.previewManager.restart(result.sessionDir);
        return { templateId: result.templateId, name: result.name, session: result.session };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to apply template: ${getErrorMessage(err)}` });
      }
    },
  );

  // ---- Misc mutations ----

  // POST /api/reset — full reset
  app.post(
    "/api/reset",
    async (_request, reply) => {
      try {
        deps.previewManager.stop();
        await fullReset(sessionManager, deps.usageManager, deps.runnerRegistry, deps.workspaceDir);
        deps.broadcast({ type: "full_reset_complete" });
        return { success: true };
      } catch (err) {
        reply.code(500).send({ error: `Full reset failed: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/sessions/:id/preview-errors — report preview error
  app.post<{ Params: { id: string }; Body: { message: string; stack?: string } }>(
    "/api/sessions/:id/preview-errors",
    async (request, reply) => {
      try {
        const validated = validatePreviewError(request.body.message, request.body.stack);
        const parts = [validated.message];
        if (validated.stack) parts.push(validated.stack);
        deps.broadcastLog("preview", parts.join("\n"));
        reply.code(204).send();
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to report preview error: ${getErrorMessage(err)}` });
      }
    },
  );
}
