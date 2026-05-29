/**
 * Git API routes.
 * Handles: git log, branches, remotes, commit, push, pull, diff, rollback, merge, workspace-state.
 */

import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import { resolveSessionDir } from "./api-routes.js";

import {
  getGitLog,
  getGitRemotes,
  getGitBranches,
  getTurnDiff,
  getDiffVsBranch,
  getWorkspaceState,
  gitRollback,
  setGitRemote,
  gitPush,
  gitPull,
  mergeSession,
  rebaseAbort,
  runRebaseFlow,
  ServiceError,
} from "./services/index.js";
import { getErrorMessage } from "./validation.js";

export async function registerGitRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  const { sessionManager, createGitManager } = deps;

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

  // GET /api/sessions/:id/git/diff-vs-branch — diff HEAD vs a base branch (for PR diffs)
  app.get<{ Params: { id: string }; Querystring: { base?: string } }>(
    "/api/sessions/:id/git/diff-vs-branch",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      const baseBranch = request.query.base || "main";
      try {
        const git = createGitManager(dir);
        return await getDiffVsBranch(git, baseBranch);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
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

  // POST /api/sessions/:id/git/merge — merge a branch into this session
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

  // POST /api/sessions/:id/git/rebase — rebase onto base branch (with agent-driven conflict resolution)
  app.post<{ Params: { id: string }; Body: { baseBranch: string } }>(
    "/api/sessions/:id/git/rebase",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      const baseBranch = request.body?.baseBranch;
      if (!baseBranch) {
        reply.code(400).send({ error: "baseBranch is required" });
        return;
      }

      const sessionId = request.params.id;
      const runner = deps.runnerRegistry.get(sessionId);
      if (!runner) {
        reply.code(404).send({ error: "No active session runner — start the session first" });
        return;
      }

      try {
        const git = createGitManager(dir);

        // Drive the entire flow asynchronously: emit WS events as it progresses
        // (rebase_started, rebase_conflicts, rebase_complete) and run the agent
        // resolution loop on conflicts. The HTTP response only signals that the
        // flow was started — the client tracks state via WS events.
        const flowPromise = runRebaseFlow(
          {
            git,
            githubAuthManager: deps.githubAuthManager,
            runner,
            sessionManager: deps.sessionManager,
            chatHistoryManager: deps.chatHistoryManager,
            usageManager: deps.usageManager,
            authManager: deps.authManager,
            agentFactory: deps.agentFactory,
            sseBroadcast: deps.sseBroadcast,
          },
          baseBranch,
        );

        // Don't await: respond immediately, but log async failures.
        flowPromise.catch((err: unknown) => {
          console.error(`[rebase] flow failed for session ${sessionId}:`, err);
          // Emit aborted (with the reason) so the UI both clears its progress
          // state and surfaces the failure — without `reason` the old code
          // silently bounced the banner from "in_progress" back to "idle" and
          // the user had no way to tell what went wrong.
          runner.emitMessage({ type: "rebase_aborted", reason: getErrorMessage(err) });
        });

        return { status: "started" };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Rebase failed: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/sessions/:id/git/rebase/abort — abort an in-progress rebase
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/git/rebase/abort",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        // Kill the agent if it's mid-resolution — otherwise the rebase driver
        // would resume and try to call `git rebase --continue` against a tree
        // that's already been aborted.
        const runner = deps.runnerRegistry.get(request.params.id);
        const agent = runner?.getAgent();
        if (agent) {
          agent.kill();
          if (runner) {
            runner.setAgent(null);
            runner.running = false;
          }
        }

        const git = createGitManager(dir);
        await rebaseAbort(git);
        if (runner) {
          runner.emitMessage({ type: "rebase_aborted" });
        }
        return { status: "aborted" };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Rebase abort failed: ${getErrorMessage(err)}` });
      }
    },
  );
}
