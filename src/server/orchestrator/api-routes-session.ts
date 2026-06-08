/**
 * Session management API routes.
 * Handles: session CRUD, switching, renaming, status, history, usage,
 * siblings, fork, template, repos, claim-session.
 */

import { mkdir, stat } from "node:fs/promises";
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
  reorderRepos,
  setRepoTrusted,
  createRepoWithTemplate,
  spawnChildSession,
  createHeadlessSession,
  listSpawnedChildren,
  getSpawnedChild,
  sendChildMessage,
  waitForChildIdle,
  assertArchivableChild,
  DEFAULT_WAIT_FOR_CHILD_IDLE_MS,
  MAX_WAIT_FOR_CHILD_IDLE_MS,
  ServiceError,
  createClaimSessionService,
  ClaimAbortedError,
  recordSpawnInvocation,
  classifySpawnFailure,
  resolveShipitFixTarget,
  ensureShipitSourceRepoReady,
  buildShipitFixPrompt,
  DEFAULT_MAX_SHIPIT_FIX_SESSIONS_PER_TURN,
} from "./services/index.js";
import { ensureBareCache } from "./repo-git.js";
import { parseGitHubRemote, canonicalRepoKey } from "./git-utils.js";
import type { AgentId, IssueRef } from "../shared/types.js";
import { getErrorMessage } from "./validation.js";

export async function registerSessionRoutes(
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

  // Single shared claim service for both the HTTP claim-session route and
  // the agent-driven spawn route. The per-repo promise chain lives in the
  // factory's closure, so callers MUST share this instance for the
  // serialization to actually guard concurrent operations on the bare cache.
  const claimSessionService = createClaimSessionService({
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
    const rewindSnapshot = deps.chatHistoryManager.latestRewindSnapshot(request.params.id);

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
      rewindSnapshot,
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

  // POST /api/sessions/:id/present/save — copy a buffered presentation
  // (docs/093) to the workspace. The bytes live only in the session worker's
  // in-memory PresentBuffer; we proxy through to the worker which performs
  // the byte-exact copy and lets the file watcher + auto-commit pipeline pick
  // it up. Client-driven (not agent-mediated) because after context
  // compaction or several turns the agent may not have the exact bytes any
  // more — save must match what the user saw.
  app.post<{
    Params: { id: string };
    Body: { presentId?: string; destPath?: string };
  }>("/api/sessions/:id/present/save", async (request, reply) => {
    const session = sessionManager.get(request.params.id);
    if (!session) {
      reply.code(404).send({ error: "Session not found" });
      return;
    }
    const { presentId, destPath } = request.body ?? {};
    if (typeof presentId !== "string" || !presentId) {
      reply.code(400).send({ error: "presentId is required" });
      return;
    }
    if (typeof destPath !== "string" || !destPath) {
      reply.code(400).send({ error: "destPath is required" });
      return;
    }
    const runner = deps.runnerRegistry.get(request.params.id);
    if (!runner) {
      reply.code(404).send({ error: "Session is not active" });
      return;
    }
    const proxy = runner as { proxyPresentSave?: (id: string, path: string) => Promise<unknown> };
    if (typeof proxy.proxyPresentSave !== "function") {
      reply.code(501).send({ error: "Present save is not supported on this runner" });
      return;
    }
    try {
      const result = await proxy.proxyPresentSave(presentId, destPath) as {
        ok?: boolean;
        savedPath?: string;
        error?: string;
      };
      if (result.ok === false || result.error) {
        reply.code(400).send({ error: result.error ?? "Save failed" });
        return;
      }
      return { ok: true, savedPath: result.savedPath };
    } catch (err) {
      reply.code(500).send({ error: `Failed to save presentation: ${getErrorMessage(err)}` });
    }
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
          deps.containerManager,
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

  // POST /api/sessions/:parentId/spawn — agent-driven session spawn
  app.post<{
    Params: { parentId: string };
    Body: {
      prompt?: string;
      title?: string;
      agent?: AgentId;
      model?: string;
      spawnedByTurn?: string;
      // docs/162 — Ops-only "fix ShipIt itself" target.
      shipitSource?: boolean;
      approximateSource?: boolean;
    };
  }>(
    "/api/sessions/:parentId/spawn",
    async (request, reply) => {
      const body = request.body ?? {};
      // Effective agent id — same precedence the spawn service uses
      // (`opts.agent ?? parent.agentId ?? defaultAgentId`). Captured here so
      // the telemetry record always carries an `agent` dimension, even when
      // the request fails before `spawnChildSession` reaches its own
      // resolution.
      const parentAgentId = sessionManager.get(request.params.parentId)?.agentId;
      const effectiveAgentId = body.agent ?? parentAgentId ?? deps.defaultAgentId;
      try {
        // docs/162 — when `--shipit-source` is set, the child targets the
        // ShipIt source repo (not the parent's repo) and is pinned to the
        // exact commit the Ops agent inspected. Resolve the target, verify the
        // user can push, register the repo, and seed an incident packet —
        // all before spawnChildSession does any disk work.
        let effectivePrompt = body.prompt ?? "";
        // The only `base` ShipIt honors is the Ops `--shipit-source` pin to the
        // exact inspected build commit (set below). There is no agent-facing
        // `--base`: generic fan-out children always branch off the parent
        // repo's freshly-fetched `origin/main`, so a just-merged design doc is
        // visible to the child by construction.
        let sourceBase: string | undefined;
        let repoUrlOverride: string | undefined;
        // docs/162 — metadata for the Ops remediation card, captured here so the
        // `session_spawned` emit below can render the "ShipIt fix" variant
        // (source ref, target repo, diagnosis summary). Undefined for ordinary
        // fan-out spawns.
        let shipitFixMeta:
          | {
              sourceRef: string;
              sourceExact: boolean;
              refSource?: "build-id" | "checkout-head";
              targetRepo?: string;
              diagnosis?: string;
            }
          | undefined;
        if (body.shipitSource) {
          const parent = sessionManager.get(request.params.parentId);
          if (!parent) throw new ServiceError(404, "Parent session not found");
          if (parent.kind !== "ops") {
            throw new ServiceError(403, "--shipit-source is only available in Ops sessions.");
          }
          if (!(effectivePrompt ?? "").trim()) {
            throw new ServiceError(400, "A diagnosis prompt is required to spawn a ShipIt fix session.");
          }
          // The diagnosis is rewritten into a verbose incident packet below, so
          // it can't double as the session name (every fix session would read
          // `# Ops remediation — ShipIt fix session`). Require the Ops agent to
          // name the session explicitly so the sidebar identifies the fix.
          if (!(body.title ?? "").trim()) {
            throw new ServiceError(
              400,
              "A session title is required when spawning a ShipIt fix session (pass --title). " +
                "Give it a short, human-readable name describing the fix.",
            );
          }
          const target = await resolveShipitFixTarget(body.approximateSource === true);
          const parsed = parseGitHubRemote(target.repoUrl);
          if (!parsed) {
            throw new ServiceError(400, `Could not parse the ShipIt source remote: ${target.repoUrl}`);
          }
          const access = await deps.githubAuthManager.checkRepoWriteAccess(parsed.owner, parsed.repo);
          if (!access.canWrite) {
            throw new ServiceError(
              403,
              `Cannot open a fix PR against ${parsed.owner}/${parsed.repo}: ${access.reason ?? "no write access"}. ` +
                "File the diagnosis as a redacted bug report instead — call the `report_shipit_bug` tool " +
                "with your root-cause summary, suspected files, and the redacted Docker/journal evidence. " +
                "ShipIt posts a consent card the operator confirms before it opens an issue on the upstream " +
                "repo under their own GitHub identity (docs/164).",
            );
          }
          // The child clones/pushes with the connected GitHub account
          // credential injected at git-operation time (the same token
          // `checkRepoWriteAccess` just validated), so the override URL must be
          // credential-free. `ensureShipitSourceRepoReady` returns the
          // credential-free store key — reuse it verbatim so the claim resolves
          // the same repo entry. Baking the source checkout's embedded PAT into
          // the URL would make the child push with a *different* credential than
          // the one verified above (BUG 2).
          const readyRepoUrl = await ensureShipitSourceRepoReady(target.repoUrl, {
            repoStore: deps.repoStore,
            getSharedRepoDir: deps.getSharedRepoDir,
            ensureBareCache: (cacheDir, url) => ensureBareCache(cacheDir, url, deps.createRepoGit),
          });
          repoUrlOverride = readyRepoUrl;
          sourceBase = target.ref;
          // Capture the diagnosis summary BEFORE wrapping it in the incident
          // packet — the card shows the agent's own first line, not the packet
          // header.
          const diagnosisSummary = (body.prompt ?? "").trim().split(/\r?\n/)[0]?.slice(0, 200);
          shipitFixMeta = {
            sourceRef: target.ref,
            sourceExact: target.exact,
            ...(target.refSource ? { refSource: target.refSource } : {}),
            targetRepo: `${parsed.owner}/${parsed.repo}`,
            ...(diagnosisSummary ? { diagnosis: diagnosisSummary } : {}),
          };
          effectivePrompt = buildShipitFixPrompt({
            ref: target.ref,
            exact: target.exact,
            parentSessionId: request.params.parentId,
            diagnosis: effectivePrompt,
          });
        }

        const result = await spawnChildSession(
          sessionManager,
          deps.runnerRegistry,
          claimSessionService,
          request.params.parentId,
          {
            prompt: effectivePrompt,
            ...(body.title !== undefined ? { title: body.title } : {}),
            ...(sourceBase !== undefined ? { base: sourceBase } : {}),
            ...(body.agent !== undefined ? { agent: body.agent } : {}),
            ...(body.model !== undefined ? { model: body.model } : {}),
            ...(body.spawnedByTurn !== undefined ? { spawnedByTurn: body.spawnedByTurn } : {}),
            ...(repoUrlOverride !== undefined ? { repoUrlOverride } : {}),
            // docs/162 — fix-session spawns get a lower per-turn cap than
            // generic fan-out children (they each claim the ShipIt repo and
            // open a PR). Only bites when a turn id is supplied to count against.
            ...(body.shipitSource
              ? { maxSpawnedSessionsPerTurn: DEFAULT_MAX_SHIPIT_FIX_SESSIONS_PER_TURN }
              : {}),
          },
          deps.defaultAgentId,
          deps.credentialsDir,
          deps.credentialStore,
          deps.providerAccountManager,
          graduationDeps,
        );
        // session_list SSE broadcast is owned by graduateSession (docs/156).

        // docs/117 Phase 2 — surface the spawn inline in the parent's chat
        // via a `session_spawned` event. Routed through the parent runner's
        // `emitMessage` so every attached viewer sees it AND it lands in the
        // turn-event buffer (so a viewer that reconnects mid-turn sees the
        // card too). The child shows up in the sidebar regardless via the
        // session_list broadcast above; this event is the in-chat affordance.
        const parentRunner = deps.runnerRegistry.get(request.params.parentId);
        if (parentRunner) {
          parentRunner.emitMessage({
            type: "session_spawned",
            sessionId: request.params.parentId,
            childSessionId: result.sessionId,
            title: result.session.title,
            ...(result.branch ? { branch: result.branch } : {}),
            spawnedAt: result.session.createdAt,
            ...(shipitFixMeta ? { shipitFix: shipitFixMeta } : {}),
          });
        }

        recordSpawnInvocation({
          parentSessionId: request.params.parentId,
          ...(body.spawnedByTurn ? { spawnedByTurn: body.spawnedByTurn } : {}),
          agentId: effectiveAgentId,
          outcome: "success",
          statusCode: 200,
          childSessionId: result.sessionId,
        });

        return {
          sessionId: result.sessionId,
          branch: result.branch,
          status: "running" as const,
          session: result.session,
        };
      } catch (err) {
        const statusCode = err instanceof ServiceError ? err.statusCode : 500;
        const errorMessage = err instanceof ServiceError
          ? err.message
          : `Failed to spawn child session: ${getErrorMessage(err)}`;

        // docs/117 cross-cutting follow-up — surface the failure inline in the
        // parent's chat alongside successful spawns. Without this, a quota
        // rejection only shows up on the shim's stderr (visible to the agent
        // but not to the user) — the success-path card has no counterpart.
        // Same `emitMessage` route as `session_spawned` so reconnecting
        // viewers see it via the turn-event buffer.
        const parentRunner = deps.runnerRegistry.get(request.params.parentId);
        if (parentRunner) {
          const promptPreview = (body.prompt ?? "")
            .trim()
            .split(/\r?\n/)[0]
            .slice(0, 200);
          parentRunner.emitMessage({
            type: "session_spawn_failed",
            sessionId: request.params.parentId,
            message: errorMessage,
            statusCode,
            reason: classifySpawnFailure(statusCode, errorMessage),
            ...(body.title ? { title: body.title } : {}),
            ...(promptPreview ? { promptPreview } : {}),
            ...(body.shipitSource ? { shipitSource: true } : {}),
            failedAt: new Date().toISOString(),
          });
        }

        recordSpawnInvocation({
          parentSessionId: request.params.parentId,
          ...(body.spawnedByTurn ? { spawnedByTurn: body.spawnedByTurn } : {}),
          agentId: effectiveAgentId,
          outcome: classifySpawnFailure(statusCode, errorMessage),
          statusCode,
          errorMessage,
        });

        reply.code(statusCode).send({ error: errorMessage });
      }
    },
  );

  // Projections passed to listSpawnedChildren / getSpawnedChild / waitForChildIdle
  // so the `view` snapshot can include the child's latest assistant text and PR
  // URL. Phase 3 (docs/117) — Phase 1 omitted these deliberately; the agent now
  // has follow-up surfaces (`wait`, `message`) that benefit from seeing them.
  const childProjections = {
    chatHistoryManager: deps.chatHistoryManager,
    prStatusPoller: deps.prStatusPoller,
  };

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
        childProjections,
      );
      return { children };
    },
  );

  // GET /api/sessions/:parentId/children/:childId[?wait=true&timeout=N&segment=S]
  //
  // Without `wait` — returns the snapshot.
  // With `wait=true` — resolves the child's readiness. `timeout` (seconds,
  // clamped to MAX_WAIT_FOR_CHILD_IDLE_MS) is the overall cap. `segment`
  // (seconds, docs/182) bounds a single server poll: when set and the child is
  // still running after `segment`, the route returns 200 with
  // `{ outcome: "pending" }` ("poll again") instead of holding the socket open
  // for the full `timeout` — so a reset costs one retried segment, not the wait.
  // Without `segment` it behaves as the legacy single long-poll. The response
  // always includes the child snapshot and a machine-readable `outcome`
  // (idle / error / archived / pending / timed-out); `idle` / `timedOut` are
  // retained for back-compat.
  app.get<{
    Params: { parentId: string; childId: string };
    Querystring: { wait?: string; timeout?: string; segment?: string };
  }>(
    "/api/sessions/:parentId/children/:childId",
    async (request, reply) => {
      try {
        if (request.query.wait === "true") {
          const requestedTimeoutSecs = Number(request.query.timeout);
          const timeoutMs = Number.isFinite(requestedTimeoutSecs) && requestedTimeoutSecs > 0
            ? Math.min(Math.floor(requestedTimeoutSecs * 1000), MAX_WAIT_FOR_CHILD_IDLE_MS)
            : DEFAULT_WAIT_FOR_CHILD_IDLE_MS;
          const requestedSegmentSecs = Number(request.query.segment);
          const segmentMs = Number.isFinite(requestedSegmentSecs) && requestedSegmentSecs > 0
            ? Math.min(Math.floor(requestedSegmentSecs * 1000), MAX_WAIT_FOR_CHILD_IDLE_MS)
            : undefined;
          const result = await waitForChildIdle(
            sessionManager,
            deps.runnerRegistry,
            request.params.parentId,
            request.params.childId,
            { timeoutMs, ...(segmentMs !== undefined ? { segmentMs } : {}), projections: childProjections },
          );
          return {
            child: result.child,
            idle: result.idle,
            timedOut: result.timedOut,
            pending: result.pending,
            outcome: result.outcome,
          };
        }
        const child = getSpawnedChild(
          sessionManager,
          deps.runnerRegistry,
          request.params.parentId,
          request.params.childId,
          childProjections,
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

  // POST /api/sessions/:parentId/children/:childId/message — Phase 3 follow-up
  // prompt. Routed via the `shipit session message` shim subcommand. The body
  // is a free-form user message; the orchestrator enqueues it on the child's
  // runner (or starts a turn directly when idle). Returns a queue position so
  // the shim can show "queued behind N turns" to the agent.
  app.post<{
    Params: { parentId: string; childId: string };
    Body: { text?: string };
  }>(
    "/api/sessions/:parentId/children/:childId/message",
    async (request, reply) => {
      try {
        const result = await sendChildMessage(
          sessionManager,
          deps.runnerRegistry,
          request.params.parentId,
          request.params.childId,
          request.body?.text ?? "",
          deps.defaultAgentId,
          deps.credentialsDir,
          deps.credentialStore,
          deps.providerAccountManager,
          deps.containerManager,
        );
        return { queuePosition: result.queuePosition, enqueued: result.enqueued };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to send child message: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/sessions/:parentId/children/:childId/archive — Phase 3 archive.
  // Only archives children the parent itself spawned, and refuses when the
  // child is still running. The actual archive work (workspace cleanup, cache
  // sweep, container disposal) reuses the existing `archiveSession` service.
  app.post<{
    Params: { parentId: string; childId: string };
  }>(
    "/api/sessions/:parentId/children/:childId/archive",
    async (request, reply) => {
      try {
        assertArchivableChild(
          sessionManager,
          deps.runnerRegistry,
          request.params.parentId,
          request.params.childId,
        );
        const result = await archiveSession(
          sessionManager,
          deps.runnerRegistry,
          deps.getSharedRepoDir,
          request.params.childId,
          deps.pruneSessionVolumes,
          deps.containerManager,
        );
        deps.sseBroadcast("session_list", { sessions: result.sessions });
        return { archived: true, sessions: result.sessions };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to archive child session: ${getErrorMessage(err)}` });
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
