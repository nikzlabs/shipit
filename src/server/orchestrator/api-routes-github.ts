/**
 * GitHub API routes.
 * Handles: GitHub repos search, PR status, PR CRUD, CI fix, auto-merge,
 * merge-method, GitHub token, GitHub logout.
 */

import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import { resolveSessionDir } from "./api-routes.js";

import {
  getPrStatus,
  searchGitHubRepos,
  createPullRequest,
  quickCreatePr,
  mergePullRequest,
  generatePrDescription,
  setGitHubToken,
  gitHubLogout,
  triggerCIFix,
  toggleAutoMerge,
  updateMergeMethod,
  ServiceError,
} from "./services/index.js";
import { getErrorMessage } from "./validation.js";

export async function registerGitHubRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  const { sessionManager, createGitManager } = deps;

  // ---- GitHub reads ----

  // GET /api/sessions/:id/pr/status — PR status
  app.get<{ Params: { id: string } }>("/api/sessions/:id/pr/status", async (request, reply) => {
    const dir = resolveSessionDir(sessionManager, request.params.id, reply);
    if (!dir) return;
    try {
      const git = createGitManager(dir);
      const session = sessionManager.get(request.params.id);
      return { pr: await getPrStatus(deps.githubAuthManager, git, session?.remoteUrl) };
    } catch (err) {
      reply.code(500).send({ error: `Failed to get PR status: ${getErrorMessage(err)}` });
    }
  });

  // GET /api/github/repos — search GitHub repos
  app.get<{ Querystring: { q?: string } }>("/api/github/repos", async (request) => {
    const query = request.query.q ?? "";
    return { repos: await searchGitHubRepos(deps.githubAuthManager, query) };
  });

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
          session.remoteUrl,
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
        const session = sessionManager.get(request.params.id);
        return await createPullRequest(
          git, deps.githubAuthManager,
          request.body.title, request.body.body, request.body.base, request.body.draft,
          session?.remoteUrl,
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
        // Block merge if CI checks haven't registered yet (workflow files exist but no checks reported)
        const prStatus = deps.prStatusPoller?.getStatus(request.params.id);
        if (prStatus?.checks.state === "pending" && prStatus.checks.total === 0) {
          return { success: false, message: "Waiting for CI checks to start" };
        }

        const git = createGitManager(dir);
        const session = sessionManager.get(request.params.id);
        return await mergePullRequest(git, deps.githubAuthManager, request.body?.method, session?.remoteUrl);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        return { success: false, message: `Merge failed: ${getErrorMessage(err)}` };
      }
    },
  );

  // POST /api/sessions/:id/pr/description — generate PR description via LLM
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/pr/description",
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

  // POST /api/sessions/:id/pr/auto-merge — toggle auto-merge on/off
  app.post<{ Params: { id: string }; Body: { enabled: boolean } }>(
    "/api/sessions/:id/pr/auto-merge",
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

        return await toggleAutoMerge(
          deps.githubAuthManager,
          deps.prStatusPoller,
          request.params.id,
          request.body.enabled,
        );
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Auto-merge toggle failed: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/sessions/:id/pr/merge-method — update preferred merge method
  app.post<{ Params: { id: string }; Body: { method: string } }>(
    "/api/sessions/:id/pr/merge-method",
    async (request, reply) => {
      try {
        if (!deps.prStatusPoller) {
          reply.code(500).send({ error: "PR status poller not available" });
          return;
        }
        const method = request.body?.method;
        if (method !== "squash" && method !== "merge" && method !== "rebase") {
          reply.code(400).send({ error: "\"method\" must be \"squash\", \"merge\", or \"rebase\"" });
          return;
        }

        return await updateMergeMethod(
          deps.githubAuthManager,
          deps.prStatusPoller,
          request.params.id,
          method,
        );
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Merge method update failed: ${getErrorMessage(err)}` });
      }
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

  // POST /api/activity/heartbeat — client reports it's active (keeps PR polling alive)
  app.post(
    "/api/activity/heartbeat",
    async (_request, reply) => {
      if (deps.prStatusPoller) {
        deps.prStatusPoller.recordClientActivity();
      }
      reply.code(204).send();
    },
  );
}
