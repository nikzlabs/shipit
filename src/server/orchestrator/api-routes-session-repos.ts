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
import { stopWarmPreview } from "./warm-preview.js";
import { buildSystemNotice } from "./chat-card-persistence.js";
import type { WsServerMessage } from "../shared/types.js";

function cancelAgentMergeRequests(deps: ApiDeps, id: string): void {
  if (!id || !deps.agentMergeClaims) return;
  // Persist inside the cancellation transaction; broadcast only after commit.
  const pending: { sessionId: string; ws: WsServerMessage }[] = [];
  deps.agentMergeClaims.cancelPendingForRepo(id, (claim) => {
    const { ws, persisted } = buildSystemNotice(
      claim.sessionId,
      `Cancelled the merge request for pull request #${claim.prNumber}: agent merging was turned off `
      + "for this repository. Nothing was merged.",
      "info",
    );
    deps.chatHistoryManager.append(claim.sessionId, persisted);
    pending.push({ sessionId: claim.sessionId, ws });
  });
  for (const { sessionId, ws } of pending) {
    deps.runnerRegistry?.get(sessionId)?.emitMessage(ws);
  }
}

export async function registerSessionReposRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  const { sessionManager, createGitManager, createRepoGit } = deps;

  // Share the claim service: its per-repo lock lives in the instance's closure.
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
    ...(deps.egressAllowlistStore ? { egressAllowlistStore: deps.egressAllowlistStore } : {}),
  });

  app.get("/api/repos", async () => {
    return { repos: listRepos(deps.repoStore) };
  });

  app.post<{ Body: { url?: string; repoName?: string; templateId?: string; description?: string; isPrivate?: boolean; owner?: string } }>(
    "/api/repos",
    async (_request, reply) => {
      const body = _request.body;

      if (body.url) {
        try {
          const submittedCredential = hasUrlCredentials(body.url);
          const repo = addRepo(deps.repoStore, body.url);
          if (repo.status === "ready") {
            return { repo };
          }
          const repoUrl = repo.url;
          const cacheDir = deps.getSharedRepoDir(repoUrl);
          void (async () => {
            // eslint-disable-next-line no-restricted-syntax -- stat existence-check idiom
            const exists = await stat(cacheDir).then(() => true, () => false);
            try {
              if (!exists) {
                await mkdir(cacheDir, { recursive: true });
                const cacheGit = createRepoGit(cacheDir);
                await cacheGit.cloneBare(repoUrl);
                console.log("[repos] Cloned bare cache:", cacheDir);
              }
              deps.repoStore.setReady(repoUrl);
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
              // A failed clone leaves a directory that would make the next attempt skip cloning.
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

  app.post<{ Body: { url?: string } }>(
    "/api/repos/trust",
    async (request, reply) => {
      try {
        const url = request.body?.url?.trim();
        setRepoTrusted(deps.repoStore, url);
        deps.sseBroadcast("repo_list", { repos: listRepos(deps.repoStore) });
        // The runner registry includes claimed warm sessions that sessionManager.list omits.
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
        // Keep this route browser-only so agents cannot grant themselves merge permission.
        const allowAgentMerge = request.body?.allowAgentMerge;
        if (hidden === undefined && colorIndex === undefined && allowAgentMerge === undefined) {
          reply.code(400).send({
            error:
              "Request body must include a boolean 'hidden', a numeric 'colorIndex', or a boolean 'allowAgentMerge'",
          });
          return;
        }
        if (hidden !== undefined && typeof hidden !== "boolean") {
          reply.code(400).send({ error: "'hidden' must be a boolean" });
          return;
        }
        if (allowAgentMerge !== undefined && typeof allowAgentMerge !== "boolean") {
          reply.code(400).send({ error: "'allowAgentMerge' must be a boolean" });
          return;
        }
        if (colorIndex !== undefined) assertValidRepoColorIndex(colorIndex);
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
            reply.code(404).send({ error: "Repository not found" });
            return;
          }
          // Revoke before cancellation; the executor rechecks the grant if cancellation fails.
          if (!allowAgentMerge) cancelAgentMergeRequests(deps, repoId(url) ?? "");
        }
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

  app.delete<{ Params: { url: string } }>(
    "/api/repos/:url",
    async (request, reply) => {
      try {
        const url = decodeURIComponent(request.params.url);
        const repo = deps.repoStore.get(url);
        if (repo?.warmSessionId) {
          // Warm previews may have no runner; stop their manager before destroying containers.
          stopWarmPreview(deps.serviceManagers, repo.warmSessionId, deps.composeStopPromises);
          // destroy also cancels a standby still being created; do not gate on isStandby.
          await deps.containerManager?.destroy(repo.warmSessionId);
          const runner = deps.runnerRegistry.get(repo.warmSessionId);
          if (runner) runner.dispose({ force: true });
          deleteSession(sessionManager, repo.warmSessionId, deps.chatHistoryManager, deps.usageManager, deps.removeSessionLogs, deps.presentStore);
        }
        for (const { id } of sessionManager.findAllByRemoteUrl(url)) {
          if (id === repo?.warmSessionId) continue;
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
            createGitManager,
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
          sessionDir: result.workspaceDir,
          workspaceDir: result.workspaceDir,
          fetchDurationMs: result.fetchDurationMs,
        };
      } catch (err) {
        if (err instanceof ClaimAbortedError) {
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
