/**
 * Session management API routes.
 * Handles: session CRUD, switching, renaming, status, history, usage,
 * siblings, features, fork, template, repos, claim-session.
 */

import { existsSync, unlinkSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import simpleGit from "simple-git";
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
 * Fetch latest origin refs and hard-reset a warm session clone to the current
 * remote HEAD. Safe because warm sessions have zero user changes.
 * Non-fatal — if fetch or reset fails, the session still works with older code.
 */
async function refreshCloneToLatestMain(
  sessionDir: string,
  createGitManager: ApiDeps["createGitManager"],
): Promise<{ headChanged: boolean; fetchDurationMs: number }> {
  const t0 = Date.now();
  const sessionGit = createGitManager(sessionDir);
  const headBefore = await sessionGit.getHeadHash();
  const sg = simpleGit(sessionDir);
  // Fetch directly in the session clone and reset to origin's default branch
  await sg.fetch("origin");
  // Try origin/HEAD first, then fall back to common default branch names.
  // Avoid `git remote set-head --auto` here — it hits the network and can
  // hang if credentials aren't configured in this clone yet.
  let resetTarget: string | undefined;
  try {
    resetTarget = (await sg.raw(["rev-parse", "origin/HEAD"])).trim();
  } catch {
    // origin/HEAD not set — try common defaults
    for (const branch of ["origin/main", "origin/master"]) {
      try {
        resetTarget = (await sg.raw(["rev-parse", branch])).trim();
        break;
      } catch { /* try next */ }
    }
  }
  if (resetTarget) {
    await sessionGit.rollback(resetTarget);
  }
  const headAfter = await sessionGit.getHeadHash();
  const headChanged = headBefore !== headAfter;
  if (headChanged) {
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
  // so git operations (fetch, clone) never run concurrently on the same bare cache.
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

    if (agentRunning && runner) {
      const liveGroups = runner.chatMessageGroups;
      if (liveGroups.length > 0) {
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

  // GET /api/sessions/:id/worktrees — sibling sessions
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

  // POST /api/sessions/:id/fork — fork session into a new clone with branch
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

      if (body.url) {
        try {
          const repo = addRepo(deps.repoStore, body.url);
          if (repo.status === "ready") {
            return { repo };
          }
          // Clone bare cache in background
          const repoUrl = repo.url;
          const cacheDir = deps.getSharedRepoDir(repoUrl);
          void (async () => {
            try {
              // eslint-disable-next-line no-restricted-syntax -- stat existence-check idiom
              const exists = await stat(cacheDir).then(() => true, () => false);
              if (!exists) {
                await mkdir(cacheDir, { recursive: true });
                const cloneUrl = deps.githubAuthManager.getAuthenticatedCloneUrl(repoUrl);
                const cacheGit = createRepoGit(cacheDir);
                await cacheGit.cloneBare(cloneUrl);
                console.log("[repos] Cloned bare cache:", cacheDir);
              }
              deps.repoStore.setReady(repoUrl);
              deps.sseBroadcast("repo_status", { url: repoUrl, status: "ready" });
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

      if (!body.repoName || !body.templateId) {
        reply.code(400).send({ error: "Either 'url' or both 'repoName' and 'templateId' are required" });
        return;
      }
      try {
        const result = await createRepoWithTemplate(
          createGitManager,
          deps.githubAuthManager, deps.getSharedRepoDir,
          body.repoName, body.templateId,
          body.description, body.isPrivate,
        );
        if (!result.success) {
          reply.code(400).send(result);
          return;
        }
        if (result.repoUrl) {
          deps.repoStore.add(result.repoUrl);
          deps.repoStore.setReady(result.repoUrl);
          deps.sseBroadcast("repo_list", { repos: listRepos(deps.repoStore) });
          void deps.warmSessionForRepo?.(result.repoUrl);
          const warmingPromise = deps.waitForWarmSession?.(result.repoUrl);
          if (warmingPromise) {
            await warmingPromise;
          }
          const repo = deps.repoStore.get(result.repoUrl);
          if (repo?.warmSessionId) {
            return { ...result, sessionId: repo.warmSessionId };
          }
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

  // POST /api/repos/:url/claim-session — claim a warm session for a repo
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

      try {
        return await serializeClaim(url, async () => {
          const inFlightWarming = deps.waitForWarmSession?.(url);
          if (inFlightWarming) await inFlightWarming;

          // Reuse path: check for previously-claimed warm session.
          // Check for .git/ directory (full clone) to ensure the clone is ready.
          const reusable = sessionManager.findUngraduatedWarm(url, repo.warmSessionId ?? undefined);
          if (reusable?.workspaceDir && existsSync(path.join(reusable.workspaceDir, ".git"))) {
            let fetchDurationMs = 0;
            try {
              const result = await refreshCloneToLatestMain(reusable.workspaceDir, createGitManager);
              fetchDurationMs = result.fetchDurationMs;
              if (result.headChanged) {
                const runner = deps.runnerRegistry.get(reusable.id);
                if (runner && "restartPreviewOnWorker" in runner) {
                  void (runner as { restartPreviewOnWorker: () => Promise<void> }).restartPreviewOnWorker();
                }
              }
            } catch (err) {
              console.error(`[claim-session] Failed to refresh clone to latest main:`, getErrorMessage(err));
            }
            return { sessionId: reusable.id, sessionDir: reusable.workspaceDir, fetchDurationMs };
          }

          // Warm path: claim the pre-warmed session.
          const currentRepo = deps.repoStore.get(url);
          if (currentRepo?.warmSessionId) {
            const warmSession = sessionManager.get(currentRepo.warmSessionId);
            if (warmSession?.workspaceDir) {
              const sessionId = currentRepo.warmSessionId;
              deps.repoStore.setWarmSessionId(url, undefined);
              let fetchDurationMs = 0;
              try {
                const result = await refreshCloneToLatestMain(warmSession.workspaceDir, createGitManager);
                fetchDurationMs = result.fetchDurationMs;
              } catch (err) {
                console.error(`[claim-session] Failed to refresh clone to latest main:`, getErrorMessage(err));
              }
              if (deps.warmSessionForRepo) await deps.warmSessionForRepo(url, { withStandby: true });
              return { sessionId, sessionDir: warmSession.workspaceDir, fetchDurationMs };
            }
          }

          // Waiting path: wait for in-progress warming.
          const warmingPromise = deps.waitForWarmSession?.(url);
          if (warmingPromise) {
            await warmingPromise;
            const freshRepo = deps.repoStore.get(url);
            if (freshRepo?.warmSessionId) {
              const warmSession = sessionManager.get(freshRepo.warmSessionId);
              if (warmSession?.workspaceDir) {
                const sessionId = freshRepo.warmSessionId;
                deps.repoStore.setWarmSessionId(url, undefined);
                let fetchDurationMs = 0;
                try {
                  const result = await refreshCloneToLatestMain(warmSession.workspaceDir, createGitManager);
                  fetchDurationMs = result.fetchDurationMs;
                } catch (err) {
                  console.error(`[claim-session] Failed to refresh clone to latest main:`, getErrorMessage(err));
                }
                if (deps.warmSessionForRepo) await deps.warmSessionForRepo(url, { withStandby: true });
                return { sessionId, sessionDir: warmSession.workspaceDir, fetchDurationMs };
              }
            }
          }

          // Slow path: clone from bare cache synchronously.
          if (request.raw.destroyed) return undefined;
          const cacheDir = deps.getSharedRepoDir(url);
          const branchPrefix = generateBranchPrefix();
          const created = await deps.createSessionDirFull("Warm session");
          const { appSessionId, sessionDir } = created;

          await rm(sessionDir, { recursive: true, force: true });

          const cacheGit = createRepoGit(cacheDir);

          const fetchT0 = Date.now();
          try {
            await cacheGit.fetchCache();
          } catch (err) {
            console.error(`[claim-session] Fetch cache failed for ${url}:`, getErrorMessage(err));
          }
          const fetchDurationMs = Date.now() - fetchT0;

          await cacheGit.cloneFromCache(sessionDir);

          let startPoint: string | undefined;
          try {
            const defaultBranch = await cacheGit.getDefaultBranch();
            if (defaultBranch && !defaultBranch.includes("(")) {
              startPoint = `origin/${defaultBranch}`;
            }
          } catch {
            // Fallback
          }
          const branchArgs = ["checkout", "-b", branchPrefix];
          if (startPoint) branchArgs.push(startPoint);
          await simpleGit(sessionDir).raw(branchArgs);

          if (deps.githubAuthManager.authenticated) {
            deps.githubAuthManager.configureGitCredentials(sessionDir);
          }

          sessionManager.setRemoteUrl(appSessionId, url);
          sessionManager.setBranch(appSessionId, branchPrefix);
          sessionManager.setWarm(appSessionId, true);

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
