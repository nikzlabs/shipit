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
 */

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import type {
  AgentProcess,
  AgentRunParams,
  AgentEvent,
  AgentId,
  AgentMcpReviewBridge,
  AgentMcpPresentBridge,
  AgentMcpVoiceBridge,
  AgentMcpAskBridge,
  AgentMcpBugBridge,
  AgentMcpWriteResult,
  McpServerConfig,
} from "./agents/agent-process.js";
import type { PermissionMode } from "../shared/types.js";
import { substituteMcpPlaceholders } from "./mcp-resolve.js";
import { TerminalProcess } from "./terminal.js";
import { FileWatcher } from "./file-watcher.js";
import os from "node:os";
import { CONTAINER_WORKSPACE_DIR } from "../shared/fs-constants.js";
import { scanFileTree } from "../shared/file-tree.js";
import { scanSkillsDir } from "../shared/skill-scan.js";
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
import { PresentBuffer, PresentBufferError } from "./present-buffer.js";
import {
  computeStoreKey,
  fastInstallDisabled,
  findLockfile,
  isCacheableInstall,
  materialize,
  nmStoreRoot,
  populateStore,
  runtimeKey,
  tuneNpmInstall,
} from "./nm-store.js";

export type { WorkerSSEEvent } from "./sse-broadcaster.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Factory function that creates an AgentProcess from an agent ID. */
export type WorkerAgentFactory = (agentId: AgentId) => AgentProcess;

/**
 * Resolved fast-install plan for a cacheable single-command install: where the
 * materialized `node_modules` store lives and the tuned command to run on a
 * miss. Produced by {@link SessionWorker.computeFastPath}.
 */
interface FastPathPlan { storeKey: string; storeDir: string; tunedCommand: string }

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
  private agent: AgentProcess | null = null;
  private agentFactory: WorkerAgentFactory;
  private readonly sse: SseBroadcaster;
  private port: number;
  private host: string;
  private workspaceDir: string;

  private terminal: TerminalProcess | null = null;
  private fileWatcher: FileWatcher | null = null;
  private _createFileWatcher: () => FileWatcher;
  private _createTerminal: () => TerminalProcess;
  private _createOrchestratorClient?: () => OrchestratorClient;

  // Service request/callback state — outgoing requests to the orchestrator
  // over SSE wait here for the orchestrator's /services/_callback POST.
  private readonly serviceRequests = new ServiceRequestQueue();

  // Phase 3 (087): names of secrets currently injected into process.env by
  // the orchestrator. Tracked so we can `delete process.env[name]` for keys
  // that are no longer marked `agent: true` after a compose-file edit.
  private _injectedSecretNames = new Set<string>();

  // Install state
  private _installRunning = false;
  private _installProcess: ChildProcess | null = null;
  /**
   * Last completed install's result. Retained across the worker process
   * lifetime (or until a new install starts) so the orchestrator can
   * recover on SSE reconnect: if the orchestrator's SSE drops between
   * `install_status: running` and the worker emitting `install_done`,
   * the orchestrator polls `/install/status` to discover the outcome
   * instead of waiting forever for an event that already fired.
   */
  private _lastInstallResult: { ok: boolean; command?: string; message?: string } | null = null;

  // Terminal backpressure state. The SseBroadcaster owns the per-client set
  // of backpressured responses and invokes our `onBackpressureChange`
  // callback when the aggregate state flips; `_terminalPaused` then mirrors
  // whether we've actually paused the PTY.
  private _terminalPaused = false;

  // docs/088 — MCP npm install state. Per-package mutex coalesces concurrent
  // install requests for the same package; `/tmp/mcp-installed.json` records
  // completed installs so a worker restart within the same container doesn't
  // reinstall (cross-container caching is out of scope for Phase 1).
  private _mcpInstallMutex = new Map<string, Promise<void>>();
  private static readonly MCP_INSTALLED_MARKER = "/tmp/mcp-installed.json";

  // docs/093 — present tool buffer. Holds the bytes the agent emitted via
  // `present` so the client can render them and "Save to project" can copy
  // them into the workspace exactly as they were displayed. Bounded by entry
  // count + total bytes (see PresentBuffer).
  private readonly presentBuffer = new PresentBuffer();

  constructor(deps: SessionWorkerDeps) {
    super();
    this.agentFactory = deps.agentFactory;
    this.port = deps.port ?? 9100;
    this.host = deps.host ?? "0.0.0.0";
    this.workspaceDir = deps.workspaceDir ?? "/workspace";
    this._createFileWatcher = deps.createFileWatcher ?? (() => new FileWatcher());
    this._createTerminal = deps.createTerminal ?? (() => new TerminalProcess());
    this._createOrchestratorClient = deps.createOrchestratorClient;
    this.sse = new SseBroadcaster({
      onBackpressureChange: () => this.applyTerminalBackpressure(),
    });
    this.app = this.buildApp();
  }

  private buildApp(): FastifyInstance {
    const app = Fastify({ logger: false });

    app.get("/health", async () => ({ status: "ok" }));
    this.registerSessionEndpoints(app);
    this.registerSSEEndpoint(app);
    this.registerAskEndpoint(app);
    registerAgentOpsRoutes(app, {
      createOrchestratorClient: this._createOrchestratorClient,
    });

    return app;
  }

  /**
   * Build the per-spawn context the adapter's `writeMcpConfig()` consumes.
   * The worker owns the cross-cutting bits — the user-configured server list,
   * the resolved review-bridge install paths, and the SSE failure broadcast —
   * and the adapter owns the CLI-specific wire format. (docs/155 hair 10)
   */
  private invokeAgentMcpWriter(
    agent: AgentProcess,
    params?: AgentRunParams,
  ): AgentMcpWriteResult {
    return agent.writeMcpConfig({
      servers: params?.mcpServers ?? [],
      reviewBridge: this.reviewBridgePaths(),
      presentBridge: this.presentBridgePaths(),
      voiceBridge: this.voiceBridgePaths(),
      askBridge: this.askBridgePaths(),
      bugBridge: this.bugBridgePaths(),
      onServerFailed: (name, reason) => {
        this.broadcastSSE({
          type: "mcp_server_status",
          data: { name, state: "failed", reason },
        });
      },
    });
  }

  /**
   * Resolve the absolute paths needed to launch the review MCP bridge
   * (docs/125): the `tsx` binary and `mcp-review-bridge.ts`, both relative to
   * this module. Returns null if either is missing so a stripped-down or
   * non-container environment doesn't break agent start. Mirrors the Dockerfile
   * `gh` shim's tsx-by-absolute-path invocation.
   */
  private reviewBridgePaths(): AgentMcpReviewBridge | null {
    const sessionDir = path.dirname(fileURLToPath(import.meta.url));
    const bridgePath = path.join(sessionDir, "mcp-review-bridge.ts");
    // <root>/src/server/session → <root>/node_modules/.bin/tsx
    const tsxBin = path.resolve(sessionDir, "../../../node_modules/.bin/tsx");
    if (!fs.existsSync(bridgePath) || !fs.existsSync(tsxBin)) return null;
    return { tsxBin, bridgePath };
  }

  /**
   * Resolve the absolute paths needed to launch the present MCP bridge
   * (docs/093). Same lifecycle and graceful-degradation rules as the review
   * bridge above — if the bridge or `tsx` is missing (e.g. a stripped-down
   * test image), return null and the adapter omits the entry rather than
   * failing agent start.
   */
  private presentBridgePaths(): AgentMcpPresentBridge | null {
    const sessionDir = path.dirname(fileURLToPath(import.meta.url));
    const bridgePath = path.join(sessionDir, "mcp-present-bridge.ts");
    const tsxBin = path.resolve(sessionDir, "../../../node_modules/.bin/tsx");
    if (!fs.existsSync(bridgePath) || !fs.existsSync(tsxBin)) return null;
    return { tsxBin, bridgePath };
  }

  /**
   * Resolve the absolute paths needed to launch the voice-note MCP bridge
   * (docs/163). Same lifecycle and graceful-degradation rules as the review
   * and present bridges — if the bridge or `tsx` is missing, return null and
   * the adapter omits the entry rather than failing agent start.
   */
  private voiceBridgePaths(): AgentMcpVoiceBridge | null {
    const sessionDir = path.dirname(fileURLToPath(import.meta.url));
    const bridgePath = path.join(sessionDir, "mcp-voice-bridge.ts");
    const tsxBin = path.resolve(sessionDir, "../../../node_modules/.bin/tsx");
    if (!fs.existsSync(bridgePath) || !fs.existsSync(tsxBin)) return null;
    return { tsxBin, bridgePath };
  }

  /**
   * Resolve the absolute paths needed to launch the ask-user MCP bridge
   * (docs/147). Same lifecycle and graceful-degradation rules as the other
   * bridges — if the bridge or `tsx` is missing, return null and the adapter
   * omits the entry rather than failing agent start. Only Codex registers it;
   * Claude has a native `AskUserQuestion` tool and ignores this.
   */
  private askBridgePaths(): AgentMcpAskBridge | null {
    const sessionDir = path.dirname(fileURLToPath(import.meta.url));
    const bridgePath = path.join(sessionDir, "mcp-ask-bridge.ts");
    const tsxBin = path.resolve(sessionDir, "../../../node_modules/.bin/tsx");
    if (!fs.existsSync(bridgePath) || !fs.existsSync(tsxBin)) return null;
    return { tsxBin, bridgePath };
  }

  /**
   * Resolve the absolute paths needed to launch the bug-report MCP bridge
   * (docs/164). Same lifecycle and graceful-degradation rules as the review,
   * present, and voice bridges — if the bridge or `tsx` is missing, return
   * null and the adapter omits the entry rather than failing agent start.
   */
  private bugBridgePaths(): AgentMcpBugBridge | null {
    const sessionDir = path.dirname(fileURLToPath(import.meta.url));
    const bridgePath = path.join(sessionDir, "mcp-bug-bridge.ts");
    const tsxBin = path.resolve(sessionDir, "../../../node_modules/.bin/tsx");
    if (!fs.existsSync(bridgePath) || !fs.existsSync(tsxBin)) return null;
    return { tsxBin, bridgePath };
  }

  private withTemporaryEnv<T>(values: Record<string, string>, fn: () => T): T {
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(values)) {
      previous.set(key, process.env[key]);
      process.env[key] = value;
    }
    try {
      return fn();
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
  }

  // --- Session mode endpoints (agent, terminal, file watcher) ---

  private registerSessionEndpoints(app: FastifyInstance): void {
    // --- Agent endpoints ---

    app.post<{ Body: { agentId: AgentId; params: AgentRunParams; runToken?: string } }>("/agent/start", async (request, reply) => {
      if (this.agent) {
        return reply.code(409).send({ error: "Agent already running" });
      }

      const { agentId, params, runToken } = request.body;
      if (!agentId || !params) {
        return reply.code(400).send({ error: "agentId and params are required" });
      }

      try {
        // docs/155 hair 10 — each adapter knows its own MCP wire format
        // (Claude: per-turn `--mcp-config` JSON; Codex: `config.toml` block;
        // Cursor: `mcp.json`). The worker hands over the cross-cutting
        // context (user-configured servers, review-bridge paths, SSE
        // failure channel) and consumes a uniform { mcpConfigPath?,
        // runtimeEnv?, cleanup? } result.
        this.agent = this.agentFactory(agentId);
        this.wireAgentEvents(this.agent, runToken);
        const mcpWrite = this.invokeAgentMcpWriter(this.agent, params);

        this.withTemporaryEnv(mcpWrite.runtimeEnv ?? {}, () => {
          this.agent?.run({
            ...params,
            cwd: this.workspaceDir,
            mcpConfigPath: mcpWrite.mcpConfigPath,
          });
        });

        if (mcpWrite.cleanup) {
          this.agent.on("done", mcpWrite.cleanup);
        }

        return { started: true };
      } catch (err) {
        this.agent = null;
        return reply.code(500).send({ error: getErrorMessage(err) });
      }
    });

    app.post("/agent/interrupt", async (_request, reply) => {
      if (!this.agent) {
        return reply.code(404).send({ error: "No agent running" });
      }
      this.agent.interrupt();
      return { interrupted: true };
    });

    app.post("/agent/kill", async (_request, reply) => {
      if (!this.agent) {
        return reply.code(404).send({ error: "No agent running" });
      }
      this.agent.kill();
      this.agent = null;
      return { killed: true };
    });

    app.post<{ Body: { data: string } }>("/agent/stdin", async (request, reply) => {
      if (!this.agent) {
        return reply.code(404).send({ error: "No agent running" });
      }
      const { data } = request.body;
      if (typeof data !== "string") {
        return reply.code(400).send({ error: "data must be a string" });
      }
      this.agent.writeStdin(data);
      return { written: true };
    });

    // POST /agent/permission-mode — change the resident agent's permission
    // mode mid-stream without a restart. The adapter pushes a
    // `set_permission_mode` control_request onto the streaming CLI's stdin;
    // adapters that don't support mid-stream switching (one-shot PTY) no-op.
    // See docs/138 / docs/140 for the protocol details. `mode: null` is the
    // wire encoding for ShipIt "auto" (no flag), so the JSON body always
    // travels as a string-or-null.
    const ALLOWED_MODES = new Set(["plan", "guarded", "auto"]);
    app.post<{ Body: { mode: string | null } }>(
      "/agent/permission-mode",
      async (request, reply) => {
        if (!this.agent) {
          return reply.code(404).send({ error: "No agent running" });
        }
        if (!this.agent.setPermissionMode) {
          return reply.code(400).send({ error: "Agent does not support mid-stream permission-mode changes" });
        }
        const raw = request.body?.mode;
        let mode: PermissionMode | undefined;
        if (raw === null || raw === undefined) {
          mode = undefined;
        } else if (typeof raw === "string" && ALLOWED_MODES.has(raw)) {
          mode = raw as PermissionMode;
        } else {
          return reply.code(400).send({ error: `Invalid mode: ${JSON.stringify(raw)}` });
        }
        this.agent.setPermissionMode(mode);
        return { success: true };
      },
    );

    // POST /agent/message — inject a user message (live steering, docs/140)
    app.post<{ Body: { text: string } }>(
      "/agent/message",
      async (request, reply) => {
        const text = request.body?.text;
        const snippet = typeof text === "string" ? JSON.stringify(text.slice(0, 80)) : "<non-string>";
        if (!this.agent) {
          console.warn(`[steer-worker] /agent/message rejected: no agent running (text=${snippet})`);
          return reply.code(400).send({ error: "No agent running" });
        }
        if (typeof text !== "string" || !text) {
          console.warn(`[steer-worker] /agent/message rejected: text is required (got ${typeof text})`);
          return reply.code(400).send({ error: "text is required" });
        }
        // docs/140 diag — confirm the worker accepted and forwarded to the
        // adapter. The adapter (`[claude-adapter]`) and CLI-stdin
        // (`[streaming-claude]`) logs follow.
        console.log(
          `[steer-worker] /agent/message → agent.sendUserMessage (bytes=${text.length}, text=${snippet})`,
        );
        this.agent.sendUserMessage(text);
        return { success: true };
      },
    );

    app.get("/agent/status", async () => ({
      running: this.agent !== null,
    }));

    // --- Terminal endpoints ---

    app.post<{ Body: { cols?: number; rows?: number } }>("/terminal/start", async (request) => {
      if (this.terminal) {
        return { started: true, existing: true };
      }

      const body = (request.body ?? {}) as { cols?: number; rows?: number };
      const cols = typeof body.cols === "number" ? Math.max(1, Math.min(500, body.cols)) : 80;
      const rows = typeof body.rows === "number" ? Math.max(1, Math.min(200, body.rows)) : 24;

      this.terminal = this._createTerminal();
      this.wireTerminalEvents(this.terminal);
      this.terminal.start(this.workspaceDir, cols, rows);
      return { started: true };
    });

    app.post<{ Body: { data: string } }>("/terminal/input", async (request, reply) => {
      if (!this.terminal) {
        return reply.code(404).send({ error: "No terminal running" });
      }
      const { data } = request.body;
      if (typeof data !== "string") {
        return reply.code(400).send({ error: "data must be a string" });
      }
      this.terminal.write(data);
      return { written: true };
    });

    app.post<{ Body: { cols: number; rows: number } }>("/terminal/resize", async (request, reply) => {
      if (!this.terminal) {
        return reply.code(404).send({ error: "No terminal running" });
      }
      const body = request.body;
      const cols = typeof body.cols === "number" ? Math.max(1, Math.min(500, body.cols)) : 80;
      const rows = typeof body.rows === "number" ? Math.max(1, Math.min(200, body.rows)) : 24;
      this.terminal.resize(cols, rows);
      return { resized: true };
    });

    // --- File watcher endpoints ---

    app.post("/files/watch", async () => {
      if (this.fileWatcher) {
        return { watching: true, existing: true };
      }
      this.fileWatcher = this._createFileWatcher();
      this.wireFileWatcherEvents(this.fileWatcher);
      this.fileWatcher.start(this.workspaceDir);
      return { watching: true };
    });

    app.post("/files/unwatch", async () => {
      if (this.fileWatcher) {
        this.fileWatcher.stop();
        this.fileWatcher.removeAllListeners();
        this.fileWatcher = null;
      }
      return { stopped: true };
    });

    app.get("/files/tree", async () => {
      const tree = await scanFileTree(this.workspaceDir);
      return { tree };
    });

    // GET /codex/skills — Codex's built-in system skills, scanned from
    // `~/.codex/skills/<name>/SKILL.md` *inside the container*. CODEX_HOME is
    // unset in ShipIt containers, so this defaults to ~/.codex (= /root/.codex),
    // a container-only path the orchestrator cannot read over the HTTP link.
    // The orchestrator merges these into GET /api/sessions/:id/skills as
    // `source: "bundled"`. See docs/138-skill-invocation (change #5b).
    app.get("/codex/skills", async () => {
      const skillsDir = path.join(os.homedir(), ".codex", "skills");
      const skills = await scanSkillsDir(skillsDir, "bundled");
      skills.sort((a, b) => a.name.localeCompare(b.name));
      return { skills };
    });

    // --- Service control endpoints (called by agent) ---

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

    // --- Install endpoint ---

    app.post<{ Body: { commands: string[] } }>("/install", async (request, reply) => {
      const { commands } = request.body ?? {};
      if (!Array.isArray(commands) || commands.length === 0) {
        return reply.code(400).send({ error: "commands array is required" });
      }

      // Check marker file — skip if install already completed. Check before
      // the `running` guard so a pre-install that finished + wrote the marker
      // (warm-pool path) but hasn't yet flipped `_installRunning` to false on
      // a racy caller still short-circuits cleanly.
      const markerDir = path.join(this.workspaceDir, ".shipit");
      const markerFile = path.join(markerDir, ".install-done");
      if (fs.existsSync(markerFile)) {
        return { skipped: true, reason: "marker" };
      }

      if (this._installRunning) {
        // Join the in-flight install instead of failing. The caller awaits the
        // SSE-delivered `install_done` / `install_error` event for completion,
        // so reporting `started: true` (vs the previous 409) lets the warm-pool
        // pre-install and the on-activation install converge on the same run.
        return { started: true, joined: true };
      }

      this._installRunning = true;
      // New install starts — clear any previous result so the SSE-reconnect
      // resync path doesn't surface a stale outcome from a prior install.
      this._lastInstallResult = null;

      // Fast path (docs/148 + docs/162 fast-install gate race): a cache HIT is
      // resolved SYNCHRONOUSLY inside this request and reported in the HTTP
      // response (`{ completed: true }`), so the orchestrator settles its
      // install gate directly from the response. Completion of a hit must NOT
      // depend on the SSE-delivered `install_done` event: on the fast path that
      // event can be broadcast within a few ms — before/at the same tick as the
      // orchestrator arms its gate resolver or its SSE handshake completes — and
      // be consumed while the resolver is null, leaving the gate (and the user's
      // first turn) blocked forever. A MISS falls through to the streamed real
      // install exactly as before (returns `{ started: true }`, completes via
      // SSE).
      let fast: FastPathPlan | null = null;
      try {
        fast = this.computeFastPath(commands);
      } catch {
        fast = null;
      }
      if (fast) {
        const materialized = await this.tryMaterializeFromStore(fast).catch(() => false);
        if (materialized) {
          this.finishInstallOk(markerDir, markerFile);
          return { completed: true, ok: true };
        }
      }

      // Miss (or non-cacheable command set) — run the real install in the
      // background; progress and completion stream via SSE.
      void this.runRealInstallCommands(commands, fast, markerDir, markerFile);
      return { started: true };
    });

    // Install state probe — used by the orchestrator's SSE reconnect path
    // to recover from a missed install_done/install_error. See
    // `ContainerSessionRunner.resyncInstallStateAfterReconnect()`.
    app.get("/install/status", async () => ({
      running: this._installRunning,
      lastResult: this._lastInstallResult,
    }));

    // --- MCP endpoints (docs/088-mcp-integration) ---

    // Install npm packages for stdio MCP servers. Runs at session activation,
    // alongside the existing `agent.install` step. Packages already recorded
    // in /tmp/mcp-installed.json are skipped. Concurrent requests for the same
    // package coalesce via the per-package mutex.
    app.post<{ Body: { packages?: string[] } }>("/mcp/install", async (request, reply) => {
      const { packages } = request.body ?? {};
      if (!Array.isArray(packages) || packages.some((p) => typeof p !== "string")) {
        return reply.code(400).send({ error: "packages must be an array of strings" });
      }
      const installed = this.readMcpInstalledMarker();
      const pending = [...new Set(packages)].filter((p) => p && !installed.has(p));
      if (pending.length === 0) {
        return { installed: [], skipped: packages };
      }
      const results = await Promise.allSettled(
        pending.map((pkg) => this.installMcpPackage(pkg)),
      );
      const ok: string[] = [];
      const failed: { package: string; error: string }[] = [];
      results.forEach((r, i) => {
        const pkg = pending[i];
        if (r.status === "fulfilled") {
          ok.push(pkg);
        } else {
          const error = getErrorMessage(r.reason);
          failed.push({ package: pkg, error });
          this.broadcastSSE({
            type: "mcp_server_status",
            data: { name: pkg, state: "failed", reason: `install failed: ${error}` },
          });
        }
      });
      return { installed: ok, failed };
    });

    // Connectivity test — spawn the configured stdio server (or open the HTTP
    // connection), run `initialize` + `tools/list`, tear it down. The config
    // arrives with `$secret:` placeholders; resolve them locally first.
    app.post<{ Body: { config?: McpServerConfig } }>("/mcp/test", async (request, reply) => {
      const { config } = request.body ?? {};
      if (!config || typeof config !== "object") {
        return reply.code(400).send({ error: "config is required" });
      }
      const { testMcpServer } = await import("./mcp-test.js");
      const resolved = this.resolveMcpServerConfig(config);
      if (!resolved.ok) {
        return { ok: false, error: resolved.error };
      }
      return testMcpServer(resolved.config);
    });

    this.registerPresentEndpoints(app);
  }

  // --- AskUserQuestion bridge endpoint (docs/147) ---

  /**
   * `POST /agent-ops/ask/submit` — receives a structured question from the
   * `mcp-ask-bridge` subprocess (a child of the Codex CLI) and injects it into
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
          } as AgentEvent,
        });

        return { status: "asked" };
      },
    );
  }

  // --- Present tool endpoints (docs/093) ---

  /**
   * Wire the two HTTP surfaces the `present` tool needs:
   *
   *  - `POST /agent-ops/present/submit` — receives the artifact from the
   *    `mcp-present-bridge` subprocess (which runs as a child of the agent
   *    CLI). Stores it in the buffer, broadcasts `present_content` over SSE,
   *    and returns the new `presentId` to the bridge.
   *  - `POST /present/save` — the orchestrator forwards the user's "Save to
   *    project" click here. Copies the buffered bytes to the requested
   *    workspace path. Path is checked to live under the workspace so a
   *    crafted body can't escape with `..`.
   *
   * The submit route lives under `/agent-ops/*` to stay alongside the other
   * shim brokers (review, gh, shipit). Save lives under `/present/*` because
   * the orchestrator initiates it on the user's behalf, not the agent.
   */
  private registerPresentEndpoints(app: FastifyInstance): void {
    app.post<{
      Body: {
        content?: string;
        mimeType?: string;
        title?: string;
        replaceId?: string;
      };
    }>("/agent-ops/present/submit", async (request, reply) => {
      const { content, mimeType, title, replaceId } = request.body ?? {};
      if (typeof content !== "string" || content.length === 0) {
        return reply.code(400).send({ error: "content is required and must be a string" });
      }
      const resolvedMime =
        typeof mimeType === "string" && mimeType.length > 0 ? mimeType : "text/html";
      const resolvedTitle =
        typeof title === "string" && title.length > 0 ? title : undefined;
      const resolvedReplaceId =
        typeof replaceId === "string" && replaceId.length > 0 ? replaceId : undefined;
      const sessionId = process.env.SESSION_ID ?? "";

      const presentId = `pres_${crypto.randomUUID()}`;
      let result: ReturnType<PresentBuffer["put"]>;
      try {
        result = this.presentBuffer.put(presentId, {
          content,
          mimeType: resolvedMime,
          ...(resolvedTitle !== undefined ? { title: resolvedTitle } : {}),
          ...(resolvedReplaceId !== undefined ? { replaceId: resolvedReplaceId } : {}),
        });
      } catch (err) {
        if (err instanceof PresentBufferError) {
          return reply.code(413).send({ error: err.message });
        }
        return reply.code(500).send({ error: getErrorMessage(err) });
      }

      this.broadcastSSE({
        type: "present_content",
        data: {
          sessionId,
          presentId,
          ...(resolvedReplaceId !== undefined ? { replaceId: resolvedReplaceId } : {}),
          content: result.entry.content,
          mimeType: result.entry.mimeType,
          ...(result.entry.title !== undefined ? { title: result.entry.title } : {}),
          createdAt: result.entry.createdAt,
        },
      });

      for (const evictedId of result.evicted) {
        this.broadcastSSE({
          type: "present_cleared",
          data: { sessionId, presentId: evictedId },
        });
      }

      return { presentId, status: "presented" };
    });

    app.post<{
      Body: { presentId?: string; destPath?: string };
    }>("/present/save", async (request, reply) => {
      const { presentId, destPath } = request.body ?? {};
      if (typeof presentId !== "string" || presentId.length === 0) {
        return reply.code(400).send({ error: "presentId is required" });
      }
      if (typeof destPath !== "string" || destPath.length === 0) {
        return reply.code(400).send({ error: "destPath is required" });
      }
      const entry = this.presentBuffer.get(presentId);
      if (!entry) {
        return reply.code(404).send({ error: "Presentation not found or already evicted" });
      }

      // Resolve the destination strictly inside the workspace. Reject any
      // attempt to escape via leading `/`, `..`, or symlink-like games. The
      // path is mounted by the user via the Save dialog, so a redirect to
      // /etc/passwd would be a real footgun.
      const workspaceRoot = path.resolve(this.workspaceDir);
      const normalized = destPath.startsWith("/")
        ? destPath.slice(1)
        : destPath;
      const absolutePath = path.resolve(workspaceRoot, normalized);
      const inside = absolutePath === workspaceRoot
        || absolutePath.startsWith(`${workspaceRoot}${path.sep}`);
      if (!inside) {
        return reply.code(400).send({
          error: "destPath must resolve inside the workspace",
        });
      }

      try {
        await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
        // Binary content arrives as a data URI; decode it before writing so
        // the saved file isn't a base64-encoded text blob.
        if (entry.content.startsWith("data:")) {
          const match = /^data:[^;]+;base64,(.+)$/.exec(entry.content);
          if (match) {
            await fsp.writeFile(absolutePath, Buffer.from(match[1], "base64"));
          } else {
            // Non-base64 data URI (rare): write the raw string after the comma.
            const comma = entry.content.indexOf(",");
            await fsp.writeFile(
              absolutePath,
              comma >= 0 ? entry.content.slice(comma + 1) : entry.content,
            );
          }
        } else {
          await fsp.writeFile(absolutePath, entry.content, "utf8");
        }
      } catch (err) {
        return reply.code(500).send({ error: getErrorMessage(err) });
      }

      const relPath = path.relative(workspaceRoot, absolutePath);
      return { ok: true, savedPath: relPath };
    });
  }

  // --- MCP helpers (docs/088) ---

  /** Read the set of MCP npm packages already installed in this container. */
  private readMcpInstalledMarker(): Set<string> {
    try {
      const raw = fs.readFileSync(SessionWorker.MCP_INSTALLED_MARKER, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return new Set(parsed.filter((p): p is string => typeof p === "string"));
    } catch {
      /* no marker yet */
    }
    return new Set();
  }

  /** Append a package to the installed-marker file. */
  private recordMcpInstalled(pkg: string): void {
    const installed = this.readMcpInstalledMarker();
    installed.add(pkg);
    try {
      fs.writeFileSync(SessionWorker.MCP_INSTALLED_MARKER, JSON.stringify([...installed]));
    } catch (err) {
      console.warn("[mcp] failed to write installed marker:", getErrorMessage(err));
    }
  }

  /** `npm install -g <pkg>` with a per-package mutex. */
  private installMcpPackage(pkg: string): Promise<void> {
    const existing = this._mcpInstallMutex.get(pkg);
    if (existing) return existing;
    const run = new Promise<void>((resolve, reject) => {
      const proc = spawn("npm", ["install", "-g", pkg], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NODE_ENV: "development" },
      });
      let stderr = "";
      proc.stdout?.on("data", (c: Buffer) =>
        this.broadcastSSE({ type: "install_log", data: { text: c.toString(), stream: "stdout" } }),
      );
      proc.stderr?.on("data", (c: Buffer) => {
        stderr += c.toString();
        this.broadcastSSE({ type: "install_log", data: { text: c.toString(), stream: "stderr" } });
      });
      proc.on("error", (err) => reject(err));
      proc.on("close", (code) => {
        if (code === 0) {
          this.recordMcpInstalled(pkg);
          resolve();
        } else {
          reject(new Error(stderr.trim().slice(-400) || `npm exited with code ${code}`));
        }
      });
    }).finally(() => {
      this._mcpInstallMutex.delete(pkg);
    });
    this._mcpInstallMutex.set(pkg, run);
    return run;
  }

  /**
   * Resolve `$secret:` and `$platform:` placeholders in a user MCP server
   * config against `process.env`, returning a fully-resolved
   * `McpServerConfig`. Used by the test endpoint. Returns `{ ok: false }`
   * when a referenced secret/token is absent.
   *
   * Delegates substitution to the shared {@link substituteMcpPlaceholders}
   * helper so the test path understands the exact same placeholder forms as
   * the adapter's `writeMcpConfig()` — including `$platform:<source>` used by
   * OAuth-managed servers. Without this, testing a connected Notion/Linear
   * server sent the literal `$platform:…` header and the provider returned a
   * misleading 401.
   */
  private resolveMcpServerConfig(
    server: McpServerConfig,
  ): { ok: true; config: McpServerConfig } | { ok: false; error: string } {
    const missing: string[] = [];
    const subst = (value: string): string =>
      substituteMcpPlaceholders(value, process.env, missing);
    const substRecord = (rec?: Record<string, string>): Record<string, string> | undefined => {
      if (!rec) return undefined;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(rec)) out[k] = subst(v);
      return out;
    };

    let config: McpServerConfig;
    if (server.type === "stdio") {
      config = {
        ...server,
        ...(server.args ? { args: server.args.map(subst) } : {}),
        ...(server.env ? { env: substRecord(server.env) } : {}),
      };
    } else {
      config = {
        ...server,
        ...(server.headers ? { headers: substRecord(server.headers) } : {}),
      };
    }
    if (missing.length > 0) {
      return { ok: false, error: `missing secret: ${[...new Set(missing)].join(", ")}` };
    }
    return { ok: true, config };
  }

  // --- Install command execution ---

  /**
   * Latch a successful install: write the marker, record the result, clear the
   * running flag, and broadcast `install_done`. Shared by the synchronous
   * fast-path HIT (handled inline in the /install handler) and the background
   * real-install path.
   *
   * State (`_lastInstallResult`, `_installRunning`) is updated BEFORE the
   * broadcast so an orchestrator that races to query `/install/status` right
   * after the SSE event sees a consistent `running: false` snapshot.
   */
  private finishInstallOk(markerDir: string, markerFile: string): void {
    this.writeMarker(markerDir, markerFile);
    this._lastInstallResult = { ok: true };
    this._installRunning = false;
    this._installProcess = null;
    this.broadcastSSE({ type: "install_done", data: {} });
  }

  /**
   * Run the real (non-cached) install path, streaming output via SSE and
   * writing the marker on success. Reached on a fast-path MISS (or a
   * non-cacheable command set) — the synchronous cache-HIT path is handled
   * inline in the /install handler so its completion is reported in the HTTP
   * response rather than depending on the SSE `install_done` event.
   *
   * Fast path (docs/148): for a single bare `npm install|ci|i`, `yarn
   * [install]`, or `pnpm install|i` against a workspace with exactly one
   * lockfile, the handler first tries to copy in a previously-materialized
   * `node_modules`. On a miss we land here: for a fast-path candidate we
   * substitute the tuned command (Option E flags) so the populated store
   * reflects what was actually built, then publish the resulting tree to the
   * store via temp-dir + atomic rename (best-effort — a populate failure must
   * not fail the install, the workspace already has a working `node_modules`).
   */
  private async runRealInstallCommands(
    commands: string[],
    fast: FastPathPlan | null,
    markerDir: string,
    markerFile: string,
  ): Promise<void> {
    try {
      const resolvedCommands = fast ? [fast.tunedCommand] : commands;
      for (const cmd of resolvedCommands) {
        const exitCode = await this.runSingleInstallCommand(cmd);
        if (exitCode !== 0) {
          const message = `Command "${cmd}" exited with code ${exitCode}`;
          this._lastInstallResult = { ok: false, command: cmd, message };
          // Update terminal state BEFORE broadcasting so an orchestrator that
          // races to query `/install/status` after the SSE event sees a
          // consistent `running: false` snapshot.
          this._installRunning = false;
          this._installProcess = null;
          this.broadcastSSE({
            type: "install_error",
            data: { command: cmd, exitCode, message },
          });
          return;
        }
      }

      if (fast) {
        await this.tryPopulateStore(fast).catch((err: unknown) => {
          console.warn(
            `[install] populateStore failed for ${fast.storeKey}:`,
            getErrorMessage(err),
          );
        });
      }

      this.finishInstallOk(markerDir, markerFile);
    } catch (err) {
      const message = getErrorMessage(err);
      this._lastInstallResult = { ok: false, message };
      this._installRunning = false;
      this._installProcess = null;
      this.broadcastSSE({
        type: "install_error",
        data: { message },
      });
    }
  }

  /**
   * Decide whether the install request is a fast-path candidate. Returns
   * the resolved store path + tuned command on success, or null when any
   * gate fails (kill switch, non-cacheable command, multi-command sequence,
   * 0 or multiple lockfiles).
   */
  private computeFastPath(commands: string[]): FastPathPlan | null {
    if (fastInstallDisabled()) {
      console.log("[install] fast path disabled via SHIPIT_FAST_INSTALL=disabled");
      return null;
    }
    if (commands.length !== 1) return null;
    const raw = commands[0];
    if (!isCacheableInstall(raw)) return null;
    const lockfile = findLockfile(this.workspaceDir);
    if (!lockfile) return null;
    const tunedCommand = tuneNpmInstall(raw);
    const storeKey = computeStoreKey({
      lockfile,
      runtimeKey: runtimeKey(),
      installCommand: tunedCommand,
    });
    const storeDir = path.join(nmStoreRoot(), storeKey);
    return { storeKey, storeDir, tunedCommand };
  }

  /**
   * Look up the store and materialize on hit. Returns true on a successful
   * materialize (`node_modules` is ready, caller writes the marker).
   * Returns false when there is no store, or when every rung of the
   * materialize ladder fails — in either case the caller drops to a real
   * install, which also self-heals by repopulating the store.
   */
  private async tryMaterializeFromStore(fast: FastPathPlan): Promise<boolean> {
    let exists = false;
    try {
      const st = fs.statSync(fast.storeDir);
      exists = st.isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) {
      console.log(`[install] fast-path miss storeKey=${fast.storeKey.slice(0, 12)}`);
      return false;
    }
    const t0 = Date.now();
    const dest = path.join(this.workspaceDir, "node_modules");
    const result = await materialize(fast.storeDir, dest);
    if (!result.ok) {
      console.warn(
        `[install] materialize failed storeKey=${fast.storeKey.slice(0, 12)} ` +
          `error=${result.error ?? "unknown"} — falling back to real install`,
      );
      return false;
    }
    const ms = Date.now() - t0;
    console.log(
      `[install] fast-path hit storeKey=${fast.storeKey.slice(0, 12)} ` +
        `strategy=${result.strategy} took=${ms}ms`,
    );
    this.broadcastSSE({
      type: "install_log",
      data: {
        text: `[fast-install] restored node_modules from cache (${result.strategy}, ${ms}ms)\n`,
        stream: "stdout",
      },
    });
    return true;
  }

  /**
   * Publish the freshly-installed `node_modules` to the store after a
   * successful real install. No-op when `node_modules` doesn't exist
   * (Yarn Berry/PnP layouts use `.pnp.cjs` instead).
   */
  private async tryPopulateStore(
    fast: { storeKey: string; storeDir: string },
  ): Promise<void> {
    const src = path.join(this.workspaceDir, "node_modules");
    try {
      const st = await fsp.stat(src);
      if (!st.isDirectory()) return;
    } catch {
      // No `node_modules` — Yarn Berry/PnP, or a lockfile-only no-op install.
      return;
    }
    const t0 = Date.now();
    const { published } = await populateStore(src, fast.storeDir);
    const ms = Date.now() - t0;
    if (published) {
      console.log(
        `[install] populated nm-store storeKey=${fast.storeKey.slice(0, 12)} took=${ms}ms`,
      );
    } else {
      console.log(
        `[install] nm-store already published for storeKey=${fast.storeKey.slice(0, 12)} ` +
          `(raced another populate)`,
      );
    }
  }

  /** Write the `.shipit/.install-done` marker. */
  private writeMarker(markerDir: string, markerFile: string): void {
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(markerFile, new Date().toISOString());
  }

  /**
   * Run a single install command and return its exit code.
   * Streams stdout/stderr via SSE.
   *
   * Forces `NODE_ENV=development` so devDependencies (tsc, vitest, eslint, etc.)
   * are installed — the agent needs them to typecheck, test, and lint. The prod
   * session-worker image sets `NODE_ENV=production` at the container level,
   * which would otherwise cause `npm install` to skip devDependencies. Users can
   * still override by prefixing their install command (e.g. `NODE_ENV=production
   * npm install --omit=dev`); shell prefixes win over the spawned env.
   */
  private runSingleInstallCommand(command: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, {
        shell: true,
        cwd: this.workspaceDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NODE_ENV: "development" },
      });
      this._installProcess = proc;

      proc.stdout?.on("data", (chunk: Buffer) => {
        this.broadcastSSE({
          type: "install_log",
          data: { text: chunk.toString(), stream: "stdout" },
        });
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        this.broadcastSSE({
          type: "install_log",
          data: { text: chunk.toString(), stream: "stderr" },
        });
      });

      proc.on("error", (err) => {
        this._installProcess = null;
        reject(err);
      });

      proc.on("close", (code) => {
        this._installProcess = null;
        resolve(code ?? 1);
      });
    });
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
      if (this.terminal) {
        this.sse.sendTo(client, { type: "terminal_data", data: { data: "" } });
      }
      if (this._lastInstallResult && !this._installRunning) {
        if (this._lastInstallResult.ok) {
          this.sse.sendTo(client, { type: "install_done", data: {} });
        } else {
          this.sse.sendTo(client, {
            type: "install_error",
            data: {
              command: this._lastInstallResult.command,
              message: this._lastInstallResult.message ?? "Install failed",
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

  // --- Event wiring ---

  /**
   * Wire agent events to the SSE stream.
   *
   * `runToken` is the orchestrator's per-SPAWN correlation token (see
   * `ProxyAgentProcess.runToken`). It is captured in the done/error/
   * auth_required closures and stamped onto those SSE events so the
   * orchestrator can tell a stale exit from a previous spawn apart from the
   * current one and refuse to null the live `_agent` slot. Undefined for
   * callers that don't supply one (legacy / direct test starts) — the
   * orchestrator then falls back to its object-identity guards.
   */
  private wireAgentEvents(agent: AgentProcess, runToken?: string): void {
    agent.on("event", (event: AgentEvent) => {
      this.broadcastSSE({ type: "agent_event", data: event });
    });

    // Capture `agent` in the closure so the done/error handlers compare against
    // the specific instance they were wired to. Without this guard, a late
    // `done` from an OLD streaming process (killed by /agent/kill during the
    // 409-retry dance in container-session-runner.ts) would null out the
    // freshly-spawned NEW agent that already replaced `this.agent`, stranding
    // the worker with no agent reference while the new CLI keeps running.
    //
    // The captured `runToken` is the orchestrator-side correlation for the SAME
    // purpose across the SSE boundary: the orchestrator can't compare process
    // identity, so it compares this token (see container-session-runner.ts
    // `isStaleSpawnEvent`).
    agent.on("done", (exitCode: number) => {
      this.broadcastSSE({ type: "agent_done", data: { exitCode, runToken } });
      if (this.agent === agent) {
        this.agent = null;
      }
    });

    agent.on("error", (err: Error) => {
      this.broadcastSSE({ type: "agent_error", data: { message: err.message, runToken } });
      if (this.agent === agent) {
        this.agent = null;
      }
    });

    agent.on("auth_required", () => {
      this.broadcastSSE({ type: "agent_auth_required", data: { runToken } });
    });

    agent.on("log", (source: string, text: string) => {
      this.broadcastSSE({ type: "agent_log", data: { source, text } });
    });

    // docs/088: per-MCP-server liveness reported by the CLI (Claude's init
    // event populates this; Codex never emits). One SSE event per server so
    // the orchestrator's relay (container-session-runner.ts) doesn't need to
    // unpack arrays.
    agent.on("mcp_status", (statuses) => {
      for (const status of statuses) {
        this.broadcastSSE({
          type: "mcp_server_status",
          data: status,
        });
      }
    });
  }

  /** Wire terminal events to the SSE stream. */
  private wireTerminalEvents(terminal: TerminalProcess): void {
    terminal.on("data", (data: string) => {
      this.broadcastSSE({ type: "terminal_data", data: { data } });
    });

    terminal.on("exit", (exitCode: number | null) => {
      this._terminalPaused = false;
      this.broadcastSSE({ type: "terminal_exit", data: { exitCode } });
      this.terminal = null;
    });
  }

  /** Wire file watcher events to the SSE stream. */
  private wireFileWatcherEvents(watcher: FileWatcher): void {
    watcher.on("changes", (paths: string[]) => {
      this.broadcastSSE({ type: "file_changes", data: { paths } });
    });
  }

  /** Send an SSE event to all connected clients. */
  private broadcastSSE(event: WorkerSSEEvent): void {
    this.sse.broadcast(event);
  }

  /**
   * Pause or resume the terminal PTY based on SSE backpressure state.
   * Invoked by the SseBroadcaster's onBackpressureChange callback whenever
   * the aggregate "any client backpressured" state flips.
   */
  private applyTerminalBackpressure(): void {
    if (this.sse.hasBackpressure()) {
      if (!this._terminalPaused && this.terminal) {
        this.terminal.pause();
        this._terminalPaused = true;
      }
    } else {
      if (this._terminalPaused && this.terminal) {
        this.terminal.resume();
        this._terminalPaused = false;
      }
    }
  }

  /** Start the worker server. Returns the address it's listening on. */
  async start(): Promise<string> {
    const address = await this.app.listen({ port: this.port, host: this.host });
    return address;
  }

  /** Stop the worker server and clean up. */
  async stop(): Promise<void> {
    if (this._installProcess) {
      this._installProcess.kill();
      this._installProcess = null;
      this._installRunning = false;
    }
    if (this.agent) {
      this.agent.kill();
      this.agent = null;
    }
    if (this.terminal) {
      this.terminal.kill();
      this.terminal = null;
      this._terminalPaused = false;
    }
    if (this.fileWatcher) {
      this.fileWatcher.stop();
      this.fileWatcher.removeAllListeners();
      this.fileWatcher = null;
    }
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
