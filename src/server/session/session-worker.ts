/**
 * Session Worker — lightweight Fastify server that runs inside each container
 * (or as a subprocess in non-Docker mode for testing).
 *
 * Provides agent, terminal, and file watcher endpoints. Preview/services
 * are managed by Docker Compose via ServiceManager in the orchestrator.
 *
 * Streams events back to the orchestrator via SSE.
 * The orchestrator talks to this server over HTTP on port 9100 (or a
 * configured port).
 *
 * The endpoint groups (and their state) live in per-concern controllers under
 * `src/server/session/`: {@link AgentController} (agent + sub-agent),
 * {@link TerminalController} (PTY), {@link FileWatcherController},
 * {@link InstallController} (install + MCP install), and
 * {@link McpConfigController} (MCP bridge/config resolution). This class is the
 * app builder: it constructs the SSE broadcaster, permission broker, and present
 * registry, instantiates the controllers, and registers their routes alongside
 * the worker-level endpoints (health, services, secrets, SSE, ask, permission,
 * present, agent-ops).
 */

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { AgentId } from "./agents/agent-process.js";
import type { PermissionDecision } from "../shared/types.js";
import { PermissionBroker } from "./permission-broker.js";
import { TerminalProcess } from "./terminal.js";
import { FileWatcher } from "./file-watcher.js";
import { CONTAINER_WORKSPACE_DIR } from "../shared/fs-constants.js";
import { getErrorMessage } from "../shared/utils.js";
import { ClaudeProcess } from "./agents/claude/process.js";
import { ClaudeAdapter } from "./agents/claude/adapter.js";
import { CodexAdapter } from "./agents/codex/adapter.js";
import { registerAgentOpsRoutes } from "./agent-ops-routes.js";
import { normalizeAskQuestions } from "./ask-question.js";
import type { OrchestratorClient } from "./orchestrator-client.js";
import { ServiceRequestQueue } from "./service-request-queue.js";
import { SseBroadcaster } from "./sse-broadcaster.js";
import type { SseClient, WorkerSSEEvent } from "./sse-broadcaster.js";
import { PresentRegistry } from "./present-registry.js";
import {
  registerPresentFilesRoutes,
  inferPresentMimeType,
} from "./present-view.js";
import { McpConfigController } from "./mcp-config-controller.js";
import { AgentController, type WorkerAgentFactory } from "./agent-controller.js";
import { TerminalController } from "./terminal-controller.js";
import { FileWatcherController } from "./file-watcher-controller.js";
import { InstallController } from "./install-controller.js";

export type { WorkerSSEEvent } from "./sse-broadcaster.js";
export type { WorkerAgentFactory } from "./agent-controller.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionWorkerDeps {
  /** Factory for creating agent processes. */
  agentFactory: WorkerAgentFactory;
  /** Port to listen on. Defaults to 9100. */
  port?: number;
  /** Host to bind to. Defaults to "0.0.0.0". */
  host?: string;
  /** Workspace directory inside the container. Defaults to "/workspace". */
  workspaceDir?: string;
  /** Factory for creating FileWatcher (injectable for testing). */
  createFileWatcher?: () => FileWatcher;
  /** Factory for creating TerminalProcess (injectable for testing). */
  createTerminal?: () => TerminalProcess;
  /** Factory for the worker→orchestrator client. Injectable so tests can stub the orchestrator. */
  createOrchestratorClient?: () => OrchestratorClient;
}

// ---------------------------------------------------------------------------
// SessionWorker
// ---------------------------------------------------------------------------

/**
 * The session worker manages a single agent process, terminal, and file watcher.
 * Exposes them over HTTP. SSE clients connect to GET /events and receive
 * real-time events.
 */
export class SessionWorker extends EventEmitter {
  private app: FastifyInstance;
  private readonly sse: SseBroadcaster;
  private port: number;
  private host: string;
  private workspaceDir: string;
  private _createOrchestratorClient?: () => OrchestratorClient;

  // Per-concern controllers — each owns its endpoint group and the state behind
  // it. The worker wires them with a shared broadcast closure + the cross-cutting
  // singletons (permission broker, MCP config).
  private readonly mcpConfig: McpConfigController;
  private readonly agentController: AgentController;
  private readonly terminalController: TerminalController;
  private readonly fileWatcherController: FileWatcherController;
  private readonly installController: InstallController;

  // Service request/callback state — outgoing requests to the orchestrator
  // over SSE wait here for the orchestrator's /services/_callback POST.
  private readonly serviceRequests = new ServiceRequestQueue();

  // Phase 3 (087): names of secrets currently injected into process.env by
  // the orchestrator. Tracked so we can `delete process.env[name]` for keys
  // that are no longer marked `agent: true` after a compose-file edit.
  private _injectedSecretNames = new Set<string>();

  // docs/093 — present tool registry. Holds only metadata (the on-disk path,
  // MIME, title) per artifact the agent emitted via `present`. The bytes are
  // read from disk lazily on each serve, never retained (see PresentRegistry).
  private readonly presentRegistry = new PresentRegistry();

  // SHI-112 / docs/193 — agent-agnostic approval broker. Holds pending
  // sensitive-action requests (Claude via the `--permission-prompt-tool`
  // bridge; Codex via its app-server approval channel), broadcasts the
  // canonical request/resolved events, and tracks the per-session remember-set.
  private readonly permissionBroker: PermissionBroker;

  constructor(deps: SessionWorkerDeps) {
    super();
    this.port = deps.port ?? 9100;
    this.host = deps.host ?? "0.0.0.0";
    this.workspaceDir = deps.workspaceDir ?? "/workspace";
    this._createOrchestratorClient = deps.createOrchestratorClient;

    const broadcast = (event: WorkerSSEEvent): void => this.sse.broadcast(event);

    this.sse = new SseBroadcaster({
      onBackpressureChange: () => this.terminalController.applyBackpressure(),
    });
    // docs/193 — the broker broadcasts its canonical request/resolved events on
    // the same `agent_event` SSE frame the ask bridge uses, so they reach the
    // orchestrator's agent-listeners and render/persist the permission card.
    this.permissionBroker = new PermissionBroker({
      broadcast: (event) => broadcast({ type: "agent_event", data: event }),
    });

    this.mcpConfig = new McpConfigController({ broadcast });
    this.agentController = new AgentController({
      agentFactory: deps.agentFactory,
      workspaceDir: this.workspaceDir,
      broadcast,
      permissionBroker: this.permissionBroker,
      mcpConfig: this.mcpConfig,
      latestSseSeq: () => this.sse.latestSeq,
    });
    this.terminalController = new TerminalController({
      createTerminal: deps.createTerminal ?? (() => new TerminalProcess()),
      workspaceDir: this.workspaceDir,
      broadcast,
      hasBackpressure: () => this.sse.hasBackpressure(),
    });
    this.fileWatcherController = new FileWatcherController({
      createFileWatcher: deps.createFileWatcher ?? (() => new FileWatcher()),
      workspaceDir: this.workspaceDir,
      broadcast,
    });
    this.installController = new InstallController({
      workspaceDir: this.workspaceDir,
      broadcast,
      mcpConfig: this.mcpConfig,
    });

    this.app = this.buildApp();
  }

  private buildApp(): FastifyInstance {
    const app = Fastify({ logger: false });

    app.get("/health", async () => ({ status: "ok" }));

    // Controller-owned endpoint groups.
    this.agentController.registerRoutes(app);
    this.terminalController.registerRoutes(app);
    this.fileWatcherController.registerRoutes(app);
    this.installController.registerRoutes(app);

    // Worker-level endpoints (state lives on the worker itself).
    this.registerServiceEndpoints(app);
    this.registerSecretsEndpoint(app);
    this.registerSSEEndpoint(app);
    this.registerAskEndpoint(app);
    this.registerPermissionEndpoints(app);
    this.registerPresentEndpoints(app);
    registerAgentOpsRoutes(app, {
      createOrchestratorClient: this._createOrchestratorClient,
    });

    return app;
  }

  // --- Service control endpoints (called by agent) ---

  private registerServiceEndpoints(app: FastifyInstance): void {
    app.get("/services/list", async () => {
      return this.sendServiceRequest("list");
    });

    app.post<{ Body: { name: string } }>("/services/start", async (request, reply) => {
      const { name } = request.body ?? {};
      if (typeof name !== "string" || !name) {
        return reply.code(400).send({ error: "name is required" });
      }
      return this.sendServiceRequest("start", name);
    });

    app.post<{ Body: { name: string } }>("/services/stop", async (request, reply) => {
      const { name } = request.body ?? {};
      if (typeof name !== "string" || !name) {
        return reply.code(400).send({ error: "name is required" });
      }
      return this.sendServiceRequest("stop", name);
    });

    app.post<{ Body: { name: string } }>("/services/restart", async (request, reply) => {
      const { name } = request.body ?? {};
      if (typeof name !== "string" || !name) {
        return reply.code(400).send({ error: "name is required" });
      }
      return this.sendServiceRequest("restart", name);
    });

    // --- Service callback endpoint (called by orchestrator with results) ---

    app.post<{ Body: { requestId: string; result?: unknown; error?: string } }>("/services/_callback", async (request, reply) => {
      const { requestId, result, error } = request.body ?? {};
      if (typeof requestId !== "string") {
        return reply.code(400).send({ error: "requestId is required" });
      }
      const settled = error
        ? this.serviceRequests.reject(requestId, new Error(error))
        : this.serviceRequests.resolve(requestId, result ?? { ok: true });
      if (!settled) {
        return reply.code(404).send({ error: "Unknown or expired request" });
      }
      return { received: true };
    });
  }

  // --- Secrets endpoint (087 Phase 3) ---
  //
  // Push the full set of `agent: true` secret values to this worker.
  // The orchestrator calls this:
  //   1. Once after the compose stack starts and `agent: true` entries
  //      are resolved (initial bootstrap), and
  //   2. Whenever the user saves new values via PUT /api/secrets, or the
  //      compose file changes the set of `agent: true` declarations.
  //
  // We replace the full set on every call (not patch) so a name that's
  // dropped from `x-shipit-secrets` (or has `agent: true` removed) gets
  // its env var unset, instead of lingering.
  //
  // Subsequent agent processes spawned via /agent/start inherit the
  // updated process.env (the worker passes its own env into the child
  // via the agent factory). An already-running agent does NOT see the
  // change — secret updates take effect on the next agent turn.
  private registerSecretsEndpoint(app: FastifyInstance): void {
    app.put<{ Body: { secrets: Record<string, string> } }>("/secrets", async (request, reply) => {
      const { secrets } = request.body ?? {};
      if (!secrets || typeof secrets !== "object" || Array.isArray(secrets)) {
        return reply.code(400).send({ error: "secrets must be an object" });
      }

      // Validate shape — keys are env var names, values are strings.
      for (const [k, v] of Object.entries(secrets)) {
        if (typeof v !== "string") {
          return reply.code(400).send({
            error: `Secret ${k} must be a string (got ${typeof v})`,
          });
        }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
          return reply.code(400).send({
            error: `Secret name ${k} is not a valid env var identifier`,
          });
        }
      }

      // Drop names that were previously injected but are no longer present.
      // This catches both "user removed the value" and "compose file no
      // longer marks this name as agent: true". The dynamic-key delete is
      // intentional — the worker has to mutate process.env by name to
      // surface secrets to spawned children. The set has already been
      // validated against the env-var-name regex above so injection is bounded.
      for (const name of this._injectedSecretNames) {
        if (!(name in secrets)) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- intentional process.env mutation
          delete process.env[name];
        }
      }

      // Set / overwrite the new values.
      for (const [name, value] of Object.entries(secrets)) {
        process.env[name] = value;
      }

      this._injectedSecretNames = new Set(Object.keys(secrets));
      return { applied: this._injectedSecretNames.size };
    });
  }

  // --- AskUserQuestion bridge endpoint (docs/147) ---

  /**
   * `POST /agent-ops/ask/submit` — receives a structured question from the
   * `shipit` bridge's ask tool (a child of the Codex CLI) and injects it into
   * the agent event stream as an `AskUserQuestion` tool_use.
   *
   * Why inject here instead of letting the adapter parse it off Codex's event
   * stream? The Codex app-server surfaces an `mcpToolCall` item only on
   * `item/completed`, after the tool returns — but the ask bridge blocks on a
   * well-formed question and never returns, so the adapter would never see it
   * (the call just sat until Codex's ~120s MCP timeout). Broadcasting the same
   * `agent_event` the adapter emits for real tool calls drives the
   * orchestrator's existing AskUserQuestion interrupt/answer/resume flow
   * (agent-listeners.ts, keyed on the tool name) unchanged — the orchestrator
   * renders the card and interrupts the turn immediately. The interrupt kills
   * the Codex process (and with it the bridge), so the call never times out.
   */
  private registerAskEndpoint(app: FastifyInstance): void {
    app.post<{ Body: { questions?: unknown } }>(
      "/agent-ops/ask/submit",
      async (request, reply) => {
        const questions = normalizeAskQuestions(request.body?.questions);
        if (questions.length === 0) {
          return reply.code(400).send({
            error:
              "questions must be a non-empty array, and each question must have at least one labeled option",
          });
        }

        const toolUseId = `ask_${crypto.randomUUID()}`;
        this.broadcastSSE({
          type: "agent_event",
          data: {
            type: "agent_assistant",
            content: [
              { type: "tool_use", id: toolUseId, name: "AskUserQuestion", input: { questions } },
            ],
          },
        });

        return { status: "asked" };
      },
    );
  }

  /**
   * docs/193 — the permission round-trip, as a long poll (Thread B / SHI-112).
   *
   * The Claude `--permission-prompt-tool` bridge drives it in two steps so a
   * long wait rides over a transient worker blip instead of dying on one
   * indefinitely-held HTTP fetch (which surfaced as "fetch failed" → a
   * fail-closed deny → a model retry that STACKED a fresh card):
   *
   * - `POST /agent-ops/permission/request` opens the request and returns
   *   IMMEDIATELY — either `{ behavior }` for a pre-approved action (handled
   *   interrupt tool / remembered path) or `{ requestId }` for the bridge to
   *   poll. Idempotent on `toolUseId`, so a retried open re-attaches to the one
   *   card instead of opening a second.
   * - `POST /agent-ops/permission/await` holds for a BOUNDED window and returns
   *   `{ behavior }` once answered or `{ pending: true }` to poll again. Short
   *   holds mean a slow user never trips a client timeout and a brief
   *   unreachability is a quick retry, not a hard failure.
   *
   * (Codex doesn't hit these routes — its adapter calls `broker.request`
   * directly via the injected requester, awaiting the decision on its own
   * blocking app-server RPC.)
   *
   * `/agent/permission/resolve` is the orchestrator→worker push: the user's
   * approve/deny answer, delivered via `ProxyAgentProcess.resolvePermission`.
   * It resolves the broker entry, which unblocks BOTH the bridge's next poll
   * (Claude) and the awaited `broker.request` promise (Codex) uniformly.
   */
  private registerPermissionEndpoints(app: FastifyInstance): void {
    app.post<{ Body: { toolName?: string; input?: Record<string, unknown>; toolUseId?: string } }>(
      "/agent-ops/permission/request",
      async (request, reply) => {
        const body = request.body ?? {};
        if (typeof body.toolName !== "string" || !body.toolName) {
          return reply.code(400).send({ error: "toolName is required" });
        }
        const agentId = this.agentController.currentAgentId;
        // Non-blocking: register (or re-attach to) the request and return.
        const opened = this.permissionBroker.openRequest({
          toolName: body.toolName,
          input: body.input,
          ...(body.toolUseId ? { toolUseId: body.toolUseId } : {}),
          ...(agentId ? { agentId } : {}),
        });
        if (opened.immediate) {
          return {
            behavior: opened.immediate.behavior,
            ...(opened.immediate.message ? { message: opened.immediate.message } : {}),
          };
        }
        return { requestId: opened.requestId };
      },
    );

    app.post<{ Body: { requestId?: string; timeoutMs?: number } }>(
      "/agent-ops/permission/await",
      async (request, reply) => {
        const body = request.body ?? {};
        if (typeof body.requestId !== "string" || !body.requestId) {
          return reply.code(400).send({ error: "requestId is required" });
        }
        // Clamp the client-supplied hold to a sane bound (and ignore garbage).
        const timeoutMs = typeof body.timeoutMs === "number" && body.timeoutMs > 0
          ? Math.min(body.timeoutMs, 60_000)
          : undefined;
        const { settled, decision } = await this.permissionBroker.poll(body.requestId, timeoutMs);
        if (!settled || !decision) return { pending: true };
        return { behavior: decision.behavior, ...(decision.message ? { message: decision.message } : {}) };
      },
    );

    app.post<{ Body: { requestId?: string; behavior?: string; remember?: boolean; message?: string } }>(
      "/agent/permission/resolve",
      async (request, reply) => {
        const body = request.body ?? {};
        if (typeof body.requestId !== "string" || !body.requestId) {
          return reply.code(400).send({ error: "requestId is required" });
        }
        if (body.behavior !== "allow" && body.behavior !== "deny") {
          return reply.code(400).send({ error: "behavior must be 'allow' or 'deny'" });
        }
        const decision: PermissionDecision = {
          behavior: body.behavior,
          ...(body.remember ? { remember: true } : {}),
          ...(typeof body.message === "string" ? { message: body.message } : {}),
        };
        const found = this.permissionBroker.resolve(body.requestId, decision);
        // `found:false` → a stale card (e.g. the worker restarted since the
        // prompt, so the held request is gone). The card simply stays pending —
        // there's no live call left to unblock and ShipIt adds no terminal state.
        return { resolved: found };
      },
    );
  }

  // --- Present tool endpoints (docs/093) ---

  /**
   * Wire the `present` tool's HTTP surfaces:
   *
   *  - `POST /agent-ops/present/submit` — receives the artifact PATH from the
   *    `shipit` bridge's present tool (a child of the agent CLI). Validates the
   *    file is readable, records its metadata in the registry, broadcasts
   *    `present_content` (metadata only) over SSE, and returns the `presentId` +
   *    a worker-local screenshot URL to the bridge. It does NOT read the bytes.
   *  - the artifact-serving routes (`registerPresentFilesRoutes`) read bytes
   *    from disk on demand — see there.
   *
   * The submit route lives under `/agent-ops/*` to stay alongside the other
   * shim brokers (review, gh, shipit).
   */
  private registerPresentEndpoints(app: FastifyInstance): void {
    app.post<{
      Body: {
        file?: string;
        mimeType?: string;
        title?: string;
        replaceId?: string;
      };
    }>("/agent-ops/present/submit", async (request, reply) => {
      const { file, mimeType, title, replaceId } = request.body ?? {};
      if (typeof file !== "string" || file.length === 0) {
        return reply.code(400).send({ error: "file is required and must be a path string" });
      }
      // The agent writes a file (anywhere — /tmp for throwaway, the workspace
      // for tracked) and presents it by path (docs/188). Relative paths resolve
      // against the workspace (the agent's cwd); absolute paths are read as-is.
      const resolvedPath = path.isAbsolute(file)
        ? file
        : path.resolve(this.workspaceDir, file);
      // MIME is inferred from the extension unless the caller overrides it.
      const overrideMime =
        typeof mimeType === "string" && mimeType.length > 0 ? mimeType : undefined;
      const resolvedMime =
        overrideMime ?? (inferPresentMimeType(resolvedPath) || "text/plain");

      // Validate the file is readable now (clear error to the agent), but DON'T
      // read its bytes — the registry holds only the path. The bytes are read
      // from disk lazily whenever the artifact is served.
      try {
        await fsp.access(resolvedPath, fs.constants.R_OK);
      } catch (err) {
        return reply.code(400).send({
          error: `Could not read file "${file}": ${getErrorMessage(err)}`,
        });
      }

      const resolvedTitle =
        typeof title === "string" && title.length > 0 ? title : undefined;
      const resolvedReplaceId =
        typeof replaceId === "string" && replaceId.length > 0 ? replaceId : undefined;
      const sessionId = process.env.SESSION_ID ?? "";

      const presentId = `pres_${crypto.randomUUID()}`;
      const createdAt = new Date().toISOString();
      const result = this.presentRegistry.put(presentId, {
        resolvedPath,
        // The presented path (verbatim — relative or absolute), shown in the
        // Present tab header. `file` is validated non-empty above.
        filePath: file,
        mimeType: resolvedMime,
        createdAt,
        ...(resolvedTitle !== undefined ? { title: resolvedTitle } : {}),
        ...(resolvedReplaceId !== undefined ? { replaceId: resolvedReplaceId } : {}),
      });

      this.broadcastSSE({
        type: "present_content",
        data: {
          sessionId,
          presentId,
          ...(resolvedReplaceId !== undefined ? { replaceId: resolvedReplaceId } : {}),
          mimeType: result.meta.mimeType,
          ...(result.meta.title !== undefined ? { title: result.meta.title } : {}),
          filePath: result.meta.filePath,
          createdAt: result.meta.createdAt,
          // docs/093 — the container-internal absolute path, carried on the SSE
          // event (not the client-facing WS message) so the orchestrator can
          // persist it and re-register this artifact with a freshly-started
          // worker after a container restart.
          resolvedPath: result.meta.resolvedPath,
        },
      });

      for (const evictedId of result.evicted) {
        this.broadcastSSE({
          type: "present_cleared",
          data: { sessionId, presentId: evictedId },
        });
      }

      // The agent's in-container browser can navigate to this worker-local URL
      // to screenshot the rendered artifact and iterate (docs/170). Handing
      // back the concrete URL means the agent never has to guess the worker
      // port — it just navigates and screenshots.
      const viewUrl = `http://127.0.0.1:${this.port}/present-files/${presentId}`;
      return { presentId, status: "presented", viewUrl };
    });

    // docs/170, docs/093 — serve artifacts (rendered for the agent's Playwright
    // browser at 127.0.0.1:${WORKER_PORT}; raw for the user's Present tab via the
    // orchestrator's authenticated session API). Both read the file from disk on
    // demand via the registry — the worker retains no artifact bytes. Worker-local
    // by design: neither route goes through the public preview proxy, keeping
    // ephemeral artifacts off any routable URL. Lives in present-view.ts so the
    // 404/serving behavior stays unit-testable.
    registerPresentFilesRoutes(app, this.presentRegistry);
  }

  // --- Service request bridge ---

  /**
   * Send a service control request to the orchestrator via SSE and wait
   * for the callback response. The orchestrator handles the request via
   * ServiceManager and POSTs the result back to /services/_callback.
   */
  private sendServiceRequest(action: string, name?: string): Promise<unknown> {
    const { requestId, promise } = this.serviceRequests.enqueue(action);
    this.broadcastSSE({
      type: "service_request",
      data: { requestId, action, name },
    });
    return promise;
  }

  // --- SSE event stream ---

  private registerSSEEndpoint(app: FastifyInstance): void {
    app.get("/events", (request, reply) => {
      reply.hijack();

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });

      reply.raw.write(": connected\n\n");

      const client: SseClient = this.sse.attach({ raw: reply.raw });

      // Replay buffered events that the consumer hasn't seen yet. `?since=N`
      // means "I've already seen up to seq N" — replay everything newer.
      // Omitted / 0 / non-numeric means "send me everything you have"
      // (first-ever connect, no prior seq). This is the load-bearing piece
      // for spawned-child sessions: the orchestrator POSTs /agent/start
      // before its SSE consumer is connected, and the CLI may emit
      // agent_init / agent_assistant / agent_result / agent_done before
      // SSE catches up. Without this replay, those events vanish and the
      // orchestrator's `running` flag never clears.
      const sinceParam = (request.query as { since?: string } | undefined)?.since;
      const sinceSeq = sinceParam !== undefined ? Number.parseInt(sinceParam, 10) : 0;
      this.sse.replaySince(client, Number.isFinite(sinceSeq) && sinceSeq > 0 ? sinceSeq : 0);

      // Replay current state for things the ring buffer can't reconstruct.
      // `terminal_data` is unbuffered (high volume) — send an empty
      // terminal_data marker so the orchestrator's terminal-reconnect path
      // resets the xterm rendering. `install_*` events are buffered but
      // we re-send the latest result as a belt-and-braces idempotent
      // signal in case the buffer was evicted across a very long
      // install (the orchestrator's resolver is idempotent).
      if (this.terminalController.hasActiveTerminal()) {
        this.sse.sendTo(client, { type: "terminal_data", data: { data: "" } });
      }
      const completed = this.installController.getCompletedResult();
      if (completed) {
        if (completed.ok) {
          this.sse.sendTo(client, { type: "install_done", data: {} });
        } else {
          this.sse.sendTo(client, {
            type: "install_error",
            data: {
              command: completed.command,
              message: completed.message ?? "Install failed",
            },
          });
        }
      }

      const keepalive = setInterval(() => {
        try {
          reply.raw.write(": keepalive\n\n");
        } catch {
          clearInterval(keepalive);
          this.sse.detach(client);
        }
      }, 15_000);

      request.raw.on("close", () => {
        clearInterval(keepalive);
        this.sse.detach(client);
      });
    });
  }

  /** Send an SSE event to all connected clients. */
  private broadcastSSE(event: WorkerSSEEvent): void {
    this.sse.broadcast(event);
  }

  /** Start the worker server. Returns the address it's listening on. */
  async start(): Promise<string> {
    const address = await this.app.listen({ port: this.port, host: this.host });
    return address;
  }

  /** Stop the worker server and clean up. */
  async stop(): Promise<void> {
    this.installController.stop();
    this.agentController.stop();
    this.terminalController.stop();
    this.fileWatcherController.stop();
    this.serviceRequests.cancelAll("Worker shutting down");
    for (const raw of this.sse.rawResponses()) {
      try { raw.end(); } catch { /* already closed */ }
    }
    this.sse.clear();
    await this.app.close();
  }

  /** Get the underlying Fastify instance (for testing). */
  getApp(): FastifyInstance { return this.app; }
}

// ---------------------------------------------------------------------------
// Standalone entry point (when run as a container process)
// ---------------------------------------------------------------------------

/**
 * Build the worker's agent process for a given agentId. Dispatches on the
 * agentId the orchestrator sends with /agent/start — hardcoding ClaudeAdapter
 * here made container-mode sessions ALWAYS run Claude regardless of the
 * selected agent, so a Codex session (model e.g. gpt-5.5) spawned
 * `claude --model gpt-5.5`, which the Claude CLI rejects as "There's an issue
 * with the selected model". Exported for the regression test.
 */
// docs/155 hair 11: legitimate construction switch — adapter instantiation
// has to dispatch on the discriminator somewhere; concentrating it in one
// factory (with a regression test in session-worker-agent-factory.test.ts)
// is the correct design.
export const createWorkerAgent: WorkerAgentFactory = (agentId: AgentId) =>
  // eslint-disable-next-line no-restricted-syntax -- docs/155 hair 11: see comment above
  agentId === "codex"
    ? new CodexAdapter()
    : new ClaudeAdapter(new ClaudeProcess());

// Only auto-start when run directly (not when imported for testing)
if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  const worker = new SessionWorker({
    agentFactory: createWorkerAgent,
    port: Number(process.env.WORKER_PORT) || 9100,
    workspaceDir: process.env.WORKSPACE_DIR || CONTAINER_WORKSPACE_DIR,
  });

  const address = await worker.start();
  console.log(`[session-worker] Listening on ${address}`);

  // Graceful shutdown
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, async () => {
      console.log(`[session-worker] Received ${signal}, shutting down`);
      await worker.stop();
      process.exit(0);
    });
  }
}
