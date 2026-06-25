/**
 * Session CRUD / mutation API routes.
 * Handles: session status, list-all, create (headless), rename, pin/unpin,
 * pin-order, archive (delete), unarchive, template, fork.
 */

import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import { resolveSessionDir } from "./api-routes.js";

import {
  getSessionStatus,
  listAllSessions,
  unarchiveSession,
  renameSession,
  setSessionPinned,
  reorderSessionPins,
  archiveSession,
  applyTemplate,
  createSandboxSession,
  forkSession,
  createHeadlessSession,
  ServiceError,
  createClaimSessionService,
} from "./services/index.js";
import type { AgentId, IssueRef } from "../shared/types.js";
import { getErrorMessage } from "./validation.js";
import { markIssueStartedFromSeed } from "./issue-lifecycle.js";

export async function registerSessionCrudRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  const { sessionManager, createGitManager, createRepoGit } = deps;

  // One shared GraduateSessionDeps for every session-creation route — docs/156.
  // graduate-session.ts is the single source of truth; passing the same deps
  // bundle to every surface means a future caller can't silently miss one.
  const graduationDeps = {
    sessionManager,
    runnerRegistry: deps.runnerRegistry,
    repoStore: deps.repoStore,
    createGitManager,
    ...(deps.prStatusPoller ? { prStatusPoller: deps.prStatusPoller } : {}),
    sseBroadcast: deps.sseBroadcast,
    ...(deps.ensureAgentTokenFresh ? { ensureAgentTokenFresh: deps.ensureAgentTokenFresh } : {}),
  };

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

  // POST /api/sessions/:id/pin — pin (make persistent) a session
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/pin",
    async (request, reply) => {
      try {
        const { session, sessions } = setSessionPinned(sessionManager, request.params.id, true);
        deps.sseBroadcast("session_list", { sessions });
        return { session };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to pin session: ${getErrorMessage(err)}` });
      }
    },
  );

  // DELETE /api/sessions/:id/pin — unpin a session
  app.delete<{ Params: { id: string } }>(
    "/api/sessions/:id/pin",
    async (request, reply) => {
      try {
        const { session, sessions } = setSessionPinned(sessionManager, request.params.id, false);
        deps.sseBroadcast("session_list", { sessions });
        return { session };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to unpin session: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/sessions/pin-order — reorder a repo's pinned sessions (docs/110 Phase 2)
  app.post<{ Body: { remoteUrl: string; ids: string[] } }>(
    "/api/sessions/pin-order",
    async (request, reply) => {
      try {
        const { remoteUrl, ids } = request.body;
        const { sessions } = reorderSessionPins(sessionManager, remoteUrl, ids);
        deps.sseBroadcast("session_list", { sessions });
        return { sessions };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to reorder pins: ${getErrorMessage(err)}` });
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
          deps.containerManager,
          deps.removeSessionLogs,
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
  app.post<{ Params: { id: string }; Body: { templateId: string; targetSessionId?: string } }>(
    "/api/sessions/:id/template",
    async (request, reply) => {
      try {
        const result = await applyTemplate(
          sessionManager, createGitManager, deps.createSessionDir,
          request.body.templateId, request.params.id === "new" ? undefined : request.params.id,
          request.body.targetSessionId,
        );
        return { templateId: result.templateId, name: result.name, session: result.session, seedPrompt: result.seedPrompt };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to apply template: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/sessions/sandbox — docs/211: create a repo-less, capability-scoped
  // Sandbox session. `kind` and `capabilities` are stamped server-authoritatively
  // (the body's capabilities are normalized, never trusted as-is) before any
  // container boots, mirroring the ops kind gate. No clone, no remoteUrl.
  app.post<{ Body: { capabilities?: { git?: boolean; docker?: boolean; network?: boolean; dangerousGitHubOps?: boolean } } }>(
    "/api/sessions/sandbox",
    async (request, reply) => {
      try {
        const result = await createSandboxSession(
          sessionManager,
          deps.createSessionDir,
          request.body?.capabilities,
        );
        // Other viewers learn about the new session via the session-list SSE;
        // the creating client also calls refreshSessions() on the response.
        deps.sseBroadcast("session_list", { sessions: sessionManager.list() });
        return { session: result.session, capabilities: result.capabilities };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to create sandbox session: ${getErrorMessage(err)}` });
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
          request.body.branchName, request.body.startPoint, undefined,
          graduationDeps,
        );
        // session_list SSE broadcast is owned by graduateSession (docs/156).
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

  // POST /api/sessions/headless — quick-capture session creation.
  //
  // Accepts either JSON (no attachments) or multipart/form-data when the
  // overlay attached files. Multipart shape: `repoUrl`, `initialPrompt`,
  // `branch?`, `agent?`, `model?` as form fields plus one or more `file`
  // parts. Files are saved into the new session's uploads dir before the
  // first turn fires so the agent sees them. See docs/145.
  app.post<{
    Body: {
      repoUrl?: string;
      initialPrompt?: string;
      branch?: string;
      agent?: AgentId;
      model?: string;
      /**
       * docs/217 — per-session reasoning effort (Control B) for the first turn.
       * Multipart sends it as a string field; validated server-side against the
       * resolved agent's options in `createHeadlessSession`.
       */
      reasoning?: string;
      /**
       * docs/170 — when present, the new session is seeded from a tracker
       * issue (branch + title + first prompt derived from it). Sent by the
       * Issues tab's "Start session" row action. JSON path only.
       */
      issueRef?: IssueRef;
      /**
       * docs/175 — arm auto-merge for the new session at creation time
       * (per-session, never persisted). Multipart sends it as the string
       * "true"/"false".
       */
      armAutoMerge?: boolean;
    };
  }>(
    "/api/sessions/headless",
    async (request, reply) => {
      let repoUrl = "";
      let initialPrompt = "";
      let branch: string | undefined;
      let agent: AgentId | undefined;
      let model: string | undefined;
      let reasoning: string | undefined;
      let issueRef: IssueRef | undefined;
      let armAutoMerge = false;
      const uploadInputs: { filename: string; data: Buffer }[] = [];

      if (request.isMultipart()) {
        try {
          for await (const part of request.parts()) {
            if (part.type === "file") {
              const buf = await part.toBuffer();
              uploadInputs.push({ filename: part.filename, data: buf });
              continue;
            }
            const value = typeof part.value === "string" ? part.value : "";
            switch (part.fieldname) {
              case "repoUrl":
                repoUrl = value;
                break;
              case "initialPrompt":
                initialPrompt = value;
                break;
              case "branch":
                branch = value;
                break;
              case "agent":
                agent = value as AgentId;
                break;
              case "model":
                model = value;
                break;
              case "reasoning":
                reasoning = value;
                break;
              case "armAutoMerge":
                armAutoMerge = value === "true";
                break;
              default:
                break;
            }
          }
        } catch (err) {
          reply.code(400).send({ error: `Invalid multipart body: ${getErrorMessage(err)}` });
          return;
        }
      } else {
        const body = request.body ?? {};
        repoUrl = body.repoUrl ?? "";
        initialPrompt = body.initialPrompt ?? "";
        branch = body.branch;
        agent = body.agent;
        model = body.model;
        reasoning = body.reasoning;
        issueRef = body.issueRef;
        if (body.armAutoMerge !== undefined && typeof body.armAutoMerge !== "boolean") {
          reply.code(400).send({ error: "armAutoMerge must be a boolean" });
          return;
        }
        armAutoMerge = body.armAutoMerge === true;
      }

      try {
        const result = await createHeadlessSession(
          sessionManager,
          deps.runnerRegistry,
          claimSessionService,
          {
            repoUrl,
            prompt: initialPrompt,
            ...(issueRef !== undefined ? { issueRef } : {}),
            ...(branch !== undefined ? { branch } : {}),
            ...(agent !== undefined ? { agent } : {}),
            ...(model !== undefined ? { model } : {}),
            ...(reasoning !== undefined ? { reasoning } : {}),
            ...(uploadInputs.length > 0 ? { uploads: uploadInputs } : {}),
            armAutoMerge,
          },
          deps.defaultAgentId,
          deps.credentialsDir,
          deps.credentialStore,
          deps.providerAccountManager,
          graduationDeps,
          {
            githubAuthManager: deps.githubAuthManager,
            prStatusPoller: deps.prStatusPoller,
          },
        );
        // session_list SSE broadcast is owned by graduateSession (docs/156).

        // docs/194 — seed path → started. When the session was created *from* an
        // issue, fire the one-shot brokered `status started` from the pointer in
        // the creation payload (idempotent; the pointer is not persisted on the
        // session). Fire-and-forget so a slow tracker write doesn't delay the
        // creation response; the helper is fully best-effort.
        if (issueRef && deps.credentialStore && deps.chatHistoryManager) {
          const lifecycleDeps = {
            credentialStore: deps.credentialStore,
            ...(deps.trackerFetchImpl ? { trackerFetchImpl: deps.trackerFetchImpl } : {}),
            githubAuthManager: deps.githubAuthManager,
            sessionManager,
            chatHistoryManager: deps.chatHistoryManager,
            runnerRegistry: deps.runnerRegistry,
          };
          void markIssueStartedFromSeed(lifecycleDeps, result.sessionId, issueRef).catch(
            (err: unknown) => {
              console.warn("[api-routes-session] seed 'started' failed:", err);
            },
          );
        }

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
        reply.code(500).send({ error: `Couldn't start a session — try again: ${getErrorMessage(err)}` });
      }
    },
  );
}
