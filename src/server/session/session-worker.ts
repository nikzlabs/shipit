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
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import type {
  AgentProcess,
  AgentRunParams,
  AgentEvent,
  AgentId,
  AgentMcpBridge,
  AgentMcpWriteResult,
  McpServerConfig,
} from "./agents/agent-process.js";
import type { PermissionDecision, PermissionMode } from "../shared/types.js";
import { PermissionBroker } from "./permission-broker.js";
import { resolveBridge } from "./mcp-bridge-paths.js";
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
import { PresentRegistry } from "./present-registry.js";
import {
  registerPresentFilesRoutes,
  inferPresentMimeType,
} from "./present-view.js";
import { runtimeKey, tuneNpmInstall } from "./install-runtime.js";
import {
  makeMarker,
  markerMatches,
  parseMarker,
  serializeMarker,
  type InstallMarkerStamp,
} from "../shared/install-marker.js";
import { emptyDepDirsContradictingMarker } from "./overlay-dep-check.js";
import { computeInstallDepsHash } from "../shared/deps-hash.js";
import { resolveShipitConfig } from "../shared/shipit-config.js";
import { createDepSnapshotTar, safeDepDirRelpath } from "./dep-snapshot.js";
import {
  runAgentToCompletion,
  buildSubAgentRunParams,
  type SubAgentRunHandle,
} from "../shared/sub-agent-run.js";

export type { WorkerSSEEvent } from "./sse-broadcaster.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Factory function that creates an AgentProcess from an agent ID. */
export type WorkerAgentFactory = (agentId: AgentId) => AgentProcess;

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

  // docs/144 — in-flight sub-agent spawns, keyed by orchestrator-supplied
  // spawnId. These run OUTSIDE the single-occupant `this.agent` slot as plain
  // subprocesses and never broadcast to SSE; their output is returned
  // synchronously over the `/agent/spawn` HTTP response. Tracked so an explicit
  // `/agent/cancel` (or a primary-turn interrupt/kill) can SIGTERM them.
  private readonly spawnedAgents = new Map<string, SubAgentRunHandle>();

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
    // docs/193 — the broker broadcasts its canonical request/resolved events on
    // the same `agent_event` SSE frame the ask bridge uses, so they reach the
    // orchestrator's agent-listeners and render/persist the permission card.
    this.permissionBroker = new PermissionBroker({
      broadcast: (event) => this.broadcastSSE({ type: "agent_event", data: event }),
    });
    this.app = this.buildApp();
  }

  private buildApp(): FastifyInstance {
    const app = Fastify({ logger: false });

    app.get("/health", async () => ({ status: "ok" }));
    this.registerSessionEndpoints(app);
    this.registerSSEEndpoint(app);
    this.registerAskEndpoint(app);
    this.registerPermissionEndpoints(app);
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
      shipitBridge: this.shipitBridgePaths(),
      onServerFailed: (name, reason) => {
        this.broadcastSSE({
          type: "mcp_server_status",
          data: { name, state: "failed", reason },
        });
      },
    });
  }

  /**
   * Resolve how to launch the consolidated internal MCP bridge (SHI-128).
   * `resolveBridge` (docs/199) prefers the precompiled JS bundle in
   * `dist/mcp-bridges/` (launched with `node` — no per-spawn tsx compile, which
   * is what made the bridges miss the CLI's 2000ms MCP pre-wait at the 0.5-CPU
   * AGENT_DEFAULTS) and falls back to running the `.ts` source through tsx in
   * dev/local images. Returns null when neither exists (stripped-down test
   * image) so the adapter omits the entry rather than failing agent start. The
   * adapter selects which tools the `shipit` server exposes (review/present/
   * voice/bug/permission for Claude; review/present/voice/ask/bug for Codex) via
   * the `SHIPIT_MCP_TOOLS` env — there is one process, not six.
   */
  private shipitBridgePaths(): AgentMcpBridge | null {
    return resolveBridge("mcp-shipit-bridge");
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

  /** docs/144 — SIGTERM every in-flight sub-agent spawn (symmetric cancel). */
  private cancelAllSpawns(): void {
    for (const handle of this.spawnedAgents.values()) {
      try { handle.cancel(); } catch { /* best-effort */ }
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
        // docs/193 — give an adapter with a native blocking approval channel
        // (Codex) the broker so its escalation requests surface the same
        // approve/deny card as Claude's sensitive-file gate, rather than being
        // silently auto-approved. Claude has no such channel here — its gate is
        // bridged via `--permission-prompt-tool` (the `shipit` bridge's permission tool).
        this.agent.setPermissionRequester?.((input) => this.permissionBroker.request(input));
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
      // docs/144 — interrupting the primary turn cancels any sub-agent running
      // on its behalf (symmetric cancel). Do this even when `this.agent` is null
      // (a sub-agent can outlive a transient primary-slot gap).
      this.cancelAllSpawns();
      if (!this.agent) {
        return reply.code(404).send({ error: "No agent running" });
      }
      this.agent.interrupt();
      return { interrupted: true };
    });

    app.post("/agent/kill", async (_request, reply) => {
      this.cancelAllSpawns();
      if (!this.agent) {
        return reply.code(404).send({ error: "No agent running" });
      }
      this.agent.kill();
      this.agent = null;
      return { killed: true };
    });

    // docs/144 — spawn a one-shot SUB-AGENT subprocess. This is a NEW code path,
    // not a reuse of `/agent/start`: it instantiates a fresh per-agent adapter
    // OUTSIDE the single-occupant slot (`this.agent` is untouched), wires its
    // events into a local result accumulator instead of the broadcast SSE, and
    // returns the accumulated final assistant text synchronously. The
    // orchestrator (`services/sub-agent.ts`) owns authorization, credentials,
    // and the per-turn cap; the worker just runs the adapter. Two CLI processes
    // are alive during the spawn window (the primary, blocked on the caller's
    // `shipit agent` shell call, and this sub-agent).
    app.post<{ Body: { agentId: AgentId; prompt: string; spawnId: string; depth?: number; model?: string; timeoutMs?: number; maxOutputChars?: number } }>(
      "/agent/spawn",
      async (request, reply) => {
        const { agentId, prompt, spawnId, depth, model, timeoutMs, maxOutputChars } = request.body ?? {};
        if (!agentId || typeof prompt !== "string" || !spawnId) {
          return reply.code(400).send({ error: "agentId, prompt, and spawnId are required" });
        }
        let agent: AgentProcess;
        try {
          agent = this.agentFactory(agentId);
        } catch (err) {
          return reply.code(400).send({ error: `Unknown agent: ${agentId} (${getErrorMessage(err)})` });
        }

        const runOpts = {
          prompt,
          cwd: this.workspaceDir,
          ...(model !== undefined ? { model } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(maxOutputChars !== undefined ? { maxOutputChars } : {}),
        };
        const handle = runAgentToCompletion(agent, runOpts, Date.now());
        this.spawnedAgents.set(spawnId, handle);
        try {
          // Stamp SHIPIT_AGENT_DEPTH = caller depth + 1 on the subprocess env so
          // the sub-agent's own `shipit agent` calls forward a non-zero depth and
          // are rejected by the orchestrator's recursion guard. withTemporaryEnv
          // restores process.env after the synchronous spawn; the child has
          // already captured the value.
          const childDepth = String((depth ?? 0) + 1);
          this.withTemporaryEnv({ SHIPIT_AGENT_DEPTH: childDepth }, () => {
            agent.run(buildSubAgentRunParams(runOpts));
          });
          return await handle.promise;
        } catch (err) {
          return await reply.code(500).send({ error: getErrorMessage(err) });
        } finally {
          this.spawnedAgents.delete(spawnId);
          try { agent.kill(); } catch { /* already exited */ }
        }
      },
    );

    // docs/144 — explicitly cancel an in-flight sub-agent spawn by id.
    app.post<{ Body: { spawnId?: string } }>("/agent/cancel", async (request, reply) => {
      const spawnId = request.body?.spawnId;
      if (!spawnId) {
        return reply.code(400).send({ error: "spawnId is required" });
      }
      const handle = this.spawnedAgents.get(spawnId);
      if (!handle) {
        return reply.code(404).send({ error: "No such spawn" });
      }
      handle.cancel();
      return { cancelled: true };
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

    // POST /agent/compact — trigger a context compaction on the resident agent
    // (docs/178). Claude (streaming) injects the `/compact` slash command; Codex
    // (live thread) sends the `thread/compact/start` RPC. Adapters that don't
    // implement compact(), or have no resident process to talk to, no-op — the
    // orchestrator handles the non-resident case by spawning a `/compact` turn.
    app.post<{ Body: { instructions?: string } }>("/agent/compact", async (request, reply) => {
      if (!this.agent) {
        return reply.code(404).send({ error: "No agent running" });
      }
      if (!this.agent.compact) {
        return reply.code(400).send({ error: "Agent does not support compaction" });
      }
      const instructions = typeof request.body?.instructions === "string" ? request.body.instructions : undefined;
      this.agent.compact(instructions);
      return { success: true };
    });

    app.get("/agent/status", async () => ({
      running: this.agent !== null,
      latestSseSeq: this.sse.latestSeq,
    }));

    // --- Terminal endpoints ---

    app.post<{ Body: { cols?: number; rows?: number } }>("/terminal/start", async (request) => {
      if (this.terminal) {
        return { started: true, existing: true };
      }

      const body = (request.body ?? {});
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

      // Check the stamped marker — skip only when it EXACTLY matches this
      // session's install context (source commit + runtime fingerprint +
      // install commands), per docs/183 Phase 3. Presence alone is no longer
      // enough: a session over a shared overlay base inherits the base's marker
      // from the lowerdir, so the stamp is what proves the base's deps still fit
      // this checkout/runtime/command. A mismatch (non-default checkout,
      // force-push, edited install command, incompatible runtime) or a legacy
      // bare-timestamp marker is treated as a miss — the stale marker is removed
      // and `agent.install` re-runs. Checked before the `running` guard so a
      // finished pre-install that wrote the marker (warm-pool path) but hasn't
      // yet flipped `_installRunning` still short-circuits cleanly.
      const markerDir = path.join(this.workspaceDir, ".shipit");
      const markerFile = path.join(markerDir, ".install-done");
      const stamp: InstallMarkerStamp = {
        sourceCommit: await this.readSourceCommit(),
        runtimeKey: runtimeKey(),
        installCommands: commands,
        // docs/197 — content key over the dependency input files. Lets a
        // different commit whose dep files are byte-identical skip the install.
        // `null` (codegen install / no `install-inputs` / no input files) falls
        // back to commit-only matching.
        depsHash: this.computeDepsHash(commands),
      };
      if (await this.installMarkerMatches(markerFile, stamp)) {
        // docs/183 — a matching marker is only trustworthy if every declared dep
        // dir actually holds content. The marker lives in the host clone; the
        // deps live in the dep dir (an overlay mount when OVERLAY_DEP_STORE is on,
        // a plain dir in the clone otherwise), and the two can disagree:
        //   • Flag newly ON: a container recreated with the flag enabled mounts an
        //     EMPTY overlay over previously-installed deps — skipping would leave
        //     the session dep-less AND let the publish hook capture the empty view
        //     as the scope's shared base.
        //   • Flag rolled OFF (the documented incident response, FINDINGS #3): a
        //     session whose deps lived in the overlay gets its container recreated
        //     with the flag off — no overlay mount, but the dep dir left behind in
        //     the host clone is EMPTY. The marker still matches exactly, so the
        //     old overlay-mount-only check skipped → dep-less session.
        // Distrusting a matching marker over a present-but-EMPTY dep dir,
        // regardless of mount type, closes both. An ABSENT dep dir is NOT a
        // contradiction, so a legitimately dep-less repo (e.g. default
        // node_modules on a non-Node repo) and the `agent.dep-dirs: []` opt-out
        // keep the marker-skip — non-overlay/no-deps sessions stay unchanged.
        const contradicted = emptyDepDirsContradictingMarker(this.workspaceDir);
        if (contradicted.length === 0) {
          return { skipped: true, reason: "marker" };
        }
        console.warn(
          `[install] marker matched but declared dep dir(s) are empty: ` +
          `${contradicted.map((c) => (c.overlay ? `${c.depDir} (overlay)` : c.depDir)).join(", ")} ` +
          `— treating as a miss and reinstalling`,
        );
      }
      // Stale / legacy / mismatched marker — whiteout it before reinstalling so
      // a partial reinstall can never leave an old stamp claiming success.
      await fsp.rm(markerFile, { force: true }).catch(() => {});

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

      // Run `agent.install` in the background; progress and completion stream
      // via SSE (`install_done` / `install_error`). The lockfile-keyed copy
      // store fast path (docs/148) was removed in docs/183 Phase 1 — the
      // overlay rolling base will reclaim the install-extract cost instead.
      void this.runRealInstallCommands(commands, markerDir, markerFile, stamp);
      return { started: true };
    });

    // Install state probe — used by the orchestrator's SSE reconnect path
    // to recover from a missed install_done/install_error. See
    // `ContainerSessionRunner.resyncInstallStateAfterReconnect()`.
    app.get("/install/status", async () => ({
      running: this._installRunning,
      lastResult: this._lastInstallResult,
    }));

    // docs/183 — the merged-workspace HEAD commit. The overlay publish
    // path needs the source commit the install actually ran against to stamp the
    // candidate base and decide publish eligibility (source == remote default).
    // The orchestrator can't read it from the host upperdir (`.git` lives in the
    // merged tree, not the host storage path), so it asks the worker, which runs
    // `git rev-parse HEAD` in the same merged `/workspace` the agent sees.
    app.get("/workspace/head-commit", async () => ({
      commit: await this.readSourceCommit(),
      // docs/183 — the worker-side runtime fingerprint. The publish path records
      // it on the base pointer so a later same-commit session can be pre-stamped
      // with a marker the /install gate accepts (the gate compares against THIS
      // value, not the orchestrator-side scope key).
      runtimeKey: runtimeKey(),
    }));

    // docs/183 Phase 4 — stream a single dep dir's merged contents as a tar so the
    // orchestrator can publish it as the next rolling base for that dep dir. The
    // merged view exists only inside the container; this is the HTTP-only pull.
    app.get<{ Querystring: { path?: string } }>("/workspace/dep-snapshot", async (request, reply) => {
      const rel = safeDepDirRelpath(request.query.path ?? "");
      if (!rel) return reply.code(400).send({ error: "invalid dep dir path" });
      const full = path.join(this.workspaceDir, rel);
      if (!fs.existsSync(full)) return reply.code(404).send({ error: `dep dir not found: ${rel}` });
      const { stream, done } = createDepSnapshotTar(this.workspaceDir, rel);
      // A non-zero tar exit means the piped archive is truncated; the consumer
      // validates extraction, but destroy the stream so a truncated tar surfaces
      // as a stream error rather than a silently-short archive.
      done.catch((err: unknown) => {
        console.warn(`[dep-snapshot] tar failed for ${rel}:`, err instanceof Error ? err.message : String(err));
        stream.destroy(err instanceof Error ? err : new Error(String(err)));
      });
      reply.header("content-type", "application/x-tar");
      return reply.send(stream);
    });

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
        // Non-blocking: register (or re-attach to) the request and return.
        const opened = this.permissionBroker.openRequest({
          toolName: body.toolName,
          input: body.input,
          ...(body.toolUseId ? { toolUseId: body.toolUseId } : {}),
          ...(this.agent?.agentId ? { agentId: this.agent.agentId } : {}),
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
   * running flag, and broadcast `install_done`.
   *
   * State (`_lastInstallResult`, `_installRunning`) is updated BEFORE the
   * broadcast so an orchestrator that races to query `/install/status` right
   * after the SSE event sees a consistent `running: false` snapshot.
   */
  private finishInstallOk(markerDir: string, markerFile: string, stamp: InstallMarkerStamp): void {
    this.writeMarker(markerDir, markerFile, stamp);
    this._lastInstallResult = { ok: true };
    this._installRunning = false;
    this._installProcess = null;
    this.broadcastSSE({ type: "install_done", data: {} });
  }

  /**
   * Run `agent.install`, streaming output via SSE and writing the marker on
   * success. Each command is passed through {@link tuneNpmInstall} so a bare
   * `npm install` lands fast on a warm download cache (`/dep-cache`, docs/075).
   *
   * The lockfile-keyed copy-store fast path (docs/148) was removed in docs/183
   * Phase 1: the overlay rolling base eliminates the install-extract cost
   * generically (whole-workspace, ecosystem-agnostic) instead of copying a
   * `node_modules` snapshot per session.
   */
  private async runRealInstallCommands(
    commands: string[],
    markerDir: string,
    markerFile: string,
    stamp: InstallMarkerStamp,
  ): Promise<void> {
    try {
      for (const rawCmd of commands) {
        const cmd = tuneNpmInstall(rawCmd);
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

      this.finishInstallOk(markerDir, markerFile, stamp);
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
   * Write the stamped `.shipit/.install-done` marker (docs/183 Phase 3). The
   * stamp records the source commit + runtime fingerprint + install commands
   * the install ran against, so a later `/install` skips only on an exact match.
   */
  private writeMarker(markerDir: string, markerFile: string, stamp: InstallMarkerStamp): void {
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(markerFile, serializeMarker(makeMarker(stamp, new Date().toISOString())));
  }

  /**
   * Read the stamped marker and report whether it exactly matches `stamp`.
   * A missing file, a legacy bare-timestamp marker, or a corrupt/future-version
   * stamp all parse to `null` and count as a miss — the caller then whiteouts
   * the marker and reinstalls.
   */
  private async installMarkerMatches(
    markerFile: string,
    stamp: InstallMarkerStamp,
  ): Promise<boolean> {
    let raw: string;
    try {
      raw = await fsp.readFile(markerFile, "utf8");
    } catch {
      return false; // no marker yet
    }
    const marker = parseMarker(raw);
    return marker !== null && markerMatches(marker, stamp);
  }

  /**
   * Compute the install marker's `depsHash` (docs/197) — a content hash of the
   * dependency input files, gated by the `agent.install` command allowlist and
   * an optional `agent.install-inputs` override (read from `shipit.yaml`). A
   * config-read failure or a non-content-keyable install both yield `null`,
   * which keeps the marker on the commit-only path.
   */
  private computeDepsHash(commands: string[]): string | null {
    let installInputs: string[] | null = null;
    try {
      installInputs = resolveShipitConfig(this.workspaceDir).agent.installInputs;
    } catch {
      // Unreadable/invalid config — fall back to the command-derived inputs.
    }
    return computeInstallDepsHash(this.workspaceDir, commands, installInputs);
  }

  /**
   * Resolve the git HEAD of the workspace for the marker stamp. Returns `null`
   * for a non-git workspace (standalone/template sessions), where the marker
   * simply omits the commit from its match decision. Best-effort: any git
   * failure also yields `null` rather than blocking the install.
   */
  private readSourceCommit(): Promise<string | null> {
    return new Promise((resolve) => {
      let out = "";
      let settled = false;
      const done = (v: string | null) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      try {
        const proc = spawn("git", ["rev-parse", "HEAD"], {
          cwd: this.workspaceDir,
          stdio: ["ignore", "pipe", "ignore"],
        });
        proc.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString(); });
        proc.on("error", () => done(null));
        proc.on("close", (code) => done(code === 0 && out.trim() ? out.trim() : null));
      } catch {
        done(null);
      }
    });
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
      // docs/193 — the backend process is gone; settle any held permission
      // promise internally so the worker doesn't leak. This broadcasts nothing,
      // so an unanswered card stays `pending` (no synthetic "expired" — ShipIt
      // imposes no deadline on the user's decision).
      this.permissionBroker.clearPending();
      this.broadcastSSE({ type: "agent_done", data: { exitCode, runToken } });
      if (this.agent === agent) {
        this.agent = null;
      }
    });

    agent.on("error", (err: Error) => {
      this.permissionBroker.clearPending();
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
