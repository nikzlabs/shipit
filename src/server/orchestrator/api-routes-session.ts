/**
 * Session management API routes.
 * Handles: session CRUD, switching, renaming, status, history, usage,
 * siblings, fork, template, repos, claim-session.
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
  spawnChildSession,
  listSpawnedChildren,
  getSpawnedChild,
  ServiceError,
} from "./services/index.js";
import type { AgentId } from "../shared/types.js";
import { getErrorMessage } from "./validation.js";
import { generateBranchPrefix, fetchAndResolveDefaultBranch } from "./git-utils.js";
import { resolveAgentDockerLimits } from "./session-container.js";

/**
 * Fetch latest origin refs and hard-reset a warm session clone to the current
 * remote HEAD. Safe because warm sessions have zero user changes.
 * Non-fatal — if fetch or reset fails, the session still works with older code.
 *
 * Shares `fetchAndResolveDefaultBranch` with the warm pool and the claim
 * slow-path so all three resolve "latest main" against the *real* remote,
 * never against a stale `git clone --local` snapshot of the bare cache.
 *
 * Always (re-)configures the workspace's credential helper before fetching.
 * Reused sessions can be hours/days old and may have either no local
 * credential helper or one with a now-expired token baked into the shell
 * one-liner from a previous `configureGitCredentials` call. Overwriting it
 * with the *current* token on every reuse is the only way to keep the fetch
 * authenticated through token rotations without confusing a missing-helper
 * "could not read Username" with a server-rejected credential.
 */
async function refreshCloneToLatestMain(
  sessionDir: string,
  createGitManager: ApiDeps["createGitManager"],
  githubAuthManager: ApiDeps["githubAuthManager"],
  onAuthError?: (err: Error) => void,
): Promise<{ headChanged: boolean; fetched: boolean; fetchDurationMs: number }> {
  const sessionGit = createGitManager(sessionDir);
  const headBefore = await sessionGit.getHeadHash();
  if (githubAuthManager.authenticated) {
    githubAuthManager.configureGitCredentials(sessionDir);
  }
  const { resetTarget, fetched, fetchDurationMs } = await fetchAndResolveDefaultBranch(sessionDir, onAuthError);
  if (resetTarget) {
    await sessionGit.rollback(resetTarget);
  }
  const headAfter = await sessionGit.getHeadHash();
  const headChanged = headBefore !== headAfter;
  if (headChanged) {
    try { unlinkSync(path.join(sessionDir, ".shipit", ".install-done")); } catch { /* marker may not exist */ }
  }
  // `fetched` is propagated so the claim handler can surface a stale-clone
  // warning — a workspace fetch that silently no-ops is the W2 root cause.
  return { headChanged, fetched, fetchDurationMs };
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

  /**
   * After a claim-time clone refresh moved HEAD, the standby container may
   * have booted with resource limits derived from a now-stale `shipit.yaml`
   * — the irreducible warm→claim time gap (warm provisions from commit C1,
   * claim refreshes to C2). Container memory is immutable at runtime, so the
   * only fix is to destroy the standby: the runner factory's fresh-create
   * path rebuilds it with the current limits on first attach.
   *
   * No-op when there's no container manager, no tracked container, the
   * container has no recorded `bootedLimits` (rediscovered), the workspace's
   * shipit.yaml is unparseable (the on-demand create path surfaces that
   * loudly — see W4), or the limits already match.
   */
  async function reprovisionStandbyIfLimitsChanged(
    sessionId: string,
    workspaceDir: string,
  ): Promise<void> {
    const cm = deps.containerManager;
    if (!cm) return;
    const container = cm.get(sessionId);
    if (!container?.bootedLimits) return;
    let fresh;
    try {
      fresh = resolveAgentDockerLimits(workspaceDir);
    } catch (err) {
      console.warn(`[claim-session] Cannot re-derive limits for ${sessionId}: ${getErrorMessage(err)}`);
      return;
    }
    const booted = container.bootedLimits;
    if (
      fresh.memoryLimit === booted.memoryLimit &&
      fresh.cpuQuota === booted.cpuQuota &&
      fresh.pidsLimit === booted.pidsLimit
    ) {
      return;
    }
    console.warn(
      `[claim-session] Standby container for ${sessionId} booted with stale resource limits ` +
        `(mem ${booted.memoryLimit} → ${fresh.memoryLimit}, cpu ${booted.cpuQuota} → ${fresh.cpuQuota}, ` +
        `pids ${booted.pidsLimit} → ${fresh.pidsLimit}) after a HEAD change — destroying so it ` +
        `rebuilds with the current shipit.yaml on first attach.`,
    );
    await cm.destroy(sessionId);
  }

  /**
   * Surface a workspace-clone fetch that silently no-op'd during a claim —
   * the W2 root cause. When `fetched` is false the clone was *not* refreshed
   * against the real remote, so the claimed session may be on stale code.
   * Shared by all `refreshCloneToLatestMain` call sites in the claim handler.
   */
  function warnIfStaleClaimFetch(fetched: boolean, url: string): void {
    if (fetched) return;
    console.warn(`[claim-session] Workspace fetch failed for ${url} — using the existing clone, which may be stale`);
    deps.sseBroadcast("error", {
      message: `Claimed session for ${url} may be based on stale code — could not fetch the latest commits.`,
    });
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
    const messages = getChatHistory(deps.chatHistoryManager, request.params.id) as Record<string, unknown>[];

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

    // Don't reconstruct in-progress messages from runner.chatMessageGroups here.
    // The DB already has in-progress rows persisted at each agent_tool_result
    // boundary, which is a consistent snapshot. Including chatMessageGroups
    // would duplicate content that also arrives via the WS live event stream,
    // causing messages to appear twice (or be overwritten) on reconnect.
    // The WS listener picks up where the DB snapshot leaves off.

    // Authoritative per-turn / cumulative usage for the context dial. This
    // replaces the old "attach turnUsage to the last message group" hack:
    // the canonical source is `usage_turns`, fetched here so the dial sees
    // the same number the cost UI does.
    const turnUsage = deps.usageManager.getPerTurnUsage(request.params.id);
    const sessionUsage = deps.usageManager.getSessionUsage(request.params.id) ?? null;
    const tokenTotals = deps.usageManager.getSessionTokenTotals(request.params.id);

    return {
      messages,
      commits,
      fileTree,
      agentRunning,
      turnUsage,
      sessionUsage,
      cumulativeInputTokens: tokenTotals?.cumulativeInputTokens,
      cumulativeOutputTokens: tokenTotals?.cumulativeOutputTokens,
    };
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
        // Clear the persisted PR snapshot — unarchive starts a fresh branch,
        // so the previous PR no longer applies. Also drops the stale row from
        // the SSE `getAllStatuses()` snapshot for new clients.
        deps.prStatusPoller?.clearPersisted(request.params.id);
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
          deps.getSharedRepoDir,
          request.params.id,
          deps.pruneSessionVolumes,
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
  // Agent-spawned child sessions (docs/117)
  //
  // These three routes back the `shipit session create|list|view` shim
  // subcommands. The shim → worker hop injects the worker's bound session
  // id into the URL as `:parentId`, so the agent cannot specify a different
  // parent — the cross-tenancy guarantee comes from the worker, not the
  // orchestrator. The orchestrator still enforces "child must be a direct
  // descendant of parent" on every read.
  // ===========================================================================

  // POST /api/sessions/:parentId/spawn — agent-driven session spawn
  app.post<{
    Params: { parentId: string };
    Body: {
      prompt?: string;
      title?: string;
      branch?: string;
      base?: string;
      agent?: AgentId;
      model?: string;
      spawnedByTurn?: string;
    };
  }>(
    "/api/sessions/:parentId/spawn",
    async (request, reply) => {
      const body = request.body ?? {};
      try {
        const result = await spawnChildSession(
          sessionManager,
          deps.runnerRegistry,
          createRepoGit,
          deps.getSharedRepoDir,
          deps.sessionsRoot,
          deps.githubAuthManager,
          request.params.parentId,
          {
            prompt: body.prompt ?? "",
            ...(body.title !== undefined ? { title: body.title } : {}),
            ...(body.branch !== undefined ? { branch: body.branch } : {}),
            ...(body.base !== undefined ? { base: body.base } : {}),
            ...(body.agent !== undefined ? { agent: body.agent } : {}),
            ...(body.model !== undefined ? { model: body.model } : {}),
            ...(body.spawnedByTurn !== undefined ? { spawnedByTurn: body.spawnedByTurn } : {}),
          },
          deps.defaultAgentId,
        );
        // Broadcast the updated session list so the parent's sidebar shows
        // the new child immediately — same pattern as `fork` / `unarchive`.
        deps.sseBroadcast("session_list", { sessions: result.sessions });
        return {
          sessionId: result.sessionId,
          branch: result.branch,
          status: "running" as const,
          session: result.session,
        };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to spawn child session: ${getErrorMessage(err)}` });
      }
    },
  );

  // GET /api/sessions/:parentId/children — list children spawned by this parent
  app.get<{
    Params: { parentId: string };
    Querystring: { turn?: string };
  }>(
    "/api/sessions/:parentId/children",
    async (request, reply) => {
      const parent = sessionManager.get(request.params.parentId);
      if (!parent) {
        reply.code(404).send({ error: "Parent session not found" });
        return;
      }
      const children = listSpawnedChildren(
        sessionManager,
        deps.runnerRegistry,
        request.params.parentId,
        request.query.turn,
      );
      return { children };
    },
  );

  // GET /api/sessions/:parentId/children/:childId — view one child session
  app.get<{
    Params: { parentId: string; childId: string };
  }>(
    "/api/sessions/:parentId/children/:childId",
    async (request, reply) => {
      try {
        const child = getSpawnedChild(
          sessionManager,
          deps.runnerRegistry,
          request.params.parentId,
          request.params.childId,
        );
        return { child };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to read child session: ${getErrorMessage(err)}` });
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
          // Forced — user is removing the repo, so the warm session is
          // explicitly being torn down regardless of agent state.
          if (runner) runner.dispose({ force: true });
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
        const result = await serializeClaim(url, async () => {
          const inFlightWarming = deps.waitForWarmSession?.(url);
          if (inFlightWarming) await inFlightWarming;

          // Reuse path: check for previously-claimed warm session.
          // Check for .git/ directory (full clone) to ensure the clone is ready.
          const reusable = sessionManager.findUngraduatedWarm(url, repo.warmSessionId ?? undefined);
          if (reusable?.workspaceDir && existsSync(path.join(reusable.workspaceDir, ".git"))) {
            let fetchDurationMs = 0;
            try {
              const result = await refreshCloneToLatestMain(
                reusable.workspaceDir,
                createGitManager,
                deps.githubAuthManager,
                (err) => deps.githubAuthManager.markTokenInvalid(`claim-session refresh failed for ${url}: ${err.message}`),
              );
              fetchDurationMs = result.fetchDurationMs;
              warnIfStaleClaimFetch(result.fetched, url);
              if (result.headChanged) {
                // HEAD moved — the standby container may have booted with
                // limits from a now-stale shipit.yaml. Re-provision if so.
                // (Compose stack restart is handled by ServiceManager on
                // config change.)
                await reprovisionStandbyIfLimitsChanged(reusable.id, reusable.workspaceDir);
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
                const result = await refreshCloneToLatestMain(
                  warmSession.workspaceDir,
                  createGitManager,
                  deps.githubAuthManager,
                  (err) => deps.githubAuthManager.markTokenInvalid(`claim-session refresh failed for ${url}: ${err.message}`),
                );
                fetchDurationMs = result.fetchDurationMs;
                warnIfStaleClaimFetch(result.fetched, url);
                if (result.headChanged) {
                  // HEAD moved — re-provision the standby if its booted
                  // limits no longer match the now-current shipit.yaml.
                  await reprovisionStandbyIfLimitsChanged(sessionId, warmSession.workspaceDir);
                }
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
                  const result = await refreshCloneToLatestMain(
                    warmSession.workspaceDir,
                    createGitManager,
                    deps.githubAuthManager,
                    (err) => deps.githubAuthManager.markTokenInvalid(`claim-session refresh failed for ${url}: ${err.message}`),
                  );
                  fetchDurationMs = result.fetchDurationMs;
                  warnIfStaleClaimFetch(result.fetched, url);
                  if (result.headChanged) {
                    // HEAD moved — re-provision the standby if its booted
                    // limits no longer match the now-current shipit.yaml.
                    await reprovisionStandbyIfLimitsChanged(sessionId, warmSession.workspaceDir);
                  }
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
          const { appSessionId, sessionDir, workspaceDir } = created;

          await rm(workspaceDir, { recursive: true, force: true });

          const cacheGit = createRepoGit(cacheDir);

          // Refresh remote URL with current token before fetching
          if (deps.githubAuthManager.authenticated) {
            const freshUrl = deps.githubAuthManager.getAuthenticatedCloneUrl(url);
            await cacheGit.setRemoteUrl(freshUrl);
          }

          try {
            await cacheGit.fetchCache();
          } catch (err) {
            // Non-fatal here — the `fetchAndResolveDefaultBranch` below
            // fetches the real remote directly in the workspace clone, so
            // a stale bare cache no longer freezes the slow path. Still
            // surfaced so a repo whose cache can't fetch is visible.
            console.error(`[claim-session] Fetch cache failed for ${url}:`, getErrorMessage(err));
            deps.sseBroadcast("error", {
              message: `Repository cache for ${url} could not be refreshed: ${getErrorMessage(err)}`,
            });
          }

          await cacheGit.cloneFromCache(workspaceDir, url);

          // Configure credentials BEFORE fetching the real remote — the
          // workspace clone's origin is the plain (unauthenticated) URL, so
          // a private-repo fetch needs the credential helper in place.
          if (deps.githubAuthManager.authenticated) {
            deps.githubAuthManager.configureGitCredentials(workspaceDir);
          }

          // W2: `cloneFromCache` only gave us a snapshot of the (possibly
          // 270-commits-stale) bare cache. Fetch the real remote in the
          // workspace clone so the branch is cut from the genuine latest
          // commit — otherwise the container's memory limit is derived from
          // a frozen `shipit.yaml`.
          const { resetTarget, fetched, fetchDurationMs, authError } = await fetchAndResolveDefaultBranch(
            workspaceDir,
            (err) => deps.githubAuthManager.markTokenInvalid(`claim-session fetch failed for ${url}: ${err.message}`),
          );
          if (!fetched && !authError) {
            // Workspace-clone fetch failed — the branch is being cut from
            // the (possibly stale) bare-cache snapshot. Surface it: a silent
            // no-op fetch here is the W2 root cause.
            // Auth errors get their own dedicated `github_status` SSE
            // broadcast (via `markTokenInvalid`), so don't double up here.
            console.warn(`[claim-session] Workspace fetch failed for ${url} — branching from the bare-cache snapshot, which may be stale`);
            deps.sseBroadcast("error", {
              message: `Claimed session for ${url} may be based on stale code — could not fetch the latest commits.`,
            });
          }
          const branchArgs = ["checkout", "-b", branchPrefix];
          if (resetTarget) branchArgs.push(resetTarget);
          await simpleGit(workspaceDir).raw(branchArgs);

          sessionManager.setRemoteUrl(appSessionId, url);
          sessionManager.setBranch(appSessionId, branchPrefix);
          sessionManager.setWarm(appSessionId, true);

          if (deps.warmSessionForRepo) await deps.warmSessionForRepo(url, { withStandby: true });

          return { sessionId: appSessionId, sessionDir, fetchDurationMs };
        });
        // Reset created_at to "now" for the claimed session. Warm-pool warming
        // inserts the session row before the workspace is cloned, so without
        // this reset every file in the freshly-cloned workspace would have
        // mtime > createdAt and the docs viewer's "modified in this session"
        // group would incorrectly list everything in the repo.
        if (result?.sessionId) {
          sessionManager.markStarted(result.sessionId);
        }
        return result;
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
