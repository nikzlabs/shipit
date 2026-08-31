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
  renameSessionByAgent,
  setSessionPinned,
  setKeepPreviewRunning,
  setSessionMuted,
  reorderSessionPins,
  archiveSession,
  applyTemplate,
  createSandboxSession,
  readSandboxCapabilities,
  updateSandboxCapabilities,
  forkSession,
  forkReportSinks,
  gitRemoteCredentialResolver,
  createHeadlessSession,
  ServiceError,
  createClaimSessionService,
} from "./services/index.js";
import type { AgentId, IssueRef } from "../shared/types.js";
import type { BillingMode } from "../shared/catalogue/index.js";
import { getErrorMessage } from "./validation.js";
import { markIssueStartedFromSeed } from "./issue-lifecycle.js";
import { dismissNonTurnFailure } from "./services/non-turn-work.js";
import { reconcileSessionEgress } from "./services/reconcile-session-egress.js";

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
    // docs/150 — so AI naming runs on the account a turn would use, not the
    // singleton root (which aliases to the migrated default account).
    providerAccountManager: deps.providerAccountManager,
    ...(deps.credentialsDir ? { credentialsDir: deps.credentialsDir } : {}),
    // docs/252 phase 7 (req 9) — naming runs on the model chosen for non-turn
    // work, records what it spent, and surfaces a durable notice when it fails.
    credentialStore: deps.credentialStore,
    chatHistoryManager: deps.chatHistoryManager,
    usageManager: deps.usageManager,
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
    // docs/285 req 8 — the reuse path would hand an abandoned `/new` draft back
    // as a NEW session, so it has to see whether that draft carries a network
    // override and refuse to recycle it if so.
    ...(deps.egressAllowlistStore ? { egressAllowlistStore: deps.egressAllowlistStore } : {}),
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
          // Dropping the previous PR — snapshot AND merge record — is part of
          // the unarchive itself, not a step the route performs afterwards.
          // Threading the poller in is what keeps the two halves from drifting
          // apart again (`clearPriorPrState` in services/session.ts).
          deps.prStatusPoller,
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

  // POST /api/sessions/:id/non-turn-failure/:cardId/dismiss — docs/252 phase 7
  // (req 9). Dismissal is a PATCH of the persisted card, never a delete: the
  // row is the record that the failure happened, and losing it on acknowledge
  // would make "I read this" and "it never happened" the same state after a
  // reload.
  app.post<{ Params: { id: string; cardId: string } }>(
    "/api/sessions/:id/non-turn-failure/:cardId/dismiss",
    async (request, reply) => {
      if (!deps.chatHistoryManager) {
        reply.code(503).send({ error: "Chat history is unavailable" });
        return;
      }
      const dismissed = dismissNonTurnFailure(
        {
          getRunnerRegistry: () => deps.runnerRegistry,
          chatHistoryManager: deps.chatHistoryManager,
        },
        request.params.id,
        request.params.cardId,
      );
      if (!dismissed) {
        reply.code(404).send({ error: "No such notice in this session" });
        return;
      }
      return { dismissed: true };
    },
  );

  // PATCH /api/sessions/:id — rename session (the sidebar's hand rename).
  // docs/250 — this is what locks the title against the agent and the AI namer.
  app.patch<{ Params: { id: string }; Body: { title: string } }>(
    "/api/sessions/:id",
    async (request, reply) => {
      try {
        const session = renameSession(sessionManager, request.params.id, request.body.title);
        // docs/250 — broadcast so EVERY viewer's sidebar updates, not just the
        // renaming tab. This route previously relied on the calling client's own
        // optimistic store update, which left other tabs on the stale title until
        // they reloaded. Invisible while the only renamer was the user in the tab
        // doing the renaming; the agent path has no client to be optimistic.
        deps.sseBroadcast("session_renamed", { session });
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

  // POST /api/sessions/:id/rename — docs/250. `shipit session rename`: the agent
  // retitles its OWN session so the sidebar keeps describing what the session is
  // about past its first PR. Own-session scoped like every other
  // container-reachable route (the worker injects the caller's id, so an agent
  // can never name another session here). Separate from the PATCH above because
  // the two differ in provenance and precedence: this one records `agent` and
  // refuses when the user has renamed by hand.
  app.post<{ Params: { id: string }; Body: { title?: string } }>(
    "/api/sessions/:id/rename",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      try {
        return renameSessionByAgent(
          {
            sessionManager,
            runnerRegistry: deps.runnerRegistry,
            chatHistoryManager: deps.chatHistoryManager,
            sseBroadcast: deps.sseBroadcast,
          },
          request.params.id,
          request.body?.title,
        );
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

  // PUT /api/sessions/:id/keep-preview-running — docs/241 reservation toggle.
  app.put<{ Params: { id: string }; Body: { enabled?: unknown } }>(
    "/api/sessions/:id/keep-preview-running",
    async (request, reply) => {
      try {
        if (typeof request.body?.enabled !== "boolean") {
          throw new ServiceError(400, "enabled must be a boolean");
        }
        const result = setKeepPreviewRunning(
          sessionManager,
          request.params.id,
          request.body.enabled,
          (session) => {
            if (!session.workspaceDir) throw new ServiceError(409, "Session has no workspace to preview");
            if (session.diskTier === "light") sessionManager.setDiskTier(session.id, "hot");
            deps.runnerRegistry.getOrCreate(
              session.id,
              session.workspaceDir,
              session.agentId ?? deps.defaultAgentId,
            );
          },
        );
        deps.sseBroadcast("session_list", { sessions: result.sessions });
        return { session: result.session };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to update preview reservation: ${getErrorMessage(err)}` });
      }
    },
  );

  // PUT /api/sessions/:id/muted — docs/277 mute toggle. The runner answers
  // req 6's server-side half ("its agent is not working"): a running turn, a
  // turn held at a permission prompt, or outstanding background work all mean
  // the session will speak again on its own and so cannot be muted.
  app.put<{ Params: { id: string }; Body: { muted?: unknown } }>(
    "/api/sessions/:id/muted",
    async (request, reply) => {
      try {
        if (typeof request.body?.muted !== "boolean") {
          throw new ServiceError(400, "muted must be a boolean");
        }
        const runner = deps.runnerRegistry.get(request.params.id);
        const agentWorking = !!runner
          && (runner.running
            || runner.awaitingPermissionIds.size > 0
            || runner.backgroundWorkDescriptions.length > 0);
        const result = setSessionMuted(
          sessionManager,
          request.params.id,
          request.body.muted,
          agentWorking,
        );
        deps.sseBroadcast("session_list", { sessions: result.sessions });
        return { session: result.session };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to update session mute: ${getErrorMessage(err)}` });
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

  // GET/PUT /api/sessions/:id/capabilities — docs/279: read and edit a sandbox
  // session's capability grants after creation.
  //
  // Registered here, with the browser-facing session routes, and with NO
  // `containerAccessible` flag. That is deliberate and load-bearing: docs/211
  // made `capabilities` un-self-elevatable by making it immutable, so once it is
  // writable, "only the browser can reach this route" IS requirement 4's
  // guarantee. The same reason the egress settings routes are browser-only.
  const sessionSettingsDeps = () => ({
    sessionManager,
    runnerRegistry: deps.runnerRegistry,
    chatHistoryManager: deps.chatHistoryManager,
    ...(deps.containerManager ? { containerManager: deps.containerManager } : {}),
    sseBroadcast: deps.sseBroadcast,
  });

  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/capabilities",
    async (request, reply) => {
      try {
        return readSandboxCapabilities(sessionSettingsDeps(), request.params.id);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to read capabilities: ${getErrorMessage(err)}` });
      }
    },
  );

  app.put<{ Params: { id: string }; Body: { capabilities?: unknown } }>(
    "/api/sessions/:id/capabilities",
    async (request, reply) => {
      try {
        return updateSandboxCapabilities(
          sessionSettingsDeps(),
          request.params.id,
          request.body?.capabilities,
        );
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to update capabilities: ${getErrorMessage(err)}` });
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
          // planning#426 — the fork's `fetch origin` and `git lfs pull` run on a
          // session workspace with dropped uid, so they need a credential of their
          // own; and a fork whose LFS content did not resolve must say so rather
          // than present as complete.
          gitRemoteCredentialResolver(deps.githubAuthManager),
          forkReportSinks({ sessionManager, sseBroadcast: deps.sseBroadcast }),
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
  // `agent?`, `model?` as form fields plus one or more `file` parts. Files are
  // saved into the new session's uploads dir before the first turn fires so the
  // agent sees them. See docs/145.
  //
  // There is deliberately no `branch` field (planning#413). A caller-supplied
  // name is used verbatim, so two calls carrying one name land on a single
  // remote branch — the collision this route's issue seed was just fixed to
  // make impossible. Nothing in ShipIt sent one, and `child-sessions.ts` had
  // already dropped the same option from agent-driven spawns for a second
  // reason: supplied names drifted outside the `shipit/` namespace. The branch
  // is now always derived here — from the issue pointer, or generated.
  app.post<{
    Body: {
      repoUrl?: string;
      initialPrompt?: string;
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
      /**
       * docs/252 — the rest of the selected model's identity. A bare `model`
       * cannot say which service is billing you once two of them offer the same
       * id, and Quick Capture's seed (the browser's `vibe-model-id` slot) holds
       * the full triple. Ignored unless the pair names a real catalogue row.
       */
      serviceId?: string;
      billingMode?: BillingMode;
      /**
       * docs/272-user-selectable-roles reqs 1, 11 — the role the user picked in the overlay.
       * Resolved server-side and applied OVER the five fields above, which
       * describe controls the role replaced. Refused by name when it is unknown,
       * reserved, or cannot run (req 8 — nothing is ever substituted).
       */
      role?: string;
      /**
       * docs/144 — the prompt was dictated by voice (quick-capture Mode B), so
       * the first turn's prompt carries the `<dictated_input>` hint. Multipart
       * sends it as the string "true"/"false".
       */
      dictated?: boolean;
      /**
       * docs/285 reqs 2, 3 — the network mode picked in the Quick Capture
       * composer, in force from this session's first turn. `true` = Contained,
       * `false` = Open, `null` = inherit the workspace setting. Absent means the
       * user did not touch the control, which is the same outcome as `null` and
       * is what req 8 makes the default for every new session. Multipart sends
       * it as `"contained"` / `"open"` / `"inherit"`.
       */
      networkMode?: boolean | null;
    };
  }>(
    "/api/sessions/headless",
    async (request, reply) => {
      let repoUrl = "";
      let initialPrompt = "";
      let agent: AgentId | undefined;
      let model: string | undefined;
      let serviceId: string | undefined;
      let billingMode: BillingMode | undefined;
      let reasoning: string | undefined;
      let role: string | undefined;
      let issueRef: IssueRef | undefined;
      let armAutoMerge = false;
      let dictated = false;
      /**
       * docs/285 req 2 — the network mode picked in the Quick Capture composer.
       * `undefined` means the user did not touch it, which req 8 makes the
       * default for every new session; `null` is an explicit "inherit workspace".
       */
      let networkMode: boolean | null | undefined;
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
              case "agent":
                agent = value as AgentId;
                break;
              case "model":
                model = value;
                break;
              case "serviceId":
                serviceId = value;
                break;
              case "billingMode":
                if (value === "sub" || value === "key") billingMode = value;
                break;
              case "reasoning":
                reasoning = value;
                break;
              case "role":
                role = value;
                break;
              case "armAutoMerge":
                armAutoMerge = value === "true";
                break;
              case "dictated":
                dictated = value === "true";
                break;
              case "networkMode":
                // The client's multipart serializer stringifies every non-string
                // field (`String(v)`), so this arrives in the same "true"/"false"
                // shape `armAutoMerge` and `dictated` do — matched here rather
                // than given a private vocabulary the generic serializer could
                // never produce. Anything else leaves it untouched, which is the
                // inherit default rather than a silent Open.
                if (value === "true") networkMode = true;
                else if (value === "false") networkMode = false;
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
        agent = body.agent;
        model = body.model;
        serviceId = body.serviceId;
        billingMode = body.billingMode;
        reasoning = body.reasoning;
        role = body.role;
        issueRef = body.issueRef;
        if (body.armAutoMerge !== undefined && typeof body.armAutoMerge !== "boolean") {
          reply.code(400).send({ error: "armAutoMerge must be a boolean" });
          return;
        }
        armAutoMerge = body.armAutoMerge === true;
        if (body.dictated !== undefined && typeof body.dictated !== "boolean") {
          reply.code(400).send({ error: "dictated must be a boolean" });
          return;
        }
        dictated = body.dictated === true;
        if (
          body.networkMode !== undefined
          && body.networkMode !== null
          && typeof body.networkMode !== "boolean"
        ) {
          reply.code(400).send({ error: "networkMode must be true, false, or null" });
          return;
        }
        networkMode = body.networkMode;
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
            ...(agent !== undefined ? { agent } : {}),
            ...(model !== undefined ? { model } : {}),
            ...(serviceId !== undefined ? { serviceId } : {}),
            ...(billingMode !== undefined ? { billingMode } : {}),
            ...(reasoning !== undefined ? { reasoning } : {}),
            ...(role !== undefined && role !== "" ? { role } : {}),
            ...(uploadInputs.length > 0 ? { uploads: uploadInputs } : {}),
            armAutoMerge,
            ...(dictated ? { dictated: true } : {}),
            ...(networkMode !== undefined ? { networkMode } : {}),
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
          // docs/285 — only when this runtime has an egress store to write to;
          // without one there is no override to honour and the field is ignored.
          deps.egressAllowlistStore
            ? {
                store: deps.egressAllowlistStore,
                reconcile: (sid, reconcileOpts) => reconcileSessionEgress(
                  {
                    containerManager: deps.containerManager ?? null,
                    egressAllowlistStore: deps.egressAllowlistStore,
                    ...(deps.oomBreaker ? { oomBreaker: deps.oomBreaker } : {}),
                    recovery: {
                      sessionManager,
                      containerManager: deps.containerManager ?? null,
                      runnerRegistry: deps.runnerRegistry,
                      defaultAgentId: deps.defaultAgentId,
                      ...(deps.oomBreaker ? { oomBreaker: deps.oomBreaker } : {}),
                      ...(deps.loopDetector ? { loopDetector: deps.loopDetector } : {}),
                      sseBroadcast: deps.sseBroadcast,
                    },
                  },
                  sid,
                  reconcileOpts ?? {},
                ),
              }
            : undefined,
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
