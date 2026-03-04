/**
 * HTTP API routes — replaces request-response WebSocket messages with proper
 * REST endpoints. All routes are prefixed with /api.
 *
 * Phase 0: Bootstrap endpoint and infrastructure.
 * Phase 1: Individual GET endpoints for all Tier 1 reads.
 * Phase 2: POST/PATCH/DELETE endpoints for Tier 2 mutations.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { SessionManager } from "./sessions.js";
import type { RepoStore } from "./repo-store.js";
import type { GitManager } from "../shared/git.js";
import type { RepoGit } from "./repo-git.js";
import type { GitHubAuthManager } from "./github-auth.js";
import type { CredentialStore } from "./credential-store.js";
import type { AgentRegistry } from "../shared/agent-registry.js";
import type { AgentId } from "../shared/types.js";
import type { ThreadManager } from "./threads.js";
import type { DeploymentManager } from "./deployment-manager.js";
import type { DeploymentStore } from "./deployment-store.js";
import type { UsageManager } from "./usage.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { ChatHistoryManager } from "./chat-history.js";
import type { AuthManager } from "./auth.js";
import type { PrStatusPoller } from "./pr-status-poller.js";

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
  setGitRemote,
  gitPush,
  gitPull,
  createPullRequest,
  quickCreatePr,
  mergePullRequest,
  saveDeployConfig,
  deleteDeployConfig,
  createCheckpoint,
  setGitIdentityService,
  saveGlobalSettings,
  setAgent,
  setAgentEnv,
  setApiKey,
  clearApiKey,
  setUtilityModel,
  clearUtilityModel,
  setGitHubToken,
  gitHubLogout,
  applyTemplate,
  fullReset,
  validatePreviewError,
  // Phase 3: borderline cases
  generatePrDescription,
  forkSession,
  mergeSession,
  startAuth,
  submitAuthCode,
  createRepoWithTemplate,
  listRepos,
  addRepo,
  removeRepo,
  triggerCIFix,
  ServiceError,
} from "./services/index.js";
import { getErrorMessage } from "./validation.js";

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
  threadManager: ThreadManager;
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
  /** Create session dir with custom options. */
  createSessionDirFull: (title: string, opts?: { skipGitInit?: boolean }) => Promise<{ appSessionId: string; sessionDir: string }>;
  /** Container manager — needed for standby cleanup on repo delete. */
  containerManager?: import("./session-container.js").SessionContainerManager;
  /** PR status poller — needed for tracking new PRs. */
  prStatusPoller?: PrStatusPoller;
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
  const { sessionManager, createGitManager, createRepoGit } = deps;

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

  // GET /api/sessions/:id/preview-status — current preview state
  app.get<{ Params: { id: string } }>("/api/sessions/:id/preview-status", async (request, reply) => {
    const session = sessionManager.get(request.params.id);
    if (!session) {
      reply.code(404).send({ error: "Session not found" });
      return;
    }
    const runner = deps.runnerRegistry.get(request.params.id);
    if (!runner?.previewStatusKnown) {
      return { known: false };
    }
    const status = runner.buildPreviewStatus();
    return { known: true, ...status };
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

  // GET /api/sessions/:id/history — read-only chat history + workspace data (no session activation)
  app.get<{ Params: { id: string } }>("/api/sessions/:id/history", async (request, reply) => {
    const session = sessionManager.get(request.params.id);
    if (!session) {
      reply.code(404).send({ error: "Session not found" });
      return;
    }
    const messages = getChatHistory(deps.chatHistoryManager, request.params.id);
    const { threads, activeThreadId } = listThreads(deps.threadManager, request.params.id);

    // Also return git log and file tree for the session workspace (if it exists)
    let commits: Awaited<ReturnType<typeof getGitLog>> = [];
    let fileTree: Awaited<ReturnType<typeof getFileTree>> = [];
    if (session.workspaceDir) {
      try {
        const git = createGitManager(session.workspaceDir);
        commits = await getGitLog(git);
      } catch {
        // No git repo — empty log
      }
      try {
        fileTree = await getFileTree(session.workspaceDir);
      } catch {
        // No workspace dir — empty tree
      }
    }

    return { messages, commits, fileTree, threads, activeThreadId };
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

  // GET /api/sessions/:id/features — feature list (session-scoped)
  app.get<{ Params: { id: string } }>("/api/sessions/:id/features", async (request, reply) => {
    const dir = resolveSessionDir(sessionManager, request.params.id, reply);
    if (!dir) return;
    return { features: await listFeatures(dir) };
  });

  // ---- Global reads (no session context needed) ----

  // GET /api/github/repos — search GitHub repos
  app.get<{ Querystring: { q?: string } }>("/api/github/repos", async (request) => {
    const query = request.query.q ?? "";
    return { repos: await searchGitHubRepos(deps.githubAuthManager, query) };
  });

  // ===========================================================================
  // Phase 2: POST/PATCH/DELETE endpoints (mutations)
  // ===========================================================================

  // ---- Session mutations ----

  // POST /api/sessions — create a new standalone session (no repo)
  app.post<{ Body: { title?: string } }>(
    "/api/sessions",
    async (_request, reply) => {
      try {
        const title = _request.body?.title?.trim() || "New session";
        const { appSessionId, sessionDir } = await deps.createSessionDir(title);
        deps.sseBroadcast("session_list", { sessions: sessionManager.list() });
        return { sessionId: appSessionId, sessionDir };
      } catch (err) {
        reply.code(500).send({ error: `Failed to create session: ${getErrorMessage(err)}` });
      }
    },
  );

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
          createRepoGit,
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

  // POST /api/sessions/:id/pr/quick — one-click PR creation
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/pr/quick",
    async (request, reply) => {
      const session = sessionManager.get(request.params.id);
      if (!session) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const git = createGitManager(dir);
        const result = await quickCreatePr(
          git,
          deps.githubAuthManager,
          deps.chatHistoryManager,
          deps.generateText,
          request.params.id,
          session.title,
          dir,
        );

        // Track the new PR in the poller
        if (deps.prStatusPoller && session.remoteUrl) {
          deps.prStatusPoller.trackSession(request.params.id, session.remoteUrl);
        }

        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to create PR: ${getErrorMessage(err)}` });
      }
    },
  );

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

  // POST /api/sessions/:id/pr/fix-ci — manually trigger CI fix
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/pr/fix-ci",
    async (request, reply) => {
      try {
        if (!deps.prStatusPoller) {
          reply.code(500).send({ error: "PR status poller not available" });
          return;
        }
        return await triggerCIFix(
          deps.githubAuthManager,
          deps.prStatusPoller,
          deps.runnerRegistry,
          request.params.id,
        );
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Fix CI failed: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/sessions/:id/pr/auto-fix — toggle auto-fix on/off
  app.post<{ Params: { id: string }; Body: { enabled: boolean } }>(
    "/api/sessions/:id/pr/auto-fix",
    async (request, reply) => {
      try {
        if (!deps.prStatusPoller) {
          reply.code(500).send({ error: "PR status poller not available" });
          return;
        }
        if (typeof request.body?.enabled !== "boolean") {
          reply.code(400).send({ error: "\"enabled\" field is required (boolean)" });
          return;
        }

        const state = deps.prStatusPoller.setAutoFixEnabled(
          request.params.id,
          request.body.enabled,
        );

        // If enabling and CI is currently failed, trigger a fix immediately
        if (request.body.enabled) {
          const prStatus = deps.prStatusPoller.getStatus(request.params.id);
          if (prStatus?.checks.state === "failure") {
            try {
              await triggerCIFix(
                deps.githubAuthManager,
                deps.prStatusPoller,
                deps.runnerRegistry,
                request.params.id,
              );
            } catch {
              // Non-fatal — the toggle still worked, fix just didn't trigger
            }
          }
        }

        return {
          enabled: state.enabled,
          attemptCount: state.attemptCount,
          status: state.status,
        };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Auto-fix toggle failed: ${getErrorMessage(err)}` });
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
        return setGitIdentityService(request.body.name, request.body.email);
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
  app.put<{ Body: { gitIdentity?: { name: string; email: string }; systemPrompt?: string; maxIdleContainers?: number } }>(
    "/api/settings",
    async (request, reply) => {
      try {
        return await saveGlobalSettings(
          deps.agentRegistry, deps.defaultAgentId, deps.workspaceDir, deps.credentialStore,
          request.body.gitIdentity, request.body.systemPrompt, request.body.maxIdleContainers,
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

  // ---- Utility model ----

  // GET /api/settings/utility-model — get utility model config (without API key)
  app.get("/api/settings/utility-model", async () => {
    const config = deps.credentialStore.getUtilityModel();
    if (!config) return { configured: false };
    return { configured: true, provider: config.provider, model: config.model, baseUrl: config.baseUrl };
  });

  // PUT /api/settings/utility-model — set utility model config
  app.put<{ Body: { provider: string; apiKey: string; model: string; baseUrl?: string } }>(
    "/api/settings/utility-model",
    async (request, reply) => {
      try {
        const result = setUtilityModel(
          deps.credentialStore,
          request.body.provider, request.body.apiKey, request.body.model, request.body.baseUrl,
        );
        return { configured: true, ...result };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to set utility model: ${getErrorMessage(err)}` });
      }
    },
  );

  // DELETE /api/settings/utility-model — clear utility model config
  app.delete("/api/settings/utility-model", async () => {
    clearUtilityModel(deps.credentialStore);
    return { configured: false };
  });

  // ---- Auth mutations ----

  // POST /api/auth/api-key — set API key
  app.post<{ Body: { key: string } }>(
    "/api/auth/api-key",
    async (request, reply) => {
      try {
        setApiKey(request.body.key);
        deps.authManager.kill();
        deps.authManager.checkCredentials();
        deps.sseBroadcast("auth_complete", {});
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
        await fullReset(sessionManager, deps.usageManager, deps.runnerRegistry, deps.workspaceDir, deps.repoStore);
        deps.sseBroadcast("full_reset_complete", {});
        return { success: true };
      } catch (err) {
        reply.code(500).send({ error: `Full reset failed: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/sessions/:id/preview/restart — restart the preview server
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/preview/restart",
    async (request, reply) => {
      const runner = deps.runnerRegistry.get(request.params.id);
      if (!runner) {
        return reply.code(404).send({ error: "Session not found or no active runner" });
      }
      if (!runner.supportsRemoteTerminal) {
        return reply.code(400).send({ error: "Preview restart only supported for container sessions" });
      }
      try {
        const containerRunner = runner as import("./container-session-runner.js").ContainerSessionRunner;
        await containerRunner.restartPreviewOnWorker();
        return { restarted: true };
      } catch (err) {
        reply.code(500).send({ error: `Failed to restart preview: ${getErrorMessage(err)}` });
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
        const text = parts.join("\n");
        deps.broadcastLog("preview", text);
        // Also emit to the session's runner so connected WS viewers receive it
        const runner = deps.runnerRegistry.get(request.params.id);
        if (runner) {
          runner.emitMessage({ type: "log_entry", source: "preview", text, timestamp: new Date().toISOString() });
        }
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

  // ===========================================================================
  // Phase 3: Borderline cases — endpoints migrated from WS
  // ===========================================================================

  // POST /api/sessions/:id/pr/description — generate PR description via LLM
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/pr/description",
    { config: { rawBody: false } },
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const git = createGitManager(dir);
        return await generatePrDescription(git, deps.generateText, dir);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to generate description: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/sessions/:id/fork — fork session into a new worktree branch
  app.post<{ Params: { id: string }; Body: { branchName: string; startPoint?: string } }>(
    "/api/sessions/:id/fork",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const result = await forkSession(
          sessionManager, createRepoGit, deps.getSharedRepoDir, deps.sessionsRoot,
          deps.githubAuthManager, deps.threadManager,
          request.params.id, dir,
          request.body.branchName, request.body.startPoint,
        );
        // Broadcast updated session list via SSE
        deps.sseBroadcast("session_list", { sessions: result.sessions });
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to fork session: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/sessions/:id/git/merge — merge a worktree branch into this session
  app.post<{ Params: { id: string }; Body: { sourceSessionId: string } }>(
    "/api/sessions/:id/git/merge",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        return await mergeSession(
          sessionManager, createGitManager, dir, request.body.sourceSessionId,
        );
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to merge: ${getErrorMessage(err)}` });
      }
    },
  );

  // ===========================================================================
  // Repo management endpoints
  // ===========================================================================

  // GET /api/repos — list all added repos
  app.get("/api/repos", async () => {
    return { repos: listRepos(deps.repoStore) };
  });

  // POST /api/repos — add a repo (existing) or create a new GitHub repo with template
  app.post<{ Body: { url?: string; repoName?: string; templateId?: string; description?: string; isPrivate?: boolean } }>(
    "/api/repos",
    async (_request, reply) => {
      const body = _request.body;

      // If "url" is provided, this is an "add existing repo" flow
      if (body.url) {
        try {
          const repo = addRepo(deps.repoStore, body.url);
          // If already ready, no need to clone
          if (repo.status === "ready") {
            return { repo };
          }
          // Clone in background
          const repoUrl = repo.url;
          const repoDir = deps.getSharedRepoDir(repoUrl);
          // eslint-disable-next-line no-restricted-syntax -- fire-and-forget background clone
          import("node:fs/promises").then(async (fsModule) => {
            try {
              // eslint-disable-next-line no-restricted-syntax -- stat existence-check idiom
              const exists = await fsModule.stat(repoDir).then(() => true, () => false);
              if (!exists) {
                await fsModule.mkdir(repoDir, { recursive: true });
                const cloneUrl = deps.githubAuthManager.getAuthenticatedCloneUrl(repoUrl);
                const repoGit = createRepoGit(repoDir);
                await repoGit.clone(cloneUrl);
                console.log("[repos] Cloned repo to shared dir:", repoDir);
              }
              deps.repoStore.setReady(repoUrl);
              deps.sseBroadcast("repo_status", { url: repoUrl, status: "ready" });
              // Start warming a session
              deps.warmSessionForRepo?.(repoUrl);
            } catch (err) {
              console.error("[repos] Background clone failed:", getErrorMessage(err));
              deps.sseBroadcast("error", { message: `Failed to clone repository: ${getErrorMessage(err)}` });
            }
          });
          return { repo };
        } catch (err) {
          if (err instanceof ServiceError) {
            reply.code(err.statusCode).send({ error: err.message });
            return;
          }
          reply.code(500).send({ error: `Failed to add repo: ${getErrorMessage(err)}` });
          return;
        }
      }

      // Otherwise it's a "create new repo with template" flow
      if (!body.repoName || !body.templateId) {
        reply.code(400).send({ error: "Either 'url' or both 'repoName' and 'templateId' are required" });
        return;
      }
      try {
        const result = await createRepoWithTemplate(
          sessionManager, createGitManager, createRepoGit, deps.createSessionDir,
          deps.githubAuthManager, deps.getSharedRepoDir,
          body.repoName, body.templateId,
          body.description, body.isPrivate,
        );
        if (!result.success) {
          reply.code(400).send(result);
          return;
        }
        // Also track in RepoStore
        if (result.repoUrl) {
          deps.repoStore.add(result.repoUrl);
          deps.repoStore.setReady(result.repoUrl);
          deps.sseBroadcast("repo_list", { repos: listRepos(deps.repoStore) });
        }
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to create repo: ${getErrorMessage(err)}` });
      }
    },
  );

  // DELETE /api/repos/:url — remove a repo
  app.delete<{ Params: { url: string } }>(
    "/api/repos/:url",
    async (request, reply) => {
      try {
        const url = decodeURIComponent(request.params.url);
        // If there's a warm session, destroy its standby container + dispose runner
        const repo = deps.repoStore.get(url);
        if (repo?.warmSessionId) {
          if (deps.containerManager?.isStandby(repo.warmSessionId)) {
            await deps.containerManager.destroy(repo.warmSessionId);
          }
          const runner = deps.runnerRegistry.get(repo.warmSessionId);
          if (runner) runner.dispose();
          sessionManager.delete(repo.warmSessionId);
        }
        removeRepo(deps.repoStore, url);
        deps.sseBroadcast("repo_list", { repos: listRepos(deps.repoStore) });
        return { success: true };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to remove repo: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/repos/:url/claim-session — claim the warm session for a repo
  app.post<{ Params: { url: string } }>(
    "/api/repos/:url/claim-session",
    async (request, reply) => {
      try {
        const url = decodeURIComponent(request.params.url);
        const repo = deps.repoStore.get(url);
        if (!repo) {
          reply.code(404).send({ error: "Repository not found" });
          return;
        }
        if (repo.status !== "ready") {
          reply.code(400).send({ error: "Repository is still cloning" });
          return;
        }

        // Reuse path: if a previously-claimed warm session for this repo exists
        // (user clicked "New Session", navigated away without sending a message,
        // then clicked "New Session" again), return it instead of claiming a new one.
        // This avoids creating duplicate containers for sessions the user never used.
        // We check for .git (file for worktrees, dir for standalone repos) to ensure
        // the worktree/repo is fully initialized — the session directory is created
        // early (mkdir) but the git worktree is created later, so an in-progress
        // warm session would have the dir but no .git yet.
        const reusable = sessionManager.findUngraduatedWarm(url, repo.warmSessionId ?? undefined);
        if (reusable?.workspaceDir && existsSync(path.join(reusable.workspaceDir, ".git"))) {
          return { sessionId: reusable.id, sessionDir: reusable.workspaceDir };
        }

        // Warm path: claim the pre-warmed session (worktree + metadata only).
        // No container is created here — it will be created on-demand when
        // the WebSocket connects and activateSession() calls getOrCreate().
        if (repo.warmSessionId) {
          const warmSession = sessionManager.get(repo.warmSessionId);
          if (warmSession?.workspaceDir) {
            const sessionId = repo.warmSessionId;
            deps.repoStore.setWarmSessionId(url, undefined);
            // Start warming the next session in background (with standby container)
            deps.warmSessionForRepo?.(url, { withStandby: true });
            return { sessionId, sessionDir: warmSession.workspaceDir };
          }
        }

        // If warming is in progress, wait for it instead of creating from scratch.
        // This prevents cascade: rapid "New Session" clicks each falling to the
        // slow path while the replacement warm session is still being created.
        const warmingPromise = deps.waitForWarmSession?.(url);
        if (warmingPromise) {
          await warmingPromise;
          // Re-check — the warm session should now be available
          const freshRepo = deps.repoStore.get(url);
          if (freshRepo?.warmSessionId) {
            const warmSession = sessionManager.get(freshRepo.warmSessionId);
            if (warmSession?.workspaceDir) {
              const sessionId = freshRepo.warmSessionId;
              deps.repoStore.setWarmSessionId(url, undefined);
              deps.warmSessionForRepo?.(url, { withStandby: true });
              return { sessionId, sessionDir: warmSession.workspaceDir };
            }
          }
        }

        // No warm session available — create one synchronously.
        // If the client already disconnected (rapid navigation), skip the expensive work.
        if (request.raw.destroyed) return;
        const repoDir = deps.getSharedRepoDir(url);
        const { generateBranchPrefix } = await import("./git-utils.js");
        const branchPrefix = generateBranchPrefix();
        const created = await deps.createSessionDirFull("Warm session", { skipGitInit: true });
        const { appSessionId, sessionDir } = created;

        // Remove the empty dir (worktree add needs it absent)
        const fsModule = await import("node:fs/promises");
        await fsModule.rm(sessionDir, { recursive: true, force: true });

        const repoGit = createRepoGit(repoDir);
        const isEmptyRepo = await repoGit.isEmpty();

        if (isEmptyRepo) {
          await fsModule.mkdir(sessionDir, { recursive: true });
          const sessionGit = createGitManager(sessionDir);
          await sessionGit.init();
          const cloneUrl = deps.githubAuthManager.getAuthenticatedCloneUrl(url);
          await sessionGit.addRemote("origin", cloneUrl);
          await sessionGit.checkoutNewBranch(branchPrefix);
        } else {
          let startPoint: string | undefined;
          try {
            const defaultBranch = await repoGit.getDefaultBranch();
            if (defaultBranch && !defaultBranch.includes("(")) {
              startPoint = `origin/${defaultBranch}`;
            }
          } catch {
            // Fallback: let git use HEAD
          }
          await repoGit.createWorktree(sessionDir, branchPrefix, startPoint);
        }

        // Configure credentials
        if (deps.githubAuthManager.authenticated) {
          deps.githubAuthManager.configureGitCredentials(sessionDir);
        }

        sessionManager.setRemoteUrl(appSessionId, url);
        sessionManager.setWorktreeInfo(appSessionId, {
          branch: branchPrefix,
          sessionType: isEmptyRepo ? "standalone" : "worktree",
        });
        sessionManager.setWarm(appSessionId, true);

        // No container is created here — it will be created on-demand when
        // the WebSocket connects and activateSession() calls getOrCreate().

        // Start warming the next session in background
        deps.warmSessionForRepo?.(url);

        return { sessionId: appSessionId, sessionDir };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to claim session: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/auth/start — initiate OAuth flow
  app.post(
    "/api/auth/start",
    async (_request, reply) => {
      try {
        startAuth(deps.authManager);
        reply.code(202).send({ success: true });
      } catch (err) {
        console.error("[auth] startAuth() threw:", err);
        reply.code(500).send({ error: `Failed to start auth: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/auth/code — submit OAuth authorization code
  app.post<{ Body: { code: string } }>(
    "/api/auth/code",
    async (request, reply) => {
      try {
        submitAuthCode(deps.authManager, request.body.code);
        return { success: true };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to submit auth code: ${getErrorMessage(err)}` });
      }
    },
  );
}
