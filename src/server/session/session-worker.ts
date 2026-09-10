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
import {
  CONTAINER_WORKSPACE_DIR,
  CONTAINER_SESSION_STATE_DIR,
  DEP_CACHE_CONTAINER_PATH,
} from "../shared/fs-constants.js";
import {
  getNodeRuntimeStatus,
  resolveNodeCacheDir,
  startNodeRuntimeProvisioning,
} from "./node-runtime.js";
import { getErrorMessage } from "../shared/utils.js";
import { ClaudeProcess } from "./agents/claude/process.js";
import { ClaudeAdapter } from "./agents/claude/adapter.js";
import { CodexAdapter } from "./agents/codex/adapter.js";
import { OpencodeAdapter } from "./agents/opencode/adapter.js";
import { GrokAdapter } from "./agents/grok/adapter.js";
import { registerAgentOpsRoutes } from "./agent-ops-routes.js";
import { registerWorkerAuthGuard, requireWorkerToken } from "./worker-auth-guard.js";
import { normalizeAskQuestions } from "./ask-question.js";
import type { OrchestratorClient } from "./orchestrator-client.js";
import { ServiceRequestQueue } from "./service-request-queue.js";
import { serviceRequestTimeoutMs, serviceTimeoutMessage } from "./service-request-timeouts.js";
import { SseBroadcaster } from "./sse-broadcaster.js";
import type { SseClient, WorkerSSEEvent } from "./sse-broadcaster.js";
import { PresentRegistry, derivePresentId } from "./present-registry.js";
import {
  registerPresentFilesRoutes,
  inferPresentMimeType,
} from "./present-view.js";
import { McpConfigController } from "./mcp-config-controller.js";
import { AgentController, type WorkerAgentFactory } from "./agent-controller.js";
import { TerminalController } from "./terminal-controller.js";
import { FileWatcherController } from "./file-watcher-controller.js";
import { InstallController } from "./install-controller.js";
import { preparePlugins, type PluginPrepareResult } from "./plugin-runtime.js";
import { ensurePluginBinOnPath } from "./plugin-cli.js";

export type { WorkerSSEEvent } from "./sse-broadcaster.js";
export type { WorkerAgentFactory } from "./agent-controller.js";

export interface SessionWorkerDeps {
  agentFactory: WorkerAgentFactory;
  port?: number;
  host?: string;
  workspaceDir?: string;
  stateDir?: string;
  createFileWatcher?: () => FileWatcher;
  createTerminal?: () => TerminalProcess;
  createOrchestratorClient?: () => OrchestratorClient;
  /** Required in containers; omission restricts test workers to loopback callers. */
  workerToken?: string;
}

export class SessionWorker extends EventEmitter {
  private app: FastifyInstance;
  private readonly sse: SseBroadcaster;
  private port: number;
  private host: string;
  private workspaceDir: string;
  private _pluginPrepare: Promise<PluginPrepareResult> | null = null;
  private _pluginPrepareQueued: Promise<PluginPrepareResult> | null = null;
  private stateDir: string;
  private _createOrchestratorClient?: () => OrchestratorClient;
  private readonly _workerToken: string | undefined;

  private readonly mcpConfig: McpConfigController;
  private readonly agentController: AgentController;
  private readonly terminalController: TerminalController;
  private readonly fileWatcherController: FileWatcherController;
  private readonly installController: InstallController;

  private readonly serviceRequests = new ServiceRequestQueue();

  private _injectedSecretNames = new Set<string>();

  private readonly presentRegistry = new PresentRegistry();

  private readonly permissionBroker: PermissionBroker;

  constructor(deps: SessionWorkerDeps) {
    super();
    this.port = deps.port ?? 9100;
    this.host = deps.host ?? "0.0.0.0";
    this.workspaceDir = deps.workspaceDir ?? "/workspace";
    this.stateDir = deps.stateDir
      ?? process.env.SHIPIT_SESSION_STATE_DIR
      ?? CONTAINER_SESSION_STATE_DIR;
    this._createOrchestratorClient = deps.createOrchestratorClient;
    this._workerToken = deps.workerToken;

    // Set PATH before any child spawns; plugin preparation may finish later.
    ensurePluginBinOnPath();

    const broadcast = (event: WorkerSSEEvent): void => this.sse.broadcast(event);

    this.sse = new SseBroadcaster({
      onBackpressureChange: () => this.terminalController.applyBackpressure(),
    });
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
      oldestSseSeq: () => this.sse.oldestSeq,
      otherWorkerLiveness: () => ({
        terminalActive: this.terminalController.hasActiveTerminal(),
        installRunning: this.installController.installRunning,
      }),
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
      stateDir: this.stateDir,
      broadcast,
      mcpConfig: this.mcpConfig,
    });

    this.app = this.buildApp();
  }

  private buildApp(): FastifyInstance {
    const app = Fastify({ logger: false });

    // Register auth before routes: other session containers can reach the worker's port.
    registerWorkerAuthGuard(app, { token: this._workerToken });

    app.get("/health", async () => ({ status: "ok" }));

    app.get("/node-runtime", async () => getNodeRuntimeStatus());

    this.agentController.registerRoutes(app);
    this.terminalController.registerRoutes(app);
    this.fileWatcherController.registerRoutes(app);
    this.installController.registerRoutes(app);

    this.registerPluginEndpoint(app);
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

  private registerServiceEndpoints(app: FastifyInstance): void {
    app.get("/services/list", async () => {
      return this.sendServiceRequest("list");
    });

    app.get<{ Querystring: { name?: string; lines?: string } }>("/services/logs", async (request, reply) => {
      const { name, lines } = request.query ?? {};
      if (typeof name !== "string" || !name) {
        return reply.code(400).send({ error: "name is required" });
      }
      const parsed = parseInt(lines ?? "", 10);
      return this.sendServiceRequest("logs", name, {
        lines: Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
      });
    });

    app.post<{ Body: { name: string; timeoutMs?: number } }>("/services/start", async (request, reply) => {
      const { name, timeoutMs } = request.body ?? {};
      if (typeof name !== "string" || !name) {
        return reply.code(400).send({ error: "name is required" });
      }
      return this.sendServiceRequest("start", name, { timeoutMs });
    });

    app.post<{ Body: { name: string } }>("/services/stop", async (request, reply) => {
      const { name } = request.body ?? {};
      if (typeof name !== "string" || !name) {
        return reply.code(400).send({ error: "name is required" });
      }
      return this.sendServiceRequest("stop", name);
    });

    app.post<{ Body: { name: string; timeoutMs?: number } }>("/services/restart", async (request, reply) => {
      const { name, timeoutMs } = request.body ?? {};
      if (typeof name !== "string" || !name) {
        return reply.code(400).send({ error: "name is required" });
      }
      return this.sendServiceRequest("restart", name, { timeoutMs });
    });

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

  private registerPluginEndpoint(app: FastifyInstance): void {
    app.post("/plugins/prepare", async () => await this.enqueuePluginPrepare());
  }

  private enqueuePluginPrepare(): Promise<PluginPrepareResult> {
    // A caller during preparation may have newer state. Queue one fresh pass instead of joining.
    if (!this._pluginPrepare) {
      this._pluginPrepare = Promise.resolve(preparePlugins({ workspaceDir: this.workspaceDir })).finally(() => {
        this._pluginPrepare = null;
      });
      return this._pluginPrepare;
    }
    this._pluginPrepareQueued ??= (async () => {
      await this._pluginPrepare?.catch(() => undefined);
      // Clear before rerunning so later requests queue behind the new pass.
      this._pluginPrepareQueued = null;
      return await this.enqueuePluginPrepare();
    })();
    return this._pluginPrepareQueued;
  }

  private registerSecretsEndpoint(app: FastifyInstance): void {
    // Replace the complete set. Changes apply only to subsequently spawned processes.
    app.put<{ Body: { secrets: Record<string, string> } }>("/secrets", async (request, reply) => {
      const { secrets } = request.body ?? {};
      if (!secrets || typeof secrets !== "object" || Array.isArray(secrets)) {
        return reply.code(400).send({ error: "secrets must be an object" });
      }

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

      for (const name of this._injectedSecretNames) {
        if (!(name in secrets)) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- intentional process.env mutation
          delete process.env[name];
        }
      }

      for (const [name, value] of Object.entries(secrets)) {
        process.env[name] = value;
      }

      this._injectedSecretNames = new Set(Object.keys(secrets));
      return { applied: this._injectedSecretNames.size };
    });
  }

  // Emit here: Codex reports MCP calls only after completion, but ask waits for an interrupt.
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

  private registerPermissionEndpoints(app: FastifyInstance): void {
    app.post<{ Body: { toolName?: string; input?: Record<string, unknown>; toolUseId?: string } }>(
      "/agent-ops/permission/request",
      async (request, reply) => {
        const body = request.body ?? {};
        if (typeof body.toolName !== "string" || !body.toolName) {
          return reply.code(400).send({ error: "toolName is required" });
        }
        const agentId = this.agentController.currentAgentId;
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
        return { resolved: found };
      },
    );
  }

  private registerPresentEndpoints(app: FastifyInstance): void {
    app.post<{
      Body: {
        file?: string;
        mimeType?: string;
        title?: string;
        inline?: boolean;
      };
    }>("/agent-ops/present/submit", async (request, reply) => {
      const { file, mimeType, title, inline } = request.body ?? {};
      if (typeof file !== "string" || file.length === 0) {
        return reply.code(400).send({ error: "file is required and must be a path string" });
      }
      const resolvedPath = path.isAbsolute(file)
        ? file
        : path.resolve(this.workspaceDir, file);
      const overrideMime =
        typeof mimeType === "string" && mimeType.length > 0 ? mimeType : undefined;
      const resolvedMime =
        overrideMime ?? (inferPresentMimeType(resolvedPath) || "text/plain");

      try {
        await fsp.access(resolvedPath, fs.constants.R_OK);
      } catch (err) {
        return reply.code(400).send({
          error: `Could not read file "${file}": ${getErrorMessage(err)}`,
        });
      }

      const resolvedTitle =
        typeof title === "string" && title.length > 0 ? title : undefined;
      const sessionId = process.env.SESSION_ID ?? "";

      const presentId = derivePresentId(sessionId, resolvedPath);
      const createdAt = new Date().toISOString();
      const meta = this.presentRegistry.put(presentId, {
        resolvedPath,
        filePath: file,
        mimeType: resolvedMime,
        createdAt,
        ...(resolvedTitle !== undefined ? { title: resolvedTitle } : {}),
        ...(inline === true ? { inline: true } : {}),
      });

      this.broadcastSSE({
        type: "present_content",
        data: {
          sessionId,
          presentId,
          mimeType: meta.mimeType,
          ...(meta.title !== undefined ? { title: meta.title } : {}),
          filePath: meta.filePath,
          createdAt: meta.createdAt,
          ...(meta.inline ? { inline: true } : {}),
          // The orchestrator saves this path to restore the registry after worker recreation.
          resolvedPath: meta.resolvedPath,
        },
      });

      const viewUrl = `http://127.0.0.1:${this.port}/present-files/${presentId}`;
      return { presentId, status: "presented", viewUrl };
    });

    registerPresentFilesRoutes(app, this.presentRegistry);
  }

  private sendServiceRequest(
    action: string,
    name?: string,
    opts: { timeoutMs?: number; lines?: number } = {},
  ): Promise<unknown> {
    const timeoutMs = serviceRequestTimeoutMs(action, opts.timeoutMs);
    const { requestId, promise } = this.serviceRequests.enqueue(action, {
      timeoutMs,
      timeoutMessage: serviceTimeoutMessage,
    });
    this.broadcastSSE({
      type: "service_request",
      data: { requestId, action, name, lines: opts.lines },
    });
    return promise;
  }

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

      // Child agents can finish before SSE connects; replay their buffered events.
      const sinceParam = (request.query as { since?: string } | undefined)?.since;
      const sinceSeq = sinceParam !== undefined ? Number.parseInt(sinceParam, 10) : 0;
      this.sse.replaySince(client, Number.isFinite(sinceSeq) && sinceSeq > 0 ? sinceSeq : 0);

      // Reset the unbuffered terminal and restore install outcomes evicted from the buffer.
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

  private broadcastSSE(event: WorkerSSEEvent): void {
    this.sse.broadcast(event);
  }

  async start(): Promise<string> {
    const address = await this.app.listen({ port: this.port, host: this.host });
    return address;
  }

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

  getApp(): FastifyInstance { return this.app; }
}

// Adapter construction is the allowed agent-discriminator switch.
export const createWorkerAgent: WorkerAgentFactory = (agentId: AgentId) =>
  // eslint-disable-next-line no-restricted-syntax -- docs/155 hair 11: see comment above
  agentId === "codex"
    ? new CodexAdapter()
    : // eslint-disable-next-line no-restricted-syntax -- docs/155 hair 11: same construction switch
      agentId === "opencode"
      ? new OpencodeAdapter()
      : // eslint-disable-next-line no-restricted-syntax -- docs/155 hair 11: same construction switch
        agentId === "grok"
        ? new GrokAdapter()
        : new ClaudeAdapter(new ClaudeProcess());

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  const workspaceDir = process.env.WORKSPACE_DIR || CONTAINER_WORKSPACE_DIR;

  // Container workers must have a token before opening their listener.
  let workerToken: string;
  try {
    workerToken = requireWorkerToken(process.env);
  } catch (err) {
    console.error(`[session-worker] refusing to start: ${(err as Error).message}`);
    process.exit(1);
  }

  const worker = new SessionWorker({
    agentFactory: createWorkerAgent,
    port: Number(process.env.WORKER_PORT) || 9100,
    workspaceDir,
    workerToken,
  });

  // Provision outside the constructor to keep tests offline; spawn paths await readiness.
  const nodeStateDir = process.env.SHIPIT_SESSION_STATE_DIR ?? CONTAINER_SESSION_STATE_DIR;
  startNodeRuntimeProvisioning({
    workspaceDir,
    stateDir: nodeStateDir,
    cacheDir: resolveNodeCacheDir(DEP_CACHE_CONTAINER_PATH, nodeStateDir),
  });

  const address = await worker.start();
  console.log(`[session-worker] Listening on ${address}`);

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, async () => {
      console.log(`[session-worker] Received ${signal}, shutting down`);
      await worker.stop();
      process.exit(0);
    });
  }
}
