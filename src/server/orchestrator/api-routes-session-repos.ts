/**
 * Repo management API routes.
 * Handles: repo list, add (existing) / create-with-template, trust, reorder,
 * remove, claim-session.
 */

import { mkdir, stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";

import {
  listRepos,
  addRepo,
  removeRepo,
  reorderRepos,
  setRepoTrusted,
  createRepoWithTemplate,
  deleteSession,
  archiveSession,
  ServiceError,
  createClaimSessionService,
  ClaimAbortedError,
} from "./services/index.js";
import { canonicalRepoKey } from "./git-utils.js";
import { getErrorMessage } from "./validation.js";

export async function registerSessionReposRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  const { sessionManager, createGitManager, createRepoGit } = deps;

  // Single shared claim service for every surface that mints a repo-backed
  // session (HTTP claim, agent spawn, skill-install-as-session). The per-repo
  // promise chain lives in the factory's closure, so callers MUST share one
  // instance for the serialization to guard concurrent bare-cache operations.
  // `registerApiRoutes` constructs and threads it in via `deps`; fall back to a
  // local instance for direct callers / tests that don't provide one.
  const claimSessionService = deps.claimSessionService ?? createClaimSessionService({
    sessionManager,
    repoStore: deps.repoStore,
    createGitManager: deps.createGitManager,
    createRepoGit,
    githubAuthManager: deps.githubAuthManager,
    getSharedRepoDir: deps.getSharedRepoDir,
    createSessionDirFull: deps.createSessionDirFull,
    sseBroadcast: deps.sseBroadcast,
    ...(deps.warmSessionForRepo ? { warmSessionForRepo: deps.warmSessionForRepo } : {}),
    ...(deps.waitForWarmSession ? { waitForWarmSession: deps.waitForWarmSession } : {}),
    ...(deps.shouldSkipClaimFetch ? { shouldSkipClaimFetch: deps.shouldSkipClaimFetch } : {}),
    ...(deps.containerManager ? { containerManager: deps.containerManager } : {}),
  });

  // GET /api/repos — list all added repos
  app.get("/api/repos", async () => {
    return { repos: listRepos(deps.repoStore) };
  });

  // POST /api/repos — add a repo (existing) or create a new GitHub repo with template
  app.post<{ Body: { url?: string; repoName?: string; templateId?: string; description?: string; isPrivate?: boolean; owner?: string } }>(
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
                const cacheGit = createRepoGit(cacheDir);
                // Plain URL — the global git credential helper installed by
                // GitHubAuthManager provides the token at fetch/clone time.
                // Embedding it in the URL is redundant and leaks the token
                // into config files, error messages, and process listings.
                await cacheGit.cloneBare(repoUrl);
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
          createRepoGit,
          deps.githubAuthManager, deps.getSharedRepoDir,
          body.repoName, body.templateId,
          body.description, body.isPrivate, body.owner,
        );
        if (!result.success) {
          reply.code(400).send(result);
          return;
        }
        if (result.repoUrl) {
          deps.repoStore.add(result.repoUrl);
          deps.repoStore.setReady(result.repoUrl);
          // docs/178 — a ShipIt-scaffolded repo has no attacker-authored
          // config, so it is trusted by construction and never prompts.
          deps.repoStore.setTrusted(result.repoUrl, true);
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

  // POST /api/repos/trust — grant trust to a remote (docs/178 TOFU gate).
  // Accepting once unblocks all repo-declared auto-execution (agent.install +
  // compose command:/build:) for the remote, now and for every future session
  // cloned from it. Idempotent: trusting an already-trusted repo is a no-op.
  app.post<{ Body: { url?: string } }>(
    "/api/repos/trust",
    async (request, reply) => {
      try {
        const url = request.body?.url?.trim();
        setRepoTrusted(deps.repoStore, url);
        // Broadcast the updated list so every connected tab clears its trust
        // banner (the banner is driven by the repo's `trusted` flag).
        deps.sseBroadcast("repo_list", { repos: listRepos(deps.repoStore) });
        // Unblock the deferred setup for any already-open session of this
        // remote: re-run its compose/install setup now that trust is granted,
        // so the user doesn't have to restart the session to get a preview.
        const key = canonicalRepoKey(url!);
        for (const session of sessionManager.list()) {
          if (session.remoteUrl && canonicalRepoKey(session.remoteUrl) === key) {
            const runner = deps.runnerRegistry.get(session.id) as
              | { rerunServiceSetup?: () => void }
              | undefined;
            runner?.rerunServiceSetup?.();
          }
        }
        // Warm the now-trusted remote so the next New Session is instant — the
        // pre-install step was a no-op while untrusted.
        void deps.warmSessionForRepo?.(url!);
        return { repo: deps.repoStore.get(url!) ?? null, trusted: true };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to trust repo: ${getErrorMessage(err)}` });
      }
    },
  );

  // PUT /api/repos/order — reorder repos in the sidebar
  // Registered before DELETE /api/repos/:url so "order" isn't captured as a
  // URL-encoded :url parameter (defensive — fastify routes by method, but the
  // explicit ordering makes the intent obvious to readers).
  app.put<{ Body: { urls: string[] } }>(
    "/api/repos/order",
    async (request, reply) => {
      try {
        const urls = request.body?.urls;
        if (!Array.isArray(urls)) {
          reply.code(400).send({ error: "Request body must include a 'urls' array" });
          return;
        }
        const repos = reorderRepos(deps.repoStore, urls);
        // Broadcast so other connected tabs/clients pick up the new order
        // immediately — same pattern as add/remove.
        deps.sseBroadcast("repo_list", { repos });
        return { repos };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to reorder repos: ${getErrorMessage(err)}` });
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
          deleteSession(sessionManager, repo.warmSessionId, deps.chatHistoryManager, deps.usageManager, deps.removeSessionLogs, deps.presentStore);
        }
        // Archive every real session for this repo so it leaves the sidebar and
        // its disk (workspace clone, compose volumes, logs, container) is
        // reclaimed exactly like a user-initiated archive. Rows stay in the DB
        // (archived), so history/usage survive — removing the repo only hides
        // the sessions, it doesn't erase them. Re-fetch each session live so a
        // child already archived by a parent's cascade is skipped.
        for (const { id } of sessionManager.findAllByRemoteUrl(url)) {
          if (id === repo?.warmSessionId) continue; // already fully deleted above
          const current = sessionManager.get(id);
          if (!current || current.warm || current.userArchived) continue;
          await archiveSession(
            sessionManager,
            deps.runnerRegistry,
            deps.getSharedRepoDir,
            id,
            deps.pruneSessionVolumes,
            deps.containerManager,
            deps.removeSessionLogs,
          );
        }
        removeRepo(deps.repoStore, url);
        deps.sseBroadcast("session_list", { sessions: sessionManager.list() });
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

  // POST /api/repos/:url/claim-session — claim a warm session for a repo.
  // Thin wrapper around `claimSessionService.claim` — same path used by the
  // agent-spawned-sessions route below, so both surfaces produce identical
  // workspaces (warm pool, branch off freshly-fetched origin/main).
  app.post<{ Params: { url: string } }>(
    "/api/repos/:url/claim-session",
    async (request, reply) => {
      const url = decodeURIComponent(request.params.url);
      try {
        const result = await claimSessionService.claim(url, {
          isCancelled: () => request.raw.destroyed,
        });
        return {
          sessionId: result.sessionId,
          // `sessionDir` is kept as a back-compat alias for the field name the
          // client still types — see `src/client/stores/repo-store.ts`. The
          // value is the workspace directory either way.
          sessionDir: result.workspaceDir,
          workspaceDir: result.workspaceDir,
          fetchDurationMs: result.fetchDurationMs,
        };
      } catch (err) {
        if (err instanceof ClaimAbortedError) {
          // Caller already hung up — no point sending a response.
          return;
        }
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to claim session: ${getErrorMessage(err)}` });
      }
    },
  );
}
