import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import fs from "node:fs/promises";
import Docker from "dockerode";
import type { AgentId } from "../shared/types.js";
import type { WsClientMessage, WsServerMessage, WsLogEntry } from "../shared/types.js";
import { getErrorMessage } from "./validation.js";
import { getGitIdentity } from "./git-config.js";
import { pushToOrigin } from "./git-utils.js";
import { isNonFastForwardError } from "./services/git.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import { registerPreviewProxy } from "./preview-proxy.js";
import type { ConnectionCtx, RunnerCtx, AppCtx } from "./ws-handlers/types.js";
import * as terminalHandlers from "./ws-handlers/terminal-handlers.js";
import * as miscHandlers from "./ws-handlers/misc-handlers.js";
import * as rollbackHandlers from "./ws-handlers/rollback-handlers.js";
import * as rewindHandlers from "./ws-handlers/rewind-handlers.js";
import * as sendMessageHandlers from "./ws-handlers/send-message.js";
import * as serviceHandlers from "./ws-handlers/service-handlers.js";
import type { ServiceManager } from "./service-manager.js";
import { registerApiRoutes } from "./api-routes.js";
import type { GitManager } from "../shared/git.js";

// ---- Sub-module imports ----
import type { AppDeps } from "./app-di.js";
import { initializeManagers } from "./app-di.js";
import { readDockerMemoryStats } from "./docker-memory.js";
import {
  setupContainerManager,
  buildRunnerFactory,
  createIdleEnforcer,
  createRunnerRegistry,
  createSSE,
  createPrStatusPoller,
  createLogBuffer,
  wireEventHandlers,
  createSessionDirFactory,
  createBareCacheDirHelper,
  createDepCacheDirHelper,
  createWarmPool,
  runRepoMigration,
  scheduleStartupTasks,
  setupContainerHealthMonitoring,
  registerShutdownHook,
  autoStart,
} from "./app-lifecycle.js";

// ---- Re-exports for backwards compatibility ----
export { CONTEXT_WINDOW_TOKENS } from "./ws-handlers/send-message.js";
export type { AppDeps } from "./app-di.js";
export { initializeManagers } from "./app-di.js";
export type { ManagerSet } from "./app-di.js";
export {
  setupContainerManager,
  buildRunnerFactory,
  createIdleEnforcer,
  createRunnerRegistry,
  createSSE,
  createPrStatusPoller,
  createLogBuffer,
  wireEventHandlers,
  createSessionDirFactory,
  createBareCacheDirHelper,
  createDepCacheDirHelper,
  createWarmPool,
  runRepoMigration,
  scheduleStartupTasks,
  setupContainerHealthMonitoring,
  registerShutdownHook,
  autoStart,
} from "./app-lifecycle.js";
export type {
  ContainerSetupDeps,
  ContainerSetupResult,
  RunnerFactoryDeps,
  IdleEnforcementDeps,
  RunnerRegistryDeps,
  SSEClient,
  PrPollerDeps,
  EventWiringDeps,
  SessionDirDeps,
  WarmPoolDeps,
  StartupDeps,
  ShutdownDeps,
} from "./app-lifecycle.js";

/**
 * Build and configure the Fastify app with all routes and WebSocket handlers.
 * Returns the app instance without starting it — call `app.listen()` separately.
 *
 * This separation enables integration testing: tests can call `buildApp({ ... })`
 * with mock dependencies, then use `app.inject()` or connect WebSocket clients
 * to the app without spawning real child processes.
 */
export async function buildApp(deps: AppDeps = {}): Promise<FastifyInstance> {
  // ---- DI: instantiate all managers ----
  const mgrs = await initializeManagers(deps);
  const {
    defaultAgentId, workspaceDir, credentialsDir, shouldServeStatic,
    autoPushDebounceMs, sessionsRoot, agentFactory,
    createGitManager, createRepoGit, databaseManager, sessionManager,
    repoStore, chatHistoryManager, usageManager, authManager,
    credentialStore, agentRegistry, githubAuthManager,
    secretStore, reviewStore, generateText,
    isTestMode,
  } = mgrs;

  const app = Fastify({ logger: false });

  await app.register(fastifyWebsocket);
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: 50 * 1024 * 1024, // 50 MB per file
      files: 20,                   // max 20 files per request
    },
  });

  // ---- CORS for dev (client on a different port) ----
  app.addHook("onRequest", (request, reply, done) => {
    const origin = request.headers.origin;
    if (origin) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Access-Control-Allow-Credentials", "true");
      reply.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
      reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }
    if (request.method === "OPTIONS") {
      reply.status(204).send();
      return;
    }
    done();
  });

  // ---- Container manager (Docker isolation) ----
  const { containerManager, dockerProxyServer } = await setupContainerManager({
    deps, isTestMode, credentialsDir, sessionManager,
  });

  // ---- Docker instance for memory stats ----
  const dockerForStats = containerManager ? new Docker() : null;

  // ---- Bare repo cache directory ----
  const getBareCacheDir = createBareCacheDirHelper(workspaceDir);
  const getDepCacheDir = createDepCacheDirHelper(workspaceDir);

  // ---- SSE (Server-Sent Events) ----
  const { sseClients, sseBroadcast } = createSSE();

  // ---- Log buffer ----
  const { getLogBuffer, clearLogBuffer, broadcastLog } = createLogBuffer();

  // ---- Runner factory ----
  const effectiveRunnerFactory = buildRunnerFactory({ deps, containerManager, credentialsDir });

  // ---- Service manager registry (per-session compose stacks) ----
  const serviceManagers = new Map<string, ServiceManager>();
  /** Per-session compose warnings/errors for configs without a ServiceManager (e.g. old format). */
  const composeWarnings = new Map<string, string>();
  /** Sessions where compose is not configured in shipit.yaml. */
  const composeNotConfigured = new Set<string>();

  // ---- Session runner registry ----
  // Idle enforcement uses a lazy reference to `runnerRegistry` — the callback
  // only fires when a runner goes idle (always after initialization).
  const registryHolder: { ref: SessionRunnerRegistry | null } = { ref: null };
  const enforceIdleContainerLimit = () => {
    if (registryHolder.ref) {
      createIdleEnforcer({ containerManager, credentialStore, runnerRegistry: registryHolder.ref })();
    }
  };

  const runnerRegistry = createRunnerRegistry({
    effectiveRunnerFactory, sessionManager, createGitManager,
    githubAuthManager, agentFactory, chatHistoryManager,
    autoPushDebounceMs, sseBroadcast, enforceIdleContainerLimit,
    getDepCacheDir, serviceManagers, composeWarnings, composeNotConfigured, containerManager,
  });
  registryHolder.ref = runnerRegistry;

  // ---- PR Status Poller ----
  const prStatusPoller = createPrStatusPoller({
    deps, githubAuthManager, sessionManager, sseBroadcast,
    runnerRegistry, createRepoGit, getBareCacheDir,
  });

  // ---- Event wiring (deployment + auth) ----
  wireEventHandlers({
    authManager, agentRegistry,
    defaultAgentId, broadcastLog, sseBroadcast,
  });

  // ---- Session directory creation ----
  const createSessionDir = createSessionDirFactory({
    sessionsRoot, sessionManager,
  });

  // ---- Warm session pool ----
  const { warmSessionForRepo, waitForWarmSession } = createWarmPool({
    repoStore, sessionManager, createRepoGit,
    githubAuthManager, credentialStore, containerManager,
    credentialsDir, getBareCacheDir, getDepCacheDir, createSessionDir, sseBroadcast,
  });

  // ---- Migration: derive RepoStore from existing sessions ----
  const migratedRepoUrls = await runRepoMigration({
    repoStore, sessionManager, getSharedRepoDir: getBareCacheDir,
  });

  // ---- Startup: validate warm sessions + re-warm missing ----
  const startupTimer = scheduleStartupTasks({
    repoStore, sessionManager, chatHistoryManager, usageManager,
    containerManager, getBareCacheDir, warmSessionForRepo,
  }, migratedRepoUrls);

  // SSE endpoint — long-lived HTTP response with text/event-stream
  app.get("/api/events", (request, reply) => {
    const origin = request.headers.origin;
    const headers: Record<string, string> = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    };
    // Allow cross-origin requests in dev (client on different port)
    if (origin) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Credentials"] = "true";
    }
    reply.raw.writeHead(200, headers);

    const client = {
      write: (data: string) => reply.raw.write(data),
      closed: false,
    };
    sseClients.add(client);

    // Send initial state snapshot so the client has data immediately
    const sessions = sessionManager.list();
    client.write(`event: session_list\ndata: ${JSON.stringify({ sessions })}\n\n`);
    const repos = repoStore.list();
    client.write(`event: repo_list\ndata: ${JSON.stringify({ repos })}\n\n`);

    const agents = agentRegistry.list().map((a) => ({
      id: a.id, name: a.name, installed: a.installed,
      authConfigured: a.authConfigured, models: a.capabilities.models,
    }));
    client.write(`event: agent_list\ndata: ${JSON.stringify({ agents, defaultAgentId })}\n\n`);

    // Send active runner sessions so sidebar dots are correct on connect
    const activeRunnerSessions: string[] = [];
    for (const session of sessions) {
      const runner = runnerRegistry.get(session.id);
      if (runner?.running) activeRunnerSessions.push(session.id);
    }
    if (activeRunnerSessions.length > 0) {
      client.write(`event: active_runners\ndata: ${JSON.stringify({ sessionIds: activeRunnerSessions })}\n\n`);
    }

    // Send current PR statuses so inline cards and sidebar icons are correct on connect
    const prStatuses = prStatusPoller.getAllStatuses();
    if (prStatuses.length > 0) {
      client.write(`event: pr_status\ndata: ${JSON.stringify({ updates: prStatuses })}\n\n`);
    }

    // Send current Docker memory stats on connect
    if (dockerForStats) {
      void (async () => {
        const stats = await readDockerMemoryStats(dockerForStats);
        if (stats && !client.closed) {
          client.write(`event: docker_memory\ndata: ${JSON.stringify(stats)}\n\n`);
        }
      })();
    }

    request.raw.on("close", () => {
      client.closed = true;
      sseClients.delete(client);
    });
  });

  // ---- Docker memory stats broadcast (every 10s) ----
  const memoryStatsInterval = dockerForStats ? setInterval(() => {
    void (async () => {
      const stats = await readDockerMemoryStats(dockerForStats);
      if (stats) sseBroadcast("docker_memory", stats);
    })();
  }, 10_000) : null;

  // ---- HTTP API routes ----
  await registerApiRoutes(app, {
    sessionManager,
    repoStore,
    createGitManager,
    createRepoGit,
    agentRegistry,
    githubAuthManager,
    credentialStore,
    defaultAgentId,
    workspaceDir,
    usageManager,
    runnerRegistry,
    chatHistoryManager,
    authManager,
    broadcastLog,
    sseBroadcast,
    getSharedRepoDir: getBareCacheDir,
    createSessionDir,
    generateText,
    sessionsRoot,
    warmSessionForRepo,
    waitForWarmSession: (repoUrl: string) => waitForWarmSession(repoUrl),
    createSessionDirFull: createSessionDir,
    containerManager: containerManager ?? undefined,
    prStatusPoller,
    databaseManager,
    secretStore,
    reviewStore,
    serviceManagers,
  });

  // ---- Preview reverse proxy (container mode) ----
  if (containerManager) {
    registerPreviewProxy(app, { containerManager, serviceManagers });
  }

  // ---- Test-only session creation endpoint ----
  // Replaces the removed POST /api/sessions for integration tests.
  if (isTestMode) {
    app.post<{ Body: { title?: string } }>(
      "/api/_test/sessions",
      async (_request) => {
        const title = _request.body?.title?.trim() || "Test session";
        const { appSessionId, sessionDir, workspaceDir } = await createSessionDir(title);
        const git = createGitManager(workspaceDir);
        await git.init();
        return { sessionId: appSessionId, sessionDir, workspaceDir };
      },
    );
  }

  // Serve the built client files from dist/client/
  if (shouldServeStatic) {
    const clientDir = path.resolve(process.cwd(), "dist/client");
    try {
      await app.register(fastifyStatic, {
        root: clientDir,
        prefix: "/",
        wildcard: false,
      });
      // SPA fallback — serve index.html for non-file routes
      app.setNotFoundHandler((_req, reply) => {
        reply.sendFile("index.html", clientDir);
      });
    } catch {
      // Client build may not exist during dev; that's fine
      console.log("[server] No built client found at", clientDir);
    }
  }

  // ---- Per-session WebSocket route ----



  // ---- Per-session WebSocket route ----
  // Session-scoped WS: auto-activates the session on connect, no activate_session needed.
  // The session ID is in the URL path. Agent preference via ?agent= query param.
  app.get<{ Params: { sessionId: string }; Querystring: { agent?: string; model?: string } }>(
    "/ws/sessions/:sessionId",
    { websocket: true },
    (socket, request) => {
      const { sessionId } = request.params;
      const session = sessionManager.get(sessionId);
      if (!session) {
        socket.close(4004, "Session not found");
        return;
      }
      console.log(`[ws] session client connected: ${sessionId}`);

      // Per-connection state — initialized from URL params
      let activeAppSessionId: string | undefined = sessionId;
      let activeSessionDir: string | null = session.workspaceDir ?? null;
      const requestedAgent = request.query.agent as AgentId | undefined;
      const requestedModel = request.query.model;
      let perConnectionAgentId: AgentId = requestedAgent ?? defaultAgentId;
      let selectedModel: string | undefined = session.model ?? requestedModel;
      let attachedRunner: SessionRunnerInterface | null = null;
      let runnerMessageListener: ((msg: WsServerMessage) => void) | null = null;
      let previewRetryListener: ((msg: WsServerMessage) => void) | null = null;

      const send = (msg: WsServerMessage) => {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify(msg));
        }
      };

      // ---- Runner attach/detach (same as /ws) ----
      const attachToRunner = (runner: SessionRunnerInterface) => {
        if (attachedRunner === runner) return;
        detachFromRunner();
        attachedRunner = runner;
        runnerMessageListener = (msg: WsServerMessage) => { send(msg); };
        runner.on("message", runnerMessageListener);
        runner.attachViewer();
        // Don't replay the turn event buffer here — persisted chat history is
        // loaded via HTTP (loadSessionHistory) and is the single source of truth.
        // Replaying buffer events races with the HTTP load and causes duplicates
        // or overwritten messages.  Live events stream via the "message" listener.
        if (runner.getQueueSnapshot().length > 0) {
          send({ type: "queue_updated", queue: runner.getQueueSnapshot() });
        }
        if (runner.running || runner.queueLength > 0) {
          send({ type: "session_status", sessionId: runner.sessionId, running: runner.running, queueLength: runner.queueLength });
        }
        // Replay current service/compose state so the UI is correct after reload
        const mgr = serviceManagers.get(runner.sessionId);
        if (mgr) {
          if (mgr.startError) {
            send({
              type: "compose_error",
              sessionId: runner.sessionId,
              message: mgr.startError,
            } as WsServerMessage);
          }
          const services = mgr.getServices();
          if (services.length > 0) {
            send({
              type: "service_list",
              sessionId: runner.sessionId,
              services: services.map(s => ({
                name: s.name,
                status: s.status,
                port: s.port,
                preview: s.preview,
                error: s.error,
              })),
            } as WsServerMessage);
          }
        }
        // Replay compose warnings (e.g. old-format migration hints) when no
        // ServiceManager exists — the warning was stored before the WS listener
        // was attached, so emitMessage couldn't deliver it.
        const warning = composeWarnings.get(runner.sessionId);
        if (warning && !mgr) {
          send({
            type: "compose_error",
            sessionId: runner.sessionId,
            message: warning,
          } as WsServerMessage);
        }
        // Replay compose-not-configured hint so the preview panel shows
        // the setup prompt after page reload.
        if (!mgr && !warning && composeNotConfigured.has(runner.sessionId)) {
          send({
            type: "compose_not_configured",
            sessionId: runner.sessionId,
          } as WsServerMessage);
        }
        // Don't send preview_status here — it's sent once after the log
        // buffer replay (see below) so React 18 batching can't swallow it.
        // For container runners where preview state isn't yet known (SSE
        // still connecting), register a one-shot listener that sends it
        // once the worker reports its preview state.
        if (!runner.previewStatusKnown) {
          previewRetryListener = (msg: WsServerMessage) => {
            if (msg.type === "preview_status") {
              runner.off("message", previewRetryListener!);
              previewRetryListener = null;
            }
          };
          runner.on("message", previewRetryListener);
        }
      };

      const detachFromRunner = () => {
        if (attachedRunner) {
          if (runnerMessageListener) attachedRunner.off("message", runnerMessageListener);
          if (previewRetryListener) attachedRunner.off("message", previewRetryListener);
          attachedRunner.detachViewer();
        }
        attachedRunner = null;
        runnerMessageListener = null;
        previewRetryListener = null;
      };

      const scheduleAutoPush = (git: GitManager, sessionId?: string) => {
        // Look up the runner from the registry by session ID instead of using
        // the connection-scoped attachedRunner. If the WS reconnects during an
        // agent turn, attachedRunner on the old connection becomes null and the
        // push would be silently skipped.
        const runner = (sessionId ? runnerRegistry.get(sessionId) : null) ?? attachedRunner;
        if (!runner) return;
        runner.clearPushTimer();
        runner.setPushTimer(setTimeout(async () => {
          runner.setPushTimer(null);
          try {
            if (!githubAuthManager.authenticated) return;
            const branch = await pushToOrigin(git);
            if (branch) {
              runner.emitMessage({ type: "github_push_result", success: true, message: `Auto-pushed to origin/${branch}`, branch });
            }
          } catch (err) {
            if (isNonFastForwardError(err)) {
              // Branch has diverged — emit event so client can offer rebase
              runner.emitMessage({
                type: "git_push_rejected",
                reason: "non_fast_forward",
                message: "Branch has diverged from remote. Rebase needed to update.",
              });
              return;
            }
            const errMsg = getErrorMessage(err);
            const text = errMsg.includes("workflow")
              ? "Auto-push failed: your GitHub token needs the `workflow` scope to push changes to GitHub Actions workflow files. Update your token at https://github.com/settings/tokens."
              : `Auto-push failed: ${errMsg}`;
            broadcastLog("server", text);
            runner.emitMessage({ type: "log_entry", source: "server", text, timestamp: new Date().toISOString() });
          }
        }, autoPushDebounceMs));
      };

      const getActiveDir = (): string => activeSessionDir ?? workspaceDir;
      const getActiveGitManager = (): GitManager => {
        if (!activeSessionDir) throw new Error("No active session — git operations require a session");
        return createGitManager(activeSessionDir);
      };

      const activateSession = async (sid: string) => {
        const s = sessionManager.get(sid);
        activeAppSessionId = sid;
        const dir = s?.workspaceDir ?? null;
        const existingRunner = runnerRegistry.get(sid);
        if (existingRunner) {
          attachToRunner(existingRunner);
        } else if (dir) {
          const runner = runnerRegistry.getOrCreate(sid, dir, perConnectionAgentId);
          attachToRunner(runner);
        } else {
          detachFromRunner();
        }
        if (dir !== activeSessionDir) {
          activeSessionDir = dir;
        }
        if (dir) void checkGitIdentity(dir);
      };

      const checkGitIdentity = async (_sessionDir: string) => {
        if (getGitIdentity()) return;
        send({ type: "git_identity_required" });
      };

      const readSystemPrompt = async (): Promise<string | undefined> => {
        try {
          const content = await fs.readFile(path.join(workspaceDir, ".shipit", "system-prompt.md"), "utf-8");
          const trimmed = content.trim();
          return trimmed || undefined;
        } catch { return undefined; }
      };

      // Wrap broadcastLog so it both buffers globally AND sends to attached WS viewers
      const sessionBroadcastLog: typeof broadcastLog = (source, text) => {
        broadcastLog(source, text); // global buffer
        const entry: WsLogEntry = { type: "log_entry", source, text, timestamp: new Date().toISOString() };
        if (attachedRunner) {
          attachedRunner.emitMessage(entry);
        } else {
          send(entry);
        }
      };

      // ---- Handler context ----
      const ctx: ConnectionCtx & RunnerCtx & AppCtx & serviceHandlers.ServiceCtx = {
        send, broadcastLog: sessionBroadcastLog, sseBroadcast,
        getActiveDir, getActiveGitManager,
        getActiveAppSessionId: () => activeAppSessionId,
        setActiveAppSessionId: (id) => { activeAppSessionId = id; },
        getActiveSessionDir: () => activeSessionDir,
        setActiveSessionDir: (dir) => { activeSessionDir = dir; },
        activateSession,
        agentFactory: (agentId: AgentId) => {
          if (attachedRunner?.createAgent) return attachedRunner.createAgent(agentId);
          if (agentFactory) return agentFactory(agentId);
          throw new Error("No agent factory available");
        },
        getAgent: () => attachedRunner?.getAgent() ?? null,
        setAgent: (a) => { if (attachedRunner) attachedRunner.setAgent(a); },
        getActiveAgentId: () => attachedRunner?.agentId ?? perConnectionAgentId,
        setActiveAgentId: (id) => { perConnectionAgentId = id; if (attachedRunner) attachedRunner.agentId = id; },
        getSelectedModel: () => selectedModel,
        setSelectedModel: (m) => { selectedModel = m; },
        getIsClaudeRunning: () => attachedRunner?.running ?? false,
        setIsClaudeRunning: (v) => { if (attachedRunner) attachedRunner.running = v; },
        getWasInterrupted: () => attachedRunner?.wasInterrupted ?? false,
        setWasInterrupted: (v) => { if (attachedRunner) attachedRunner.wasInterrupted = v; },
        getTurnSummary: () => attachedRunner?.turnSummary ?? "",
        setTurnSummary: (s) => { if (attachedRunner) attachedRunner.turnSummary = s; },
        getAccumulatedText: () => attachedRunner?.accumulatedText ?? "",
        setAccumulatedText: (s) => { if (attachedRunner) attachedRunner.accumulatedText = s; },
        getAccumulatedToolUse: () => attachedRunner?.accumulatedToolUse ?? [],
        setAccumulatedToolUse: (blocks) => { if (attachedRunner) attachedRunner.accumulatedToolUse = blocks; },
        getChatMessageGroups: () => attachedRunner?.chatMessageGroups ?? [],
        setChatMessageGroups: (groups) => { if (attachedRunner) attachedRunner.chatMessageGroups = groups; },
        getNeedsNewMessageGroup: () => attachedRunner?.needsNewMessageGroup ?? true,
        setNeedsNewMessageGroup: (v) => { if (attachedRunner) attachedRunner.needsNewMessageGroup = v; },
        getMessageQueue: () => attachedRunner?.messageQueue ?? [],
        clearMessageQueue: () => { if (attachedRunner) attachedRunner.clearQueue(); },
        getTerminal: () => attachedRunner?.getTerminal() ?? null,
        setTerminal: (t) => { if (attachedRunner) attachedRunner.setTerminal(t); },
        clearLogBuffer: () => { clearLogBuffer(); },
        getRunner: () => attachedRunner,
        getRunnerRegistry: () => runnerRegistry,
        attachToRunner, detachFromRunner,
        sessionManager, chatHistoryManager, createGitManager, createRepoGit,
        githubAuthManager,
        usageManager, authManager, agentRegistry, credentialStore,
        repoStore, warmSessionForRepo, generateText,
        getSharedRepoDir: getBareCacheDir, checkGitIdentity, readSystemPrompt, scheduleAutoPush,
        prStatusPoller,
        workspaceDir, sessionsRoot, defaultAgentId,
        getServiceManager: () => serviceManagers.get(sessionId) ?? null,
      };

      // Auto-activate the session on connect
      void activateSession(sessionId);

      // Send log buffer and git identity check
      const logBuffer = getLogBuffer();
      for (const entry of logBuffer) { send(entry); }
      if (!getGitIdentity()) { send({ type: "git_identity_required" }); }

      // Send preview_status after the log buffer so it's the last
      // synchronous message.  Sending it earlier (inside attachToRunner)
      // caused React 18 automatic batching to swallow it when many WS
      // messages arrived in the same rendering cycle.
      {
        const runner = runnerRegistry.get(sessionId);
        if (runner?.previewStatusKnown) {
          send(runner.buildPreviewStatus());
        }
      }

      // Always send PR lifecycle card for sessions with a remote.
      // The SSE pr_status snapshot handles open/merged PRs; this covers the
      // "ready" phase (branch info + diff stats, no PR created yet).
      {
        const session = sessionManager.get(sessionId);
        if (session?.remoteUrl && session.workspaceDir && session.branchRenamed) {
          const prStatus = prStatusPoller.getStatus(sessionId);
          if (!prStatus && !session.mergedAt) {
            // No open/merged PR and not already merged — send branch info and diff stats
            void (async () => {
              try {
                const git = createGitManager(session.workspaceDir!);
                const headBranch = session.branch || await git.getCurrentBranch();
                const { insertions, deletions } = await git.diffStatVsBranch("main");
                send({
                  type: "pr_lifecycle_update",
                  sessionId,
                  cardId: `pr-card-${sessionId}`,
                  phase: "ready",
                  headBranch,
                  totalInsertions: insertions,
                  totalDeletions: deletions,
                });
              } catch (err) {
                send({
                  type: "pr_lifecycle_update",
                  sessionId,
                  cardId: `pr-card-${sessionId}`,
                  phase: "error",
                  errorMessage: err instanceof Error ? err.message : "Failed to read git status",
                });
              }
            })();
          }
        }
      }

      // Message dispatcher — same as /ws but without new_session and activate_session
      socket.on("message", async (raw: Buffer) => {
        let msg: WsClientMessage;
        try { msg = JSON.parse(raw.toString()) as WsClientMessage; } catch { send({ type: "error", message: "Invalid JSON" }); return; }

        switch (msg.type) {
          case "terminal_start": return terminalHandlers.handleTerminalStart(ctx, msg);
          case "terminal_input": return terminalHandlers.handleTerminalInput(ctx, msg);
          case "terminal_resize": return terminalHandlers.handleTerminalResize(ctx, msg);
          case "clear_logs": { terminalHandlers.handleClearLogs(ctx); return; }
          case "set_agent": {
            const agentId = msg.agentId;
            const info = agentRegistry.get(agentId);
            if (!info) { send({ type: "error", message: `Unknown agent: ${agentId}` }); return; }
            if (!info.installed) { send({ type: "error", message: `${info.name} CLI is not installed` }); return; }
            if (!info.authConfigured) {
              const envKey = agentId === "codex" ? "OPENAI_API_KEY" : "";
              send({ type: "error", message: `${envKey || "API key"} is not set. Add it in Settings → Agents.` });
              return;
            }
            ctx.setActiveAgentId(agentId);
            return;
          }
          case "set_model": {
            const activeAgent = agentRegistry.get(ctx.getActiveAgentId());
            if (activeAgent && !activeAgent.capabilities.models.includes(msg.model)) {
              send({ type: "error", message: `Model "${msg.model}" is not available for ${activeAgent.name}` });
              return;
            }
            ctx.setSelectedModel(msg.model);
            // Persist to session metadata so it survives reconnects and warm pool
            if (activeAppSessionId) {
              sessionManager.setModel(activeAppSessionId, msg.model);
            }
            return;
          }
          // new_session and activate_session are NOT handled — session is implicit from URL
          case "rollback_code": return rollbackHandlers.handleRollbackCode(ctx, msg);
          case "rollback_code_and_chat": return rollbackHandlers.handleRollbackCodeAndChat(ctx, msg);
          case "fork_session_from_message": return rollbackHandlers.handleForkSessionFromMessage(ctx, msg);
          case "rewind_to_message": return rewindHandlers.handleRewindToMessage(ctx, msg);
          case "cancel_queued_message": { miscHandlers.handleCancelQueuedMessage(ctx, msg); return; }
          case "interrupt_claude": { miscHandlers.handleInterruptClaude(ctx); return; }
          case "init_preview_config": {
            void sendMessageHandlers.handleSendMessage(ctx, {
              type: "send_message",
              text: `Analyze this project and set up live preview using Docker Compose.

1. Create a \`docker-compose.yml\` at the workspace root with a service for the dev server.
2. Create a \`shipit.yaml\` at the workspace root to configure the agent and install steps.

Example docker-compose.yml for a Node.js project:
\`\`\`yaml
services:
  web:
    image: node:20
    working_dir: /app
    volumes:
      - .:/app
    ports:
      - "3000:3000"
    command: npm run dev
\`\`\`

Example shipit.yaml:
\`\`\`yaml
version: 1
agent:
  install:
    - npm install
compose:
  file: docker-compose.yml
\`\`\`

Look at package.json scripts, framework config files, and project structure
to determine the correct dev command, ports, and install steps.
Read /shipit-docs/compose.md for full details on the compose model.`,
            });
            return;
          }
          case "start_service": return serviceHandlers.handleStartService(ctx, msg);
          case "stop_service": return serviceHandlers.handleStopService(ctx, msg);
          case "subscribe_service_logs": { serviceHandlers.handleSubscribeServiceLogs(ctx, msg); return; }
          case "send_message": return sendMessageHandlers.handleSendMessage(ctx, msg);
          case "answer_question": return sendMessageHandlers.handleAnswerQuestion(ctx, msg);
        }
      });

      socket.on("close", () => {
        console.log(`[ws] session client disconnected: ${sessionId}`);
        detachFromRunner();
        enforceIdleContainerLimit();
      });
    },
  );

  // ---- Container health monitoring ----
  if (containerManager) {
    setupContainerHealthMonitoring(containerManager, runnerRegistry);
  }

  // Graceful shutdown
  app.addHook("onClose", async () => {
    if (memoryStatsInterval) clearInterval(memoryStatsInterval);
  });
  registerShutdownHook(app, {
    startupTimer, authManager, runnerRegistry,
    dockerProxyServer, containerManager, databaseManager,
  });

  return app;
}

// Only start the server when this file is the entry point (not when imported by tests).
// Vitest sets process.env.VITEST; alternatively check import.meta.url vs process.argv[1].
if (!process.env.VITEST) {
  void autoStart(buildApp);
}
