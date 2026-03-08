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
  getWorkspaceState,
  gitRollback,
  setGitRemote,
  gitPush,
  gitPull,
  mergeSession,
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
}
