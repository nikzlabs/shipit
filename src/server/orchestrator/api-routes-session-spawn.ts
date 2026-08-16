/**
 * Agent-spawned child sessions + session-scoped reads.
 * Handles: history, usage, worktrees, present-content reads; spawn-child,
 * list-children, child view/wait, child message, child archive, notify-on-merge.
 */

import { randomUUID } from "node:crypto";
import { etagFor, matchesIfNoneMatch } from "./http-etag.js";
import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import { emitChatCard } from "./chat-card-persistence.js";
import { prepareShipitFixSpawn } from "./api-routes-shipit-fix.js";

import {
  getGitLog,
  getUsageStats,
  listWorktrees,
  getChatHistory,
  spawnChildSession,
  parseSpawnTarget,
  listSpawnedChildren,
  getSpawnedChild,
  sendChildMessage,
  ResolvedChildMessageError,
  waitForChildIdle,
  assertArchivableChild,
  registerMergeWatch,
  armSelfMergeWatch,
  cancelSelfMergeWatch,
  deliverSessionReport,
  resolveSessionCohort,
  archiveSession,
  DEFAULT_WAIT_FOR_CHILD_IDLE_MS,
  MAX_WAIT_FOR_CHILD_IDLE_MS,
  ServiceError,
  recordSpawnInvocation,
  classifySpawnFailure,
  createClaimSessionService,
  DEFAULT_MAX_SHIPIT_FIX_SESSIONS_PER_TURN,
} from "./services/index.js";
import type { AgentId } from "../shared/types.js";
import { getErrorMessage } from "./validation.js";

export async function registerSessionSpawnRoutes(
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
  });

  // ---- Session-scoped reads ----

  // GET /api/sessions/:id/history — read-only chat history + workspace data (no session activation)
  app.get<{ Params: { id: string } }>("/api/sessions/:id/history", async (request, reply) => {
    const session = sessionManager.get(request.params.id);
    if (!session) {
      reply.code(404).send({ error: "Session not found" });
      return;
    }
    const messages = getChatHistory(deps.chatHistoryManager, request.params.id) as unknown as Record<string, unknown>[];

    let commits: Awaited<ReturnType<typeof getGitLog>> = [];
    if (session.workspaceDir) {
      try {
        const git = createGitManager(session.workspaceDir);
        commits = await getGitLog(git);
      } catch {
        // No git repo — empty log
      }
    }
    // planning#375 — the workspace file tree used to ride along here. It is
    // 325 KB of this repository's 2.67 MB payload (2,847 files), it has nothing
    // to do with chat history, and it changes on a completely different cadence
    // — so re-sending it with every transcript change was pure waste. The
    // client seeds it from the dedicated `GET /api/sessions/:id/files` instead.

    const runner = deps.runnerRegistry.get(request.params.id);
    const agentRunning = runner?.running ?? false;
    // docs/235 — the standing background-task list, so a session loaded purely
    // from HTTP history (session switch, page reload) knows it is *waiting*
    // rather than idle. `background_tasks` is emit-only live state: it is
    // buffered into the turn-event log, which the next turn start clears, so a
    // switch into a between-turns session with outstanding work has nothing to
    // replay and would otherwise hydrate as finished.
    // planning#246 — the UNION, so a session switched into while a brokered
    // `shipit agent run` consult is in flight hydrates as *waiting* too. The
    // CLI's task list alone cannot see a consult: it outlives its parent turn,
    // needs no resident streaming process, and Codex reports no tasks at all.
    const backgroundTasks = runner?.backgroundWorkDescriptions ?? [];
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

    // docs/093 — durable Present-tab metadata so the tab rehydrates on session
    // load even if the WS `present_state` replay is missed (or the runner isn't
    // active yet). Metadata only; bytes fetch lazily as today. Hydrate is
    // idempotent by presentId, so this and the WS replay can't double-render.
    const presentations = deps.presentStore?.listForClient(request.params.id) ?? [];

    const payload = {
      messages,
      commits,
      agentRunning,
      backgroundTasks,
      rewindSnapshot,
      turnUsage,
      sessionUsage,
      cumulativeInputTokens: tokenTotals?.cumulativeInputTokens,
      cumulativeOutputTokens: tokenTotals?.cumulativeOutputTokens,
      presentations,
    };

    // planning#375 — revalidate instead of re-download. Switching between
    // sessions is constant, and this response is megabytes on a long one.
    //
    // The tag is the hash of the BODY, not a composed version stamp, and that
    // is the point: the payload is assembled from seven independent sources
    // (chat rows, git log, runner state, background tasks, usage, presentations,
    // rewind snapshot), so a stamp that forgets one serves a stale transcript.
    // Hashing what is about to be sent cannot be wrong. It saves the transfer
    // and the client's parse, not the server-side build.
    const body = JSON.stringify(payload);
    const etag = etagFor(body);
    // Weak comparison, per RFC 9110 — Cloudflare re-compresses and hands the
    // browser `W/"…"`, which is what comes back. See `http-etag.ts`.
    if (matchesIfNoneMatch(request.headers["if-none-match"], etag)) {
      reply.code(304).send();
      return;
    }
    // `no-cache` = revalidate every time, never serve blind from the browser's
    // own cache. A stale transcript is worse than a round trip.
    reply.header("etag", etag).header("cache-control", "no-cache").type("application/json");
    return reply.send(body);
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

  // GET /api/sessions/:id/present/:presentId/content — fetch a presentation's
  // raw bytes on demand (docs/093). The worker holds only metadata; this proxies
  // a one-time disk read and returns `{ content, mimeType }`, retaining nothing.
  // Authenticated session API (not the public preview proxy), so the Present tab
  // renders byte-for-byte while artifacts stay off any routable URL.
  app.get<{
    Params: { id: string; presentId: string };
  }>("/api/sessions/:id/present/:presentId/content", async (request, reply) => {
    const session = sessionManager.get(request.params.id);
    if (!session) {
      reply.code(404).send({ error: "Session not found" });
      return;
    }
    const runner = deps.runnerRegistry.get(request.params.id);
    if (!runner) {
      reply.code(404).send({ error: "Session is not active" });
      return;
    }
    const proxy = runner as { proxyPresentRaw?: (id: string) => Promise<unknown> };
    if (typeof proxy.proxyPresentRaw !== "function") {
      reply.code(501).send({ error: "Present content is not supported on this runner" });
      return;
    }
    try {
      const result = await proxy.proxyPresentRaw(request.params.presentId) as {
        content: string;
        mimeType: string;
      };
      reply.header("Cache-Control", "no-store");
      return result;
    } catch (err) {
      const message = getErrorMessage(err);
      // The worker 404s when the id is unknown or the file is gone from disk;
      // surface that as a 404 so the client can show "no longer available".
      if (/not found|no longer on disk/i.test(message)) {
        reply.code(404).send({ error: message });
        return;
      }
      reply.code(500).send({ error: `Failed to fetch presentation: ${message}` });
    }
  });

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

  // POST /api/sessions/:parentId/spawn — agent-driven session spawn
  //
  // docs/264 phase 3 (req 16) — the target half of the body is now the SAME
  // vocabulary the one-shot spawn takes, read by the SAME parser
  // (`parseSpawnTarget`), with one difference stated as a flag: `parentBase:
  // true`, because a child has a parent to complete a partial call from and a
  // one-shot run does not. `agent`/`model` remain accepted as the shim has sent
  // them since docs/117 and are folded into the same shape.
  app.post<{
    Params: { parentId: string };
    Body: {
      prompt?: string;
      title?: string;
      agent?: AgentId;
      model?: string;
      // docs/264 — the shared target vocabulary: a role ± overrides, or all five.
      role?: string;
      agentId?: string;
      serviceId?: string;
      billingMode?: string;
      modelId?: string;
      reasoningEffort?: string;
      spawnedByTurn?: string;
      // docs/205 — spawn a completely separate (parentless) session instead of
      // a child: no linkage, no sidebar nesting, no coordination, no chat card.
      detached?: boolean;
      // docs/162 — Ops-only "fix ShipIt itself" target.
      shipitSource?: boolean;
      approximateSource?: boolean;
    };
  }>(
    "/api/sessions/:parentId/spawn",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const body = request.body ?? {};
      // Effective agent id — same precedence the spawn service uses
      // (`opts.agent ?? parent.agentId ?? defaultAgentId`). Captured here so
      // the telemetry record always carries an `agent` dimension, even when
      // the request fails before `spawnChildSession` reaches its own
      // resolution.
      // docs/264 — `agentId` is the wire name the shared vocabulary uses, and
      // `agent` is what a shim predating it sends; reading only the latter would
      // file every role-era spawn under the parent's harness and quietly hollow
      // out this dimension.
      const parentAgentId = sessionManager.get(request.params.parentId)?.agentId;
      const effectiveAgentId =
        ((body.agentId ?? body.agent) as AgentId | undefined) ?? parentAgentId ?? deps.defaultAgentId;
      try {
        // docs/162 — when `--shipit-source` is set, the child targets the
        // ShipIt source repo (not the parent's repo) and is pinned to the exact
        // inspected build commit. Resolve the target, verify push access,
        // register the repo, and seed an incident packet — all before
        // spawnChildSession does any disk work. An ordinary fan-out spawn falls
        // straight through to the unmodified prompt + undefined overrides.
        const { effectivePrompt, sourceBase, repoUrlOverride, shipitFixMeta } =
          await prepareShipitFixSpawn(deps, request.params.parentId, body);

        // docs/264 req 16 — one parser, one refusal rule, both commands. The
        // legacy `agent`/`model` keys are read as overrides so a shim that
        // predates the target sends the same shape; `parentBase: true` is the one
        // difference from `agent run`, and it is what keeps the shipped partial
        // form (`--model X`, everything else from the parent) legal here.
        // Presence, never truthiness: a parameter the caller sent EMPTY is one it
        // tried to name, and swallowing it here would spawn the child off the
        // bare role or the bare inheritance — the dropped override req 10
        // forbids, and the refusal `parseSpawnTarget` owns. `??` is the right
        // join for the legacy aliases even so: it falls through only on
        // `null`/`undefined`, so an explicitly empty `agentId` still beats a
        // populated `agent`.
        const aliasedAgentId = body.agentId ?? body.agent;
        const aliasedModelId = body.modelId ?? body.model;
        const target = parseSpawnTarget(
          {
            ...(body.role !== undefined ? { role: body.role } : {}),
            ...(aliasedAgentId !== undefined ? { agentId: aliasedAgentId } : {}),
            ...(body.serviceId !== undefined ? { serviceId: body.serviceId } : {}),
            ...(body.billingMode !== undefined ? { billingMode: body.billingMode } : {}),
            ...(aliasedModelId !== undefined ? { modelId: aliasedModelId } : {}),
            ...(body.reasoningEffort !== undefined ? { reasoningEffort: body.reasoningEffort } : {}),
          },
          { parentBase: true },
        );

        const result = await spawnChildSession(
          sessionManager,
          deps.runnerRegistry,
          claimSessionService,
          request.params.parentId,
          {
            prompt: effectivePrompt,
            ...(body.title !== undefined ? { title: body.title } : {}),
            ...(sourceBase !== undefined ? { base: sourceBase } : {}),
            target,
            ...(body.spawnedByTurn !== undefined ? { spawnedByTurn: body.spawnedByTurn } : {}),
            ...(body.detached ? { detached: true } : {}),
            ...(repoUrlOverride !== undefined ? { repoUrlOverride } : {}),
            // docs/162 — fix-session spawns get their own per-turn cap, sized
            // for an Ops investigation that legitimately finds several
            // independent defects in one pass. Only bites when a turn id is
            // supplied to count against.
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
        // via a `session_spawned` event, recorded in-band with the spawning
        // turn so it survives a session switch / full reload (not just a WS
        // reconnect). The agent ran `shipit session create` as a tool call, so
        // the card lands at its true transcript position; `emitChatCard`
        // persists the in-progress turn immediately (docs/191), so it's durable
        // the instant it fires rather than at the next tool-result boundary.
        // docs/205 — a `--detached` spawn emits NO card: it is meant to be a
        // completely separate session the parent never hears about again. The
        // agent still sees the spawn result on the shim's stdout.
        const parentRunner = body.detached ? undefined : deps.runnerRegistry.get(request.params.parentId);
        if (parentRunner) {
          const spawnedSession = {
            childSessionId: result.sessionId,
            title: result.session.title,
            ...(result.branch ? { branch: result.branch } : {}),
            spawnedAt: result.session.createdAt,
            ...(shipitFixMeta ? { shipitFix: shipitFixMeta } : {}),
          };
          emitChatCard(
            parentRunner,
            { type: "session_spawned", sessionId: request.params.parentId, ...spawnedSession },
            { role: "assistant", text: "", spawnedSession },
            { chatHistoryManager: deps.chatHistoryManager, sessionId: request.params.parentId },
          );
        }

        recordSpawnInvocation({
          parentSessionId: request.params.parentId,
          ...(body.spawnedByTurn ? { spawnedByTurn: body.spawnedByTurn } : {}),
          // docs/264 — the harness the child ACTUALLY got, which a role decides
          // and the request cannot state. `effectiveAgentId` is resolved before
          // the spawn so a FAILURE still carries the dimension, but on success a
          // role-started child would otherwise be filed under the parent's
          // harness — telemetry claiming Claude drove a spawn Codex is driving.
          // Cross-agent review found this.
          agentId: result.agentId,
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
        // Recorded in-band like the success card so it survives reload — and
        // unlike a successful spawn there is NO sidebar row to fall back on, so
        // persistence is the only record of the failure. `id` is generated for
        // live-append idempotency (a failure has no natural key).
        // docs/205 — a `--detached` spawn stays silent on failure too (the
        // parent session is meant never to hear about it); the agent gets the
        // error on the shim's non-zero exit + stderr and handles it itself.
        const parentRunner = body.detached ? undefined : deps.runnerRegistry.get(request.params.parentId);
        if (parentRunner) {
          const promptPreview = (body.prompt ?? "")
            .trim()
            .split(/\r?\n/)[0]
            .slice(0, 200);
          const spawnFailed = {
            id: `spawn-failed-${randomUUID()}`,
            message: errorMessage,
            statusCode,
            reason: classifySpawnFailure(statusCode, errorMessage),
            ...(body.title ? { title: body.title } : {}),
            ...(promptPreview ? { promptPreview } : {}),
            ...(body.shipitSource ? { shipitSource: true } : {}),
            failedAt: new Date().toISOString(),
          };
          emitChatCard(
            parentRunner,
            { type: "session_spawn_failed", sessionId: request.params.parentId, ...spawnFailed },
            { role: "assistant", text: "", spawnFailed },
            { chatHistoryManager: deps.chatHistoryManager, sessionId: request.params.parentId },
          );
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
    { config: { containerAccessible: true } },
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
    { config: { containerAccessible: true } },
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
    { config: { containerAccessible: true } },
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
        if (err instanceof ResolvedChildMessageError) {
          reply.code(409).send({
            error: err.message,
            sessionId: err.child.id,
            title: err.child.title,
            reason: "resolved",
            delivered: false,
          });
          return;
        }
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
    { config: { containerAccessible: true } },
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
          deps.removeSessionLogs,
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

  // POST /api/sessions/:parentId/children/:childId/notify-on-merge — docs/196.
  // Arms an async watch: when the child's PR reaches a terminal state, the
  // orchestrator enqueues a self-describing system turn into THIS parent's
  // message queue and surfaces a merge card. Non-blocking — returns immediately
  // ("watch armed"); the actual firing is event-driven off the PR poller.
  app.post<{
    Params: { parentId: string; childId: string };
  }>(
    "/api/sessions/:parentId/children/:childId/notify-on-merge",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      try {
        const result = registerMergeWatch(
          sessionManager,
          request.params.parentId,
          request.params.childId,
        );
        // Register-time backstop: if the child's PR ALREADY resolved before the
        // watch was armed, the poller won't re-observe it — fire now. Off the
        // response path so the shim still returns immediately.
        if (deps.mergeWatchManager) {
          void deps.mergeWatchManager.checkAndFireNow(request.params.childId).catch((err: unknown) => {
            console.error(`[merge-watch] register-time check failed for ${request.params.childId}:`, err);
          });
        }
        return { armed: true, state: result.state, alreadyArmed: result.alreadyArmed };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to register merge watch: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/sessions/:sessionId/notify-on-merge-self — docs/239.
  // `shipit session notify-on-merge --self`: arm a watch that wakes THIS session
  // with a turn when its OWN PR merges. Own-session scoped like every other
  // container-reachable route (the worker injects the caller's id), and there is
  // no payload — the session's transcript already holds the plan.
  app.post<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/notify-on-merge-self",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      try {
        const result = await armSelfMergeWatch(
          {
            sessionManager,
            githubAuthManager: deps.githubAuthManager,
            createGitManager,
            runnerRegistry: deps.runnerRegistry,
            chatHistoryManager: deps.chatHistoryManager,
            ...(deps.mergeWatchManager ? { mergeWatchManager: deps.mergeWatchManager } : {}),
          },
          request.params.sessionId,
        );
        return { armed: true, ...result };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to arm self merge-watch: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/sessions/:sessionId/notify-on-merge-self/cancel — docs/239.
  // The arm card's Cancel. Browser-only (deliberately NOT containerAccessible):
  // the agent re-arms rather than cancels. `watchId` is required and compared, so
  // a stale card from an earlier chain link can't cancel the current watch.
  app.post<{ Params: { sessionId: string }; Body: { watchId?: string } }>(
    "/api/sessions/:sessionId/notify-on-merge-self/cancel",
    async (request, reply) => {
      const watchId = request.body?.watchId;
      if (!watchId) {
        reply.code(400).send({ error: "watchId is required" });
        return;
      }
      try {
        return cancelSelfMergeWatch(
          {
            sessionManager,
            ...(deps.mergeWatchManager ? { mergeWatchManager: deps.mergeWatchManager } : {}),
          },
          request.params.sessionId,
          watchId,
        );
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to cancel self merge-watch: ${getErrorMessage(err)}` });
      }
    },
  );

  // ===========================================================================
  // Upward / lateral session reports (docs/233, planning#243)
  //
  // The counterpart to the parent→child routes above: these two are called with
  // the REPORTING session's own id (the worker injects it), so a child can at
  // last resolve its own cohort and push a finding to its parent + siblings.
  // Every recipient is derived server-side from `parentSessionId` — there is no
  // agent-supplied target — so a report can only travel inside the tree the
  // parent already coordinates.
  // ===========================================================================

  // GET /api/sessions/:sessionId/cohort — self + parent + siblings + children.
  // Backs `shipit session whoami`, and fixes the dead end where a child asking
  // for its own id got "not a descendant of this parent" from the child routes.
  app.get<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/cohort",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      try {
        return resolveSessionCohort(
          sessionManager,
          deps.runnerRegistry,
          request.params.sessionId,
          childProjections,
        );
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to resolve session cohort: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/sessions/:sessionId/report — push a report up to the parent (or
  // across the whole cohort). Each recipient gets a persisted card AND a queued
  // system turn, so the report is pushed rather than waiting to be pulled.
  app.post<{
    Params: { sessionId: string };
    Body: { body?: string; subject?: string; severity?: string; to?: string };
  }>(
    "/api/sessions/:sessionId/report",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const payload = request.body ?? {};
      try {
        const result = await deliverSessionReport(
          {
            sessionManager,
            runnerRegistry: deps.runnerRegistry,
            chatHistoryManager: deps.chatHistoryManager,
            defaultAgentId: deps.defaultAgentId,
            credentialsDir: deps.credentialsDir,
            credentialStore: deps.credentialStore,
            providerAccountManager: deps.providerAccountManager,
            containerManager: deps.containerManager,
          },
          request.params.sessionId,
          {
            body: payload.body ?? "",
            ...(payload.subject !== undefined ? { subject: payload.subject } : {}),
            ...(payload.severity !== undefined ? { severity: payload.severity } : {}),
            ...(payload.to !== undefined ? { to: payload.to } : {}),
          },
        );
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to deliver session report: ${getErrorMessage(err)}` });
      }
    },
  );
}
