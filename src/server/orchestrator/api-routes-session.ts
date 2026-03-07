/**
 * Session management API routes.
 * Handles: session CRUD, switching, renaming, status, history, usage,
 * worktrees, features, fork, template, repos, claim-session.
 */

import { existsSync, unlinkSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import { resolveSessionDir } from "./api-routes.js";

import {
  getFileTree,
  getGitLog,
  getSessionStatus,
  getUsageStats,
  listWorktrees,
  listFeatures,
  getChatHistory,
  listAllSessions,
  unarchiveSession,
  renameSession,
  archiveSession,
  deleteSession,
  applyTemplate,
  forkSession,
  listRepos,
  addRepo,
  removeRepo,
  createRepoWithTemplate,
  ServiceError,
} from "./services/index.js";
import { getErrorMessage } from "./validation.js";
import { generateBranchPrefix } from "./git-utils.js";

/**
 * Fetch latest origin refs and hard-reset a warm worktree to the current
 * remote HEAD. Safe because warm sessions have zero user changes.
 * Non-fatal — if fetch or reset fails, the session still works with older code.
 */
async function refreshWorktreeToLatestMain(
  repoDir: string,
  sessionDir: string,
  createRepoGit: ApiDeps["createRepoGit"],
  createGitManager: ApiDeps["createGitManager"],
): Promise<{ headChanged: boolean; fetchDurationMs: number }> {
  const t0 = Date.now();
  const repoGit = createRepoGit(repoDir);
  const defaultBranch = await repoGit.getDefaultBranch();
  await repoGit.fetch("origin", defaultBranch);
  const sessionGit = createGitManager(sessionDir);
  const headBefore = await sessionGit.getHeadHash();
  await sessionGit.rollback(`origin/${defaultBranch}`);
  const headAfter = await sessionGit.getHeadHash();
  const headChanged = headBefore !== headAfter;
  if (headChanged) {
    // Clear the install-done marker so the preview manager re-runs install.
    // Inlined here because orchestrator cannot import from session/.
    try { unlinkSync(path.join(sessionDir, ".shipit", ".install-done")); } catch { /* marker may not exist */ }
  }
  return { headChanged, fetchDurationMs: Date.now() - t0 };
}

export async function registerSessionRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  const { sessionManager, createGitManager, createRepoGit } = deps;

  // Per-repo promise chain: serializes claim-session requests for the same repo
  // so git operations (fetch, reset, worktree add) never run concurrently on
  // the same shared repo.  No mutex library — just a simple chain of promises.
  const claimChains = new Map<string, Promise<unknown>>();
  async function serializeClaim<T>(repoUrl: string, fn: () => Promise<T>): Promise<T> {
    const prev = claimChains.get(repoUrl) ?? Promise.resolve();
    // eslint-disable-next-line no-restricted-syntax -- intentional two-arg .then for promise chaining
    const next = prev.then(fn, fn);
    claimChains.set(repoUrl, next);
    try {
      return await next;
    } finally {
      if (claimChains.get(repoUrl) === next) claimChains.delete(repoUrl);
    }
  }

  // ---- Session-scoped reads ----

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

  // GET /api/sessions/:id/history — read-only chat history + workspace data (no session activation)
  app.get<{ Params: { id: string } }>("/api/sessions/:id/history", async (request, reply) => {
    const session = sessionManager.get(request.params.id);
    if (!session) {
      reply.code(404).send({ error: "Session not found" });
      return;
    }
    let messages = getChatHistory(deps.chatHistoryManager, request.params.id) as Record<string, unknown>[];

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

    const runner = deps.runnerRegistry.get(request.params.id);
    const agentRunning = runner?.running ?? false;

    // If the agent is mid-turn, replace persisted in-progress messages with
    // the live state from the runner's chatMessageGroups. This covers text
    // accumulated since the last agent_tool_result persistence boundary.
    if (agentRunning && runner) {
      const liveGroups = runner.chatMessageGroups;
      if (liveGroups.length > 0) {
        // Remove persisted in-progress entries (stale snapshot)
        const kept = messages.filter((m) => !m.inProgress);
        for (const g of liveGroups) {
          if (g.text || g.toolUse.length > 0) {
            kept.push({
              role: "assistant",
              text: g.text,
              toolUse: g.toolUse.length > 0 ? g.toolUse : undefined,
              toolResults: g.toolResults?.length ? g.toolResults : undefined,
              inProgress: true,
            });
          }
        }
        messages = kept;
      }
    }

    return { messages, commits, fileTree, agentRunning };
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

  // ---- Session mutations ----

  // GET /api/sessions/all — list all sessions (active + archived)
  app.get("/api/sessions/all", async () => {
    return { sessions: listAllSessions(sessionManager) };
  });

  // POST /api/sessions/:id/unarchive — restore an archived session
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/unarchive",
    async (request, reply) => {
      try {
        const result = await unarchiveSession(
          sessionManager,
          createRepoGit,
          deps.getSharedRepoDir,
          deps.githubAuthManager,
          deps.repoStore,
          request.params.id,
        );
        deps.sseBroadcast("session_list", { sessions: result.sessions });
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to unarchive session: ${getErrorMessage(err)}` });
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

  // POST /api/sessions/:id/fork — fork session into a new worktree branch
  app.post<{ Params: { id: string }; Body: { branchName: string; startPoint?: string } }>(
    "/api/sessions/:id/fork",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const result = await forkSession(
          sessionManager, createRepoGit, deps.getSharedRepoDir, deps.sessionsRoot,
          deps.githubAuthManager, { init: () => {} },
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
          void (async () => {
            try {
              // eslint-disable-next-line no-restricted-syntax -- stat existence-check idiom
              const exists = await stat(repoDir).then(() => true, () => false);
              if (!exists) {
                await mkdir(repoDir, { recursive: true });
                const cloneUrl = deps.githubAuthManager.getAuthenticatedCloneUrl(repoUrl);
                const repoGit = createRepoGit(repoDir);
                await repoGit.clone(cloneUrl);
                console.log("[repos] Cloned repo to shared dir:", repoDir);
              }
              deps.repoStore.setReady(repoUrl);
              deps.sseBroadcast("repo_status", { url: repoUrl, status: "ready" });
              // Start warming a session
              const warmFn = deps.warmSessionForRepo;
              if (warmFn) await warmFn(repoUrl);
            } catch (err) {
              console.error("[repos] Background clone failed:", getErrorMessage(err));
              deps.sseBroadcast("error", { message: `Failed to clone repository: ${getErrorMessage(err)}` });
            }
          })();
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
          deleteSession(sessionManager, repo.warmSessionId, deps.chatHistoryManager, deps.usageManager);
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

      // Serialize all claim-session work per repo so git operations
      // (fetch, reset, worktree add) never run concurrently on the
      // same shared repo — eliminates "cannot lock ref" CAS errors.
      try {
        return await serializeClaim(url, async () => {
          // Wait for any in-progress warming (e.g. from session graduation) to
          // finish before doing git operations on the shared repo.
          const inFlightWarming = deps.waitForWarmSession?.(url);
          if (inFlightWarming) await inFlightWarming;

          // Reuse path: if a previously-claimed warm session for this repo exists
          // (user clicked "New Session", navigated away without sending a message,
          // then clicked "New Session" again), return it instead of claiming a new one.
          // This avoids creating duplicate containers for sessions the user never used.
          // We check for .git (file for worktrees) to ensure
          // the worktree is fully initialized — the session directory is created
          // early (mkdir) but the git worktree is created later, so an in-progress
          // warm session would have the dir but no .git yet.
          const reusable = sessionManager.findUngraduatedWarm(url, repo.warmSessionId ?? undefined);
          if (reusable?.workspaceDir && existsSync(path.join(reusable.workspaceDir, ".git"))) {
            let fetchDurationMs = 0;
            try {
              const result = await refreshWorktreeToLatestMain(deps.getSharedRepoDir(url), reusable.workspaceDir, createRepoGit, createGitManager);
              fetchDurationMs = result.fetchDurationMs;
              // If HEAD moved, restart preview so it re-runs install with new deps.
              // The reuse path has an already-running container with preview started.
              if (result.headChanged) {
                const runner = deps.runnerRegistry.get(reusable.id);
                if (runner && "restartPreviewOnWorker" in runner) {
                  // Fire-and-forget — don't block claim-session on install.
                  // The client will receive install_status events via WS after reconnecting.
                  void (runner as { restartPreviewOnWorker: () => Promise<void> }).restartPreviewOnWorker();
                }
              }
            } catch (err) {
              console.error(`[claim-session] Failed to refresh worktree to latest main:`, getErrorMessage(err));
            }
            return { sessionId: reusable.id, sessionDir: reusable.workspaceDir, fetchDurationMs };
          }

          // Warm path: claim the pre-warmed session (worktree + metadata only).
          // No container is created here — it will be created on-demand when
          // the WebSocket connects and activateSession() calls getOrCreate().
          const currentRepo = deps.repoStore.get(url);
          if (currentRepo?.warmSessionId) {
            const warmSession = sessionManager.get(currentRepo.warmSessionId);
            if (warmSession?.workspaceDir) {
              const sessionId = currentRepo.warmSessionId;
              deps.repoStore.setWarmSessionId(url, undefined);
              let fetchDurationMs = 0;
              try {
                const result = await refreshWorktreeToLatestMain(deps.getSharedRepoDir(url), warmSession.workspaceDir, createRepoGit, createGitManager);
                fetchDurationMs = result.fetchDurationMs;
              } catch (err) {
                console.error(`[claim-session] Failed to refresh worktree to latest main:`, getErrorMessage(err));
              }
              // Start warming the next session AFTER fetch completes to avoid
              // concurrent git operations on the same shared repo.
              if (deps.warmSessionForRepo) await deps.warmSessionForRepo(url, { withStandby: true });
              return { sessionId, sessionDir: warmSession.workspaceDir, fetchDurationMs };
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
                let fetchDurationMs = 0;
                try {
                  const result = await refreshWorktreeToLatestMain(deps.getSharedRepoDir(url), warmSession.workspaceDir, createRepoGit, createGitManager);
                  fetchDurationMs = result.fetchDurationMs;
                } catch (err) {
                  console.error(`[claim-session] Failed to refresh worktree to latest main:`, getErrorMessage(err));
                }
                if (deps.warmSessionForRepo) await deps.warmSessionForRepo(url, { withStandby: true });
                return { sessionId, sessionDir: warmSession.workspaceDir, fetchDurationMs };
              }
            }
          }

          // No warm session available — create one synchronously.
          // If the client already disconnected (rapid navigation), skip the expensive work.
          if (request.raw.destroyed) return undefined;
          const repoDir = deps.getSharedRepoDir(url);
          const branchPrefix = generateBranchPrefix();
          const created = await deps.createSessionDirFull("Warm session");
          const { appSessionId, sessionDir } = created;

          // Remove the empty dir (worktree add needs it absent)
          await rm(sessionDir, { recursive: true, force: true });

          const repoGit = createRepoGit(repoDir);

          // Fetch latest default branch so the worktree is not stale
          const fetchT0 = Date.now();
          let startPoint: string | undefined;
          try {
            const defaultBranch = await repoGit.getDefaultBranch();
            if (defaultBranch && !defaultBranch.includes("(")) {
              await repoGit.fetch("origin", defaultBranch);
              startPoint = `origin/${defaultBranch}`;
            }
          } catch (err) {
            console.error(`[claim-session] Fetch origin failed for ${url}:`, getErrorMessage(err));
          }
          const fetchDurationMs = Date.now() - fetchT0;

          // Empty repos have no commits — create one so worktree add has a start point
          if (await repoGit.isEmpty()) {
            await repoGit.createInitialCommit();
          }
          await repoGit.createWorktree(sessionDir, branchPrefix, startPoint);

          // Configure credentials
          if (deps.githubAuthManager.authenticated) {
            deps.githubAuthManager.configureGitCredentials(sessionDir);
          }

          sessionManager.setRemoteUrl(appSessionId, url);
          sessionManager.setWorktreeInfo(appSessionId, {
            branch: branchPrefix,
            sessionType: "worktree",
          });
          sessionManager.setWarm(appSessionId, true);

          // No container is created here — it will be created on-demand when
          // the WebSocket connects and activateSession() calls getOrCreate().

          // Start warming the next session in background (with standby container)
          if (deps.warmSessionForRepo) await deps.warmSessionForRepo(url, { withStandby: true });

          return { sessionId: appSessionId, sessionDir, fetchDurationMs };
        });
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to claim session: ${getErrorMessage(err)}` });
      }
    },
  );
}
