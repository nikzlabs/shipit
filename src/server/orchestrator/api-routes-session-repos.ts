/**
 * Repo management API routes.
 * Handles: repo list, add (existing) / create-with-template, trust, reorder,
 * remove, claim-session.
 */

import { mkdir, rm, stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";

import {
  listRepos,
  addRepo,
  removeRepo,
  reorderRepos,
  setRepoTrusted,
  setRepoHidden,
  setRepoColorIndex,
  assertValidRepoColorIndex,
  createRepoWithTemplate,
  deleteSession,
  archiveSession,
  ServiceError,
  createClaimSessionService,
  ClaimAbortedError,
  refreshRepoDefaultBranch,
} from "./services/index.js";
import { canonicalRepoKey, hasUrlCredentials, repoId } from "./git-utils.js";
import { getErrorMessage } from "./validation.js";
import { persistNoticeUnattached } from "./chat-card-persistence.js";

/**
 * docs/288 req 4 — cancel every merge request for a repository whose grant was
 * just withdrawn, and tell each session why in its own transcript. Matched on
 * {@link repoId}, the identity the grant itself is matched on, so every URL
 * spelling of that repository is covered.
 */
function cancelAgentMergeRequests(deps: ApiDeps, id: string): void {
  if (!id || !deps.agentMergeClaims) return;
  // The notice rides the delete's transaction: a request the user cancelled
  // must not vanish leaving no record of why (req 3's guarantee, req 4's case).
  deps.agentMergeClaims.cancelPendingForRepo(id, (claim) => {
    persistNoticeUnattached(
      deps.chatHistoryManager,
      claim.sessionId,
      `Cancelled the merge request for pull request #${claim.prNumber}: agent merging was turned off `
      + "for this repository. Nothing was merged.",
      "info",
    );
  });
}

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
    // docs/285 req 8 — the reuse path would hand an abandoned `/new` draft back
    // as a NEW session, so it has to see whether that draft carries a network
    // override and refuse to recycle it if so.
    ...(deps.egressAllowlistStore ? { egressAllowlistStore: deps.egressAllowlistStore } : {}),
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
          // docs/262 req 19 — a credential typed into the URL is dropped, never
          // stored, so this add may be the first time this repository is fetched
          // WITHOUT it. Remembered here (before `addRepo` strips it) so that if
          // the clone then fails, the user is told why in ShipIt rather than
          // being left with git's generic auth error while the explanation sits
          // in the orchestrator's stdout, which is not a ShipIt surface (§1/§2).
          const submittedCredential = hasUrlCredentials(body.url);
          const repo = addRepo(deps.repoStore, body.url);
          if (repo.status === "ready") {
            return { repo };
          }
          // Clone bare cache in background
          const repoUrl = repo.url;
          const cacheDir = deps.getSharedRepoDir(repoUrl);
          void (async () => {
            // eslint-disable-next-line no-restricted-syntax -- stat existence-check idiom
            const exists = await stat(cacheDir).then(() => true, () => false);
            try {
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
              // Read the remote's real default branch off the freshly-cloned
              // bare cache (`git clone --bare` points HEAD at it) so the UI can
              // name the actual base branch instead of assuming `main`.
              await refreshRepoDefaultBranch(
                { repoStore: deps.repoStore, createRepoGit, getBareCacheDir: deps.getSharedRepoDir },
                repoUrl,
              );
              deps.sseBroadcast("repo_status", { url: repoUrl, status: "ready" });
              deps.sseBroadcast("repo_list", { repos: listRepos(deps.repoStore) });
              const warmFn = deps.warmSessionForRepo;
              if (warmFn) await warmFn(repoUrl);
            } catch (err) {
              console.error("[repos] Background clone failed:", getErrorMessage(err));
              // Drop the half-written cache we just created. `git clone --bare`
              // leaves the directory behind on failure, and the existence check
              // above is the ONLY guard on the clone — so a retry (the user
              // pressing Add again, or the dogfood seed on the next boot) would
              // skip cloning, call `setReady`, and publish a repo whose bare
              // cache is empty. Every session claimed from it then clones from
              // nothing. Only remove a directory this call created: a
              // concurrent add that already has a good cache must not lose it.
              if (!exists) {
                await rm(cacheDir, { recursive: true, force: true }).catch((rmErr: unknown) => {
                  console.error("[repos] Could not remove failed cache:", getErrorMessage(rmErr));
                });
              }
              const credentialNote = submittedCredential
                ? " — the credential in the URL you entered is not stored, so this clone ran without it."
                  + " Connect the GitHub account (or App installation) that can read this repository and add it again."
                : "";
              deps.sseBroadcast("error", {
                message: `Failed to clone repository: ${getErrorMessage(err)}${credentialNote}`,
              });
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
        //
        // Enumerate the runner registry, NOT `sessionManager.list()`: a
        // just-claimed session stays warm (`warm = 1`) until its first turn
        // graduates it, and `list()` filters out warm sessions (`WHERE warm =
        // 0`). The session the user is *looking at* right after adding the repo
        // is exactly that ungraduated warm one, so iterating `list()` skips it
        // and its deferred install/compose never re-runs — leaving an empty
        // preview that only a brand-new session recovers from. Any session with
        // a live runner is "open" and may have setup to resume; sessions
        // without a runner get fresh (now-trusted) setup on their next
        // activation, so they need no nudge here. (docs/178)
        const key = canonicalRepoKey(url!);
        for (const sessionId of deps.runnerRegistry.ids()) {
          const session = sessionManager.get(sessionId);
          if (session?.remoteUrl && canonicalRepoKey(session.remoteUrl) === key) {
            const runner = deps.runnerRegistry.get(sessionId) as
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

  // PATCH /api/repos/:url — hide or show a repo in the sidebar (docs/222).
  // A pure visibility toggle: unlike DELETE it archives nothing and reclaims no
  // disk — sessions, containers, working copies and history all survive, so the
  // repo can be brought back instantly. Registered before DELETE for the same
  // readability reason as the order route above (distinct HTTP methods, so no
  // actual routing conflict).
  // docs/254 — the same route also carries `colorIndex`, the repo's identity
  // color for the sidebar's group edge. Both fields are optional and independent
  // (each applied only when present), so the client can PATCH either one; a body
  // carrying neither is the 400 below rather than a silent no-op.
  app.patch<{
    Params: { url: string };
    Body: { hidden?: boolean; colorIndex?: number; allowAgentMerge?: boolean };
  }>(
    "/api/repos/:url",
    async (request, reply) => {
      try {
        const url = decodeURIComponent(request.params.url);
        const hidden = request.body?.hidden;
        const colorIndex = request.body?.colorIndex;
        // docs/287 — the grant rides this route rather than getting its own, so
        // it inherits the browser-only boundary: no `containerAccessible` opt-in
        // is what keeps the permission out of reach of the agent it governs.
        const allowAgentMerge = request.body?.allowAgentMerge;
        if (hidden === undefined && colorIndex === undefined && allowAgentMerge === undefined) {
          reply.code(400).send({
            error:
              "Request body must include a boolean 'hidden', a numeric 'colorIndex', or a boolean 'allowAgentMerge'",
          });
          return;
        }
        // A field that is PRESENT but malformed is an error, never a silent
        // skip: `{colorIndex: 2, hidden: "yes"}` must not quietly apply half the
        // request and report success. Both fields are validated BEFORE either is
        // written, so a rejected body leaves the row entirely untouched rather
        // than committing the first update and throwing on the second.
        if (hidden !== undefined && typeof hidden !== "boolean") {
          reply.code(400).send({ error: "'hidden' must be a boolean" });
          return;
        }
        if (allowAgentMerge !== undefined && typeof allowAgentMerge !== "boolean") {
          reply.code(400).send({ error: "'allowAgentMerge' must be a boolean" });
          return;
        }
        if (colorIndex !== undefined) assertValidRepoColorIndex(colorIndex);
        // docs/287 — checked HERE, before ANY field is written: doing it at the
        // write let `{hidden: true, allowAgentMerge: true}` on a GitLab remote
        // hide the repository and THEN answer 400. The error does not quote the
        // url back, which may carry `user:password@`.
        if (allowAgentMerge !== undefined) {
          const id = repoId(url);
          if (!id) {
            reply.code(400).send({
              error: "Cannot set agent-merge permission: that remote is not a recognised GitHub repository.",
            });
            return;
          }
        }
        if (colorIndex !== undefined) setRepoColorIndex(deps.repoStore, url, colorIndex);
        if (hidden !== undefined) setRepoHidden(deps.repoStore, url, hidden);
        if (allowAgentMerge !== undefined) {
          const result = deps.repoStore.setAllowAgentMerge(url, allowAgentMerge);
          if (result === "not-found") {
            // The same 404 every other setter on this route gives for a
            // repository ShipIt does not hold — never a 200 that wrote nothing.
            reply.code(404).send({ error: "Repository not found" });
            return;
          }
          // docs/288 req 4 — withdrawing the permission cancels every request
          // that has not merged. Only `pending` rows: a row past it is being
          // settled or resolved from its tuple and can no longer merge anything.
          //
          // AFTER the flag, and deliberately not in one transaction with it: the
          // executor re-checks the grant at `pending → merging`, so a crash in
          // between leaves a row that refuses itself rather than one that merges.
          if (!allowAgentMerge) cancelAgentMergeRequests(deps, repoId(url) ?? "");
        }
        // Broadcast so every connected tab updates its sidebar immediately —
        // same pattern as add/remove/reorder.
        deps.sseBroadcast("repo_list", { repos: listRepos(deps.repoStore) });
        return { repo: deps.repoStore.get(url) ?? null };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to update repo: ${getErrorMessage(err)}` });
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
          // Unconditional, deliberately. `isStandby` only becomes true once
          // `createStandby` RETURNS, so gating on it skipped teardown for
          // exactly the window where a standby is still being built — the
          // creation then finished, added a deleted session to the standby set,
          // and started pre-installing into it. `destroy` is what cancels an
          // in-flight create (it bumps the teardown counter before its own
          // "nothing to destroy" return), and this session is being deleted on
          // the next line either way, so there is nothing to preserve.
          await deps.containerManager?.destroy(repo.warmSessionId);
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
