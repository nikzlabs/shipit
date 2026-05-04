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
  agentCreatePr,
  editPullRequest,
  commentOnPullRequest,
  markPrReady,
  closePullRequest,
  reopenPullRequest,
  viewPullRequest,
  listPullRequests,
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

  // POST /api/sessions/:id/pr/agent-create — agent-driven PR create (used by gh shim)
  app.post<{
    Params: { id: string };
    Body: {
      title?: string;
      body?: string;
      base?: string;
      draft?: boolean;
      fill?: boolean;
    };
  }>(
    "/api/sessions/:id/pr/agent-create",
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
        const result = await agentCreatePr(git, deps.githubAuthManager, {
          title: request.body?.title,
          body: request.body?.body,
          base: request.body?.base,
          draft: request.body?.draft,
          fill: request.body?.fill,
          sessionTitle: session.title,
          remoteUrl: session.remoteUrl,
        });
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

  // PATCH /api/sessions/:id/pr/:number — edit an existing PR
  app.patch<{
    Params: { id: string; number: string };
    Body: { title?: string; body?: string };
  }>(
    "/api/sessions/:id/pr/:number",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      const num = Number(request.params.number);
      if (!Number.isFinite(num) || num <= 0) {
        reply.code(400).send({ error: "Invalid PR number" });
        return;
      }
      try {
        const git = createGitManager(dir);
        const session = sessionManager.get(request.params.id);
        return await editPullRequest(git, deps.githubAuthManager, {
          number: num,
          title: request.body?.title,
          body: request.body?.body,
          remoteUrl: session?.remoteUrl,
        });
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to update PR: ${getErrorMessage(err)}` });
      }
    },
  );

  // GET /api/sessions/:id/pr/list?state=open — list PRs for the session's repo
  app.get<{ Params: { id: string }; Querystring: { state?: string } }>(
    "/api/sessions/:id/pr/list",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const git = createGitManager(dir);
        const session = sessionManager.get(request.params.id);
        const stateRaw = request.query.state;
        const state: "open" | "closed" | "all" =
          stateRaw === "closed" || stateRaw === "all" ? stateRaw : "open";
        const prs = await listPullRequests(git, deps.githubAuthManager, {
          state,
          remoteUrl: session?.remoteUrl,
        });
        return { prs };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to list PRs: ${getErrorMessage(err)}` });
      }
    },
  );

  // GET /api/sessions/:id/pr/view — view PR details (current branch's PR by default)
  // GET /api/sessions/:id/pr/view?number=N — view a specific PR
  app.get<{ Params: { id: string }; Querystring: { number?: string } }>(
    "/api/sessions/:id/pr/view",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const git = createGitManager(dir);
        const session = sessionManager.get(request.params.id);
        let num: number | undefined;
        if (request.query.number) {
          num = Number(request.query.number);
          if (!Number.isFinite(num) || num <= 0) {
            reply.code(400).send({ error: "Invalid PR number" });
            return;
          }
        }
        const pr = await viewPullRequest(git, deps.githubAuthManager, {
          number: num,
          remoteUrl: session?.remoteUrl,
        });
        return { pr };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to view PR: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/sessions/:id/pr/:number/comment — add a comment to a PR
  app.post<{
    Params: { id: string; number: string };
    Body: { body: string };
  }>(
    "/api/sessions/:id/pr/:number/comment",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      const num = Number(request.params.number);
      if (!Number.isFinite(num) || num <= 0) {
        reply.code(400).send({ error: "Invalid PR number" });
        return;
      }
      try {
        const git = createGitManager(dir);
        const session = sessionManager.get(request.params.id);
        return await commentOnPullRequest(git, deps.githubAuthManager, request.body?.body ?? "", {
          number: num,
          remoteUrl: session?.remoteUrl,
        });
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to comment: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/sessions/:id/pr/:number/ready — mark draft as ready for review
  app.post<{ Params: { id: string; number: string } }>(
    "/api/sessions/:id/pr/:number/ready",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      const num = Number(request.params.number);
      if (!Number.isFinite(num) || num <= 0) {
        reply.code(400).send({ error: "Invalid PR number" });
        return;
      }
      try {
        const git = createGitManager(dir);
        const session = sessionManager.get(request.params.id);
        return await markPrReady(git, deps.githubAuthManager, {
          number: num,
          remoteUrl: session?.remoteUrl,
        });
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to mark PR ready: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/sessions/:id/pr/:number/close — close a PR
  app.post<{ Params: { id: string; number: string } }>(
    "/api/sessions/:id/pr/:number/close",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      const num = Number(request.params.number);
      if (!Number.isFinite(num) || num <= 0) {
        reply.code(400).send({ error: "Invalid PR number" });
        return;
      }
      try {
        const git = createGitManager(dir);
        const session = sessionManager.get(request.params.id);
        return await closePullRequest(git, deps.githubAuthManager, {
          number: num,
          remoteUrl: session?.remoteUrl,
        });
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to close PR: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/sessions/:id/pr/:number/reopen — reopen a closed PR
  app.post<{ Params: { id: string; number: string } }>(
    "/api/sessions/:id/pr/:number/reopen",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      const num = Number(request.params.number);
      if (!Number.isFinite(num) || num <= 0) {
        reply.code(400).send({ error: "Invalid PR number" });
        return;
      }
      try {
        const git = createGitManager(dir);
        const session = sessionManager.get(request.params.id);
        return await reopenPullRequest(git, deps.githubAuthManager, {
          number: num,
          remoteUrl: session?.remoteUrl,
        });
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to reopen PR: ${getErrorMessage(err)}` });
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
        // Block merge if CI checks haven't registered yet. Two cases:
        //   (a) workflow files exist but no checks reported yet — poller has
        //       mutated state to "pending" with total === 0
        //   (b) the PR was just created and the poller hasn't run its first
        //       poll yet — getStatus returns undefined while the session is
        //       being tracked. We only enter this branch when the poller is
        //       tracking the session, which means a PR was just registered.
        const poller = deps.prStatusPoller;
        const session = sessionManager.get(request.params.id);
        if (poller && session?.remoteUrl) {
          const prStatus = poller.getStatus(request.params.id);
          if (!prStatus) {
            return { success: false, message: "Waiting for CI checks to start" };
          }
          if (prStatus.checks.state === "pending" && prStatus.checks.total === 0) {
            return { success: false, message: "Waiting for CI checks to start" };
          }
        }

        const git = createGitManager(dir);
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
