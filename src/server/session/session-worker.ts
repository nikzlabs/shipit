/**
 * Session Worker — lightweight Fastify server that runs inside each container
 * (or as a subprocess in non-Docker mode for testing).
 *
 * Supports two modes controlled by WORKER_MODE env var:
 * - "session" (default): agent, terminal, file watcher endpoints. No preview.
 * - "preview": preview server, secrets injection, health check. No agent/terminal.
 *
 * Streams events back to the orchestrator via SSE.
 * The orchestrator talks to this server over HTTP on port 9100 (or a
 * configured port).
 */

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import type { AgentProcess, AgentRunParams, AgentEvent, AgentId } from "./agents/agent-process.js";
import { TerminalProcess } from "./terminal.js";
import { PreviewManager } from "./preview-manager.js";
import { FileWatcher } from "./file-watcher.js";
import { CONTAINER_WORKSPACE_DIR } from "../shared/fs-constants.js";
import { scanFileTree } from "../shared/file-tree.js";
import type { ServerResponse } from "node:http";
import { getErrorMessage } from "../shared/utils.js";
import { ClaudeProcess } from "./claude.js";
import { ClaudeAdapter } from "./agents/claude-adapter.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Worker mode: session (agent/terminal/files) or preview (dev server/secrets). */
export type WorkerMode = "session" | "preview";

/** Event types sent over the SSE stream to the orchestrator. */
export interface WorkerSSEEvent {
  type:
    | "agent_event" | "agent_done" | "agent_error" | "agent_auth_required" | "agent_log"
    | "terminal_data" | "terminal_exit"
    | "preview_ready" | "preview_stopped" | "preview_config_missing"
    | "preview_config_error" | "preview_install_status" | "preview_startup_step" | "preview_log"
    | "file_changes";
  data: unknown;
}

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
  /** Worker mode: "session" or "preview". Defaults to "session". */
  workerMode?: WorkerMode;
  /** Factory for creating PreviewManager (injectable for testing). */
  createPreviewManager?: () => PreviewManager;
  /** Factory for creating FileWatcher (injectable for testing). */
  createFileWatcher?: () => FileWatcher;
  /** Factory for creating TerminalProcess (injectable for testing). */
  createTerminal?: () => TerminalProcess;
}

// ---------------------------------------------------------------------------
// SessionWorker
// ---------------------------------------------------------------------------

/**
 * The session worker manages a single agent process, terminal, preview server,
 * and file watcher. Exposes them over HTTP. SSE clients connect to GET /events
 * and receive real-time events.
 *
 * In "session" mode: agent, terminal, file watcher.
 * In "preview" mode: preview server, secrets injection.
 */
export class SessionWorker extends EventEmitter {
  private app: FastifyInstance;
  private agent: AgentProcess | null = null;
  private agentFactory: WorkerAgentFactory;
  private sseClients = new Set<(event: WorkerSSEEvent) => void>();
  private sseRawResponses = new Set<ServerResponse>();
  private port: number;
  private host: string;
  private workspaceDir: string;
  readonly workerMode: WorkerMode;

  // Phase 3: per-session resources
  private terminal: TerminalProcess | null = null;
  private preview: PreviewManager | null = null;
  private fileWatcher: FileWatcher | null = null;
  private _createPreviewManager: () => PreviewManager;
  private _createFileWatcher: () => FileWatcher;
  private _createTerminal: () => TerminalProcess;

  // Preview crash state for SSE replay
  private _previewLogBuffer: string[] = [];
  private static readonly MAX_PREVIEW_LOG_LINES = 50;
  private _lastPreviewExitCode: number | null = null;

  // Terminal backpressure state
  private _sseBackpressured = new Set<ServerResponse>();
  private _terminalPaused = false;

  // Secrets tracking (preview mode only) — tracks which keys were set by PUT /secrets
  private _trackedSecretKeys = new Set<string>();

  constructor(deps: SessionWorkerDeps) {
    super();
    this.agentFactory = deps.agentFactory;
    this.port = deps.port ?? 9100;
    this.host = deps.host ?? "0.0.0.0";
    this.workspaceDir = deps.workspaceDir ?? "/workspace";
    this.workerMode = deps.workerMode ?? "session";
    this._createPreviewManager = deps.createPreviewManager ?? (() => new PreviewManager());
    this._createFileWatcher = deps.createFileWatcher ?? (() => new FileWatcher());
    this._createTerminal = deps.createTerminal ?? (() => new TerminalProcess());
    this.app = this.buildApp();
  }

  private buildApp(): FastifyInstance {
    const app = Fastify({ logger: false });

    // Health check — always available in both modes
    app.get("/health", async () => ({ status: "ok", mode: this.workerMode }));

    if (this.workerMode === "session") {
      this.registerSessionEndpoints(app);
    } else {
      this.registerPreviewEndpoints(app);
    }

    // SSE event stream — available in both modes
    this.registerSSEEndpoint(app);

    return app;
  }

  /**
   * Generate an MCP config file for Playwright browser tools.
   * Only generated for the Claude agent (Codex doesn't support MCP).
   * Returns the config file path, or undefined if not applicable.
   */
  private generateMcpConfig(agentId: AgentId): string | undefined {
    if (agentId !== "claude") return undefined;

    const configPath = `/tmp/mcp-config-${Date.now()}.json`;
    const config = {
      mcpServers: {
        playwright: {
          command: "mcp-playwright",
          env: {
            PLAYWRIGHT_HEADLESS: "true",
          },
        },
      },
    };

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    return configPath;
  }

  // --- Session mode endpoints (agent, terminal, file watcher) ---

  private registerSessionEndpoints(app: FastifyInstance): void {
    // --- Agent endpoints ---

    app.post<{ Body: { agentId: AgentId; params: AgentRunParams } }>("/agent/start", async (request, reply) => {
      if (this.agent) {
        return reply.code(409).send({ error: "Agent already running" });
      }

      const { agentId, params } = request.body;
      if (!agentId || !params) {
        return reply.code(400).send({ error: "agentId and params are required" });
      }

      try {
        // Generate MCP config for Playwright browser tools
        const mcpConfigPath = this.generateMcpConfig(agentId);

        this.agent = this.agentFactory(agentId);
        this.wireAgentEvents(this.agent);
        this.agent.run({ ...params, cwd: this.workspaceDir, mcpConfigPath });

        // Clean up MCP config when agent finishes
        if (mcpConfigPath) {
          this.agent.on("done", () => {
            try { fs.unlinkSync(mcpConfigPath); } catch { /* ignore */ }
          });
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
  }

  // --- Preview mode endpoints (preview, secrets) ---

  private registerPreviewEndpoints(app: FastifyInstance): void {
    // --- Secrets endpoint ---

    app.put<{ Body: Record<string, string> }>("/secrets", async (request) => {
      const secrets = request.body ?? {};

      // Detect whether any env vars actually changed before restarting
      let changed = false;

      // Remove keys that were tracked but are absent from the new payload
      for (const key of this._trackedSecretKeys) {
        if (!(key in secrets)) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- cleaning up env vars by name
          delete process.env[key];
          changed = true;
        }
      }

      // Set new keys and update tracking
      const oldKeys = new Set(this._trackedSecretKeys);
      this._trackedSecretKeys.clear();
      for (const [key, value] of Object.entries(secrets)) {
        if (!oldKeys.has(key) || process.env[key] !== value) {
          changed = true;
        }
        process.env[key] = value;
        this._trackedSecretKeys.add(key);
      }

      // Restart the dev server only if env vars actually changed
      if (changed && this.preview?.running) {
        this.preview.restart(this.workspaceDir).catch((err: unknown) => {
          this.broadcastSSE({
            type: "preview_config_error",
            data: { message: getErrorMessage(err) },
          });
        });
      }

      return { updated: true, keyCount: Object.keys(secrets).length };
    });

    // --- Preview endpoints ---

    app.post("/preview/start", async (_request, reply) => {
      if (this.preview?.running) {
        return reply.code(409).send({ error: "Preview already running" });
      }

      this.preview = this._createPreviewManager();
      this.wirePreviewEvents(this.preview);
      this.preview.start(this.workspaceDir).catch((err: unknown) => {
        this.broadcastSSE({
          type: "preview_config_error",
          data: { message: getErrorMessage(err) },
        });
      });
      return { started: true };
    });

    app.post("/preview/stop", async () => {
      if (this.preview) {
        this.preview.stop();
        this.preview.removeAllListeners();
        this.preview = null;
      }
      return { stopped: true };
    });

    app.post("/preview/restart", async () => {
      if (this.preview) {
        this.preview.restart(this.workspaceDir).catch((err: unknown) => {
          this.broadcastSSE({
            type: "preview_config_error",
            data: { message: getErrorMessage(err) },
          });
        });
      } else {
        this.preview = this._createPreviewManager();
        this.wirePreviewEvents(this.preview);
        this.preview.start(this.workspaceDir).catch((err: unknown) => {
          this.broadcastSSE({
            type: "preview_config_error",
            data: { message: getErrorMessage(err) },
          });
        });
      }
      return { restarted: true };
    });

    app.get("/preview/status", async () => ({
      running: this.preview?.running ?? false,
      ports: this.preview?.ports ?? [],
    }));
  }

  // --- SSE event stream (both modes) ---

  private registerSSEEndpoint(app: FastifyInstance): void {
    app.get("/events", (request, reply) => {
      reply.hijack();

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });

      reply.raw.write(": connected\n\n");

      const sendEvent = (event: WorkerSSEEvent) => {
        try {
          const chunk = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
          const ok = reply.raw.write(chunk);
          if (!ok && event.type === "terminal_data" && !this._sseBackpressured.has(reply.raw)) {
            this._sseBackpressured.add(reply.raw);
            this.applyTerminalBackpressure();
            reply.raw.once("drain", () => {
              this._sseBackpressured.delete(reply.raw);
              this.applyTerminalBackpressure();
            });
          }
        } catch {
          this.sseClients.delete(sendEvent);
          this._sseBackpressured.delete(reply.raw);
        }
      };

      this.sseClients.add(sendEvent);
      this.sseRawResponses.add(reply.raw);

      // Replay current state so late-connecting clients don't miss events
      if (this.preview?.running && this.preview.ports.length > 0) {
        sendEvent({ type: "preview_ready", data: { ports: this.preview.ports } });
      } else if (this._lastPreviewExitCode !== null && this._lastPreviewExitCode !== undefined && !this.preview?.running) {
        for (const text of this._previewLogBuffer) {
          sendEvent({ type: "preview_log", data: { source: "preview", text } });
        }
        sendEvent({ type: "preview_stopped", data: { code: this._lastPreviewExitCode } });
      }
      if (this.terminal) {
        sendEvent({ type: "terminal_data", data: { data: "" } });
      }

      const keepalive = setInterval(() => {
        try {
          reply.raw.write(": keepalive\n\n");
        } catch {
          clearInterval(keepalive);
          this.sseClients.delete(sendEvent);
        }
      }, 15_000);

      request.raw.on("close", () => {
        clearInterval(keepalive);
        this.sseClients.delete(sendEvent);
        this.sseRawResponses.delete(reply.raw);
        if (this._sseBackpressured.delete(reply.raw)) {
          this.applyTerminalBackpressure();
        }
      });
    });
  }

  // --- Event wiring ---

  /** Wire agent events to the SSE stream. */
  private wireAgentEvents(agent: AgentProcess): void {
    agent.on("event", (event: AgentEvent) => {
      this.broadcastSSE({ type: "agent_event", data: event });
    });

    agent.on("done", (exitCode: number) => {
      this.broadcastSSE({ type: "agent_done", data: { exitCode } });
      this.agent = null;
    });

    agent.on("error", (err: Error) => {
      this.broadcastSSE({ type: "agent_error", data: { message: err.message } });
      this.agent = null;
    });

    agent.on("auth_required", () => {
      this.broadcastSSE({ type: "agent_auth_required", data: {} });
    });

    agent.on("log", (source: string, text: string) => {
      this.broadcastSSE({ type: "agent_log", data: { source, text } });
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

  /** Wire preview manager events to the SSE stream. */
  private wirePreviewEvents(preview: PreviewManager): void {
    preview.on("ready", (ports: number[]) => {
      this._previewLogBuffer = [];
      this._lastPreviewExitCode = null;
      this.broadcastSSE({ type: "preview_ready", data: { ports } });
    });

    preview.on("stopped", (code: number | null) => {
      this._lastPreviewExitCode = code;
      this.broadcastSSE({ type: "preview_stopped", data: { code } });
    });

    preview.on("config_missing", (checked: string[]) => {
      this.broadcastSSE({ type: "preview_config_missing", data: { checked } });
    });

    preview.on("config_error", (message: string) => {
      this.broadcastSSE({ type: "preview_config_error", data: { message } });
    });

    preview.on("install_status", (status: { status: string; message?: string }) => {
      this.broadcastSSE({ type: "preview_install_status", data: status });
    });

    preview.on("startup_step", (step: { stepId: string; status: string; durationMs?: number; message?: string; logLines?: string[] }) => {
      this.broadcastSSE({ type: "preview_startup_step", data: step });
    });

    preview.on("log", (entry: { source: string; text: string }) => {
      this._previewLogBuffer.push(entry.text);
      if (this._previewLogBuffer.length > SessionWorker.MAX_PREVIEW_LOG_LINES) {
        this._previewLogBuffer.shift();
      }
      this.broadcastSSE({ type: "preview_log", data: entry });
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
    for (const send of this.sseClients) {
      send(event);
    }
  }

  /**
   * Pause or resume the terminal PTY based on SSE backpressure state.
   */
  private applyTerminalBackpressure(): void {
    if (this._sseBackpressured.size > 0) {
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
    if (this.agent) {
      this.agent.kill();
      this.agent = null;
    }
    if (this.terminal) {
      this.terminal.kill();
      this.terminal = null;
      this._terminalPaused = false;
    }
    if (this.preview) {
      this.preview.stop();
      this.preview.removeAllListeners();
      this.preview = null;
    }
    if (this.fileWatcher) {
      this.fileWatcher.stop();
      this.fileWatcher.removeAllListeners();
      this.fileWatcher = null;
    }
    for (const raw of this.sseRawResponses) {
      try { raw.end(); } catch { /* already closed */ }
    }
    this.sseRawResponses.clear();
    this.sseClients.clear();
    await this.app.close();
  }

  /** Get the underlying Fastify instance (for testing). */
  getApp(): FastifyInstance { return this.app; }
}

// ---------------------------------------------------------------------------
// Standalone entry point (when run as a container process)
// ---------------------------------------------------------------------------

// Only auto-start when run directly (not when imported for testing)
if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  const workerMode = (process.env.WORKER_MODE ?? "session") as WorkerMode;

  const worker = new SessionWorker({
    agentFactory: () => new ClaudeAdapter(new ClaudeProcess()),
    port: Number(process.env.WORKER_PORT) || 9100,
    workspaceDir: process.env.WORKSPACE_DIR || CONTAINER_WORKSPACE_DIR,
    workerMode,
  });

  const address = await worker.start();
  console.log(`[session-worker] Listening on ${address} (mode=${workerMode})`);

  // Graceful shutdown
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, async () => {
      console.log(`[session-worker] Received ${signal}, shutting down`);
      await worker.stop();
      process.exit(0);
    });
  }
}
