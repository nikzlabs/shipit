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
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { AgentProcess, AgentRunParams, AgentEvent, AgentId, McpServerConfig } from "./agents/agent-process.js";
import { TerminalProcess } from "./terminal.js";
import { FileWatcher } from "./file-watcher.js";
import { CONTAINER_WORKSPACE_DIR } from "../shared/fs-constants.js";
import { scanFileTree } from "../shared/file-tree.js";
import type { ServerResponse } from "node:http";
import { getErrorMessage } from "../shared/utils.js";
import { ClaudeProcess } from "./claude.js";
import { ClaudeAdapter } from "./agents/claude-adapter.js";
import { registerAgentOpsRoutes } from "./agent-ops-routes.js";
import type { OrchestratorClient } from "./orchestrator-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Event types sent over the SSE stream to the orchestrator. */
export interface WorkerSSEEvent {
  type:
    | "agent_event" | "agent_done" | "agent_error" | "agent_auth_required" | "agent_log"
    | "terminal_data" | "terminal_exit"
    | "file_changes"
    | "service_request"
    | "install_log" | "install_done" | "install_error"
    | "mcp_server_status";
  data: unknown;
}

/** Pending service request awaiting orchestrator callback. */
interface PendingServiceRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
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
  private sseClients = new Set<(event: WorkerSSEEvent) => void>();
  private sseRawResponses = new Set<ServerResponse>();
  private port: number;
  private host: string;
  private workspaceDir: string;

  private terminal: TerminalProcess | null = null;
  private fileWatcher: FileWatcher | null = null;
  private _createFileWatcher: () => FileWatcher;
  private _createTerminal: () => TerminalProcess;
  private _createOrchestratorClient?: () => OrchestratorClient;

  // Service request/callback state
  private _pendingServiceRequests = new Map<string, PendingServiceRequest>();
  private _serviceRequestCounter = 0;
  private static readonly SERVICE_REQUEST_TIMEOUT_MS = 60_000;

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

  // Terminal backpressure state
  private _sseBackpressured = new Set<ServerResponse>();
  private _terminalPaused = false;

  // docs/088 — MCP npm install state. Per-package mutex coalesces concurrent
  // install requests for the same package; `/tmp/mcp-installed.json` records
  // completed installs so a worker restart within the same container doesn't
  // reinstall (cross-container caching is out of scope for Phase 1).
  private _mcpInstallMutex = new Map<string, Promise<void>>();
  private static readonly MCP_INSTALLED_MARKER = "/tmp/mcp-installed.json";

  constructor(deps: SessionWorkerDeps) {
    super();
    this.agentFactory = deps.agentFactory;
    this.port = deps.port ?? 9100;
    this.host = deps.host ?? "0.0.0.0";
    this.workspaceDir = deps.workspaceDir ?? "/workspace";
    this._createFileWatcher = deps.createFileWatcher ?? (() => new FileWatcher());
    this._createTerminal = deps.createTerminal ?? (() => new TerminalProcess());
    this._createOrchestratorClient = deps.createOrchestratorClient;
    this.app = this.buildApp();
  }

  private buildApp(): FastifyInstance {
    const app = Fastify({ logger: false });

    app.get("/health", async () => ({ status: "ok" }));
    this.registerSessionEndpoints(app);
    this.registerSSEEndpoint(app);
    registerAgentOpsRoutes(app, {
      createOrchestratorClient: this._createOrchestratorClient,
    });

    return app;
  }

  /**
   * Generate an MCP config file for Playwright browser tools.
   * Only generated for the Claude agent (Codex doesn't support MCP).
   * Returns the config file path, or undefined if not applicable.
   *
   * NOTE on cwd: `--output-dir` only governs auto-generated filenames. When the
   * agent passes a `filename` to `browser_take_screenshot` (or any tool with a
   * suggestedFilename), `@playwright/mcp` resolves it relative to its own
   * `process.cwd()` via `workspaceFile()` — NOT relative to `--output-dir`.
   * If we let the server inherit the workspace as cwd, screenshots like
   * `shot.png` land in `/workspace/` and get auto-committed. We work around
   * this by launching the server through `sh -c` with an explicit `cd` into
   * the output dir so suggested filenames also stay out of the repo.
   * See coreBundle.js:`workspaceFile()` and `resolveClientFilename()`.
   */
  private generateMcpConfig(agentId: AgentId, params?: AgentRunParams): string | undefined {
    if (agentId !== "claude") return undefined;

    const configPath = `/tmp/mcp-config-${Date.now()}.json`;
    const outputDir = "/tmp/.playwright-mcp";
    // `--browser chromium` is required: our Dockerfiles install Chromium
    // (Chrome doesn't ship for Linux ARM64). Without this flag, @playwright/mcp
    // defaults to `chrome` and fails on the first browser tool call with
    // "Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome".
    const mcpServers: Record<string, unknown> = {
      playwright: {
        command: "sh",
        args: [
          "-c",
          `mkdir -p ${outputDir} && cd ${outputDir} && exec playwright-mcp --browser chromium --headless --no-sandbox --output-dir ${outputDir}`,
        ],
      },
    };

    // docs/088: merge user-configured MCP servers. Configs arrive UNRESOLVED
    // — `$secret:` placeholders are substituted here against the worker's own
    // process.env (populated by 087's agent-env pipeline). A server that
    // references a missing secret is dropped and reported over SSE; it never
    // blocks agent start.
    for (const server of params?.mcpServers ?? []) {
      const resolved = this.resolveMcpServer(server);
      if (resolved) {
        mcpServers[server.name] = resolved;
        this.broadcastSSE({
          type: "mcp_server_status",
          data: { name: server.name, state: "loaded" },
        });
      }
    }

    fs.writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2));
    return configPath;
  }

  /**
   * Resolve a single user MCP server config into the Claude-CLI `--mcp-config`
   * shape, substituting `$secret:KEY` placeholders in `env` / `headers` /
   * `args` against `process.env`. Returns `null` (and emits an SSE
   * `mcp_server_status` failure) when a referenced secret is missing.
   */
  private resolveMcpServer(server: McpServerConfig): Record<string, unknown> | null {
    const missing: string[] = [];
    // Substring substitution — `"Bearer $secret:mcp__x__TOKEN"` keeps the
    // literal `Bearer ` prefix and only the token portion is replaced.
    const subst = (value: string): string =>
      value.replace(/\$secret:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, key: string) => {
        const v = process.env[key];
        if (v === undefined || v === "") {
          missing.push(key);
          return "";
        }
        return v;
      });
    const substRecord = (rec?: Record<string, string>): Record<string, string> | undefined => {
      if (!rec) return undefined;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(rec)) out[k] = subst(v);
      return out;
    };

    let resolved: Record<string, unknown>;
    if (server.type === "stdio") {
      resolved = {
        command: server.command,
        ...(server.args ? { args: server.args.map(subst) } : {}),
        ...(server.env ? { env: substRecord(server.env) } : {}),
      };
    } else {
      resolved = {
        type: "http",
        url: server.url,
        ...(server.headers ? { headers: substRecord(server.headers) } : {}),
      };
    }

    if (missing.length > 0) {
      const reason = `missing secret: ${[...new Set(missing)].join(", ")}`;
      console.warn(`[mcp] dropping server "${server.name}": ${reason}`);
      this.broadcastSSE({
        type: "mcp_server_status",
        data: { name: server.name, state: "failed", reason },
      });
      return null;
    }
    return resolved;
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
        // Generate MCP config — built-in Playwright + user-configured servers.
        const mcpConfigPath = this.generateMcpConfig(agentId, params);

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
      const pending = this._pendingServiceRequests.get(requestId);
      if (!pending) {
        return reply.code(404).send({ error: "Unknown or expired request" });
      }
      this._pendingServiceRequests.delete(requestId);
      clearTimeout(pending.timer);
      if (error) {
        pending.reject(new Error(error));
      } else {
        pending.resolve(result ?? { ok: true });
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

      if (this._installRunning) {
        return reply.code(409).send({ error: "Install already running" });
      }

      // Check marker file — skip if install already completed
      const markerDir = path.join(this.workspaceDir, ".shipit");
      const markerFile = path.join(markerDir, ".install-done");
      if (fs.existsSync(markerFile)) {
        return { skipped: true, reason: "marker" };
      }

      // Return immediately — progress streams via SSE
      this._installRunning = true;
      // New install starts — clear any previous result so the SSE-reconnect
      // resync path doesn't surface a stale outcome from a prior install.
      this._lastInstallResult = null;
      void this.runInstallCommands(commands, markerDir, markerFile);
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
   * Resolve `$secret:` placeholders in a user MCP server config against
   * `process.env`, returning a fully-resolved `McpServerConfig`. Used by the
   * test endpoint. Returns `{ ok: false }` when a referenced secret is absent.
   */
  private resolveMcpServerConfig(
    server: McpServerConfig,
  ): { ok: true; config: McpServerConfig } | { ok: false; error: string } {
    const missing: string[] = [];
    const subst = (value: string): string =>
      value.replace(/\$secret:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, key: string) => {
        const v = process.env[key];
        if (v === undefined || v === "") {
          missing.push(key);
          return "";
        }
        return v;
      });
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
   * Run install commands sequentially, streaming output via SSE.
   * Writes a marker file on success to skip redundant re-runs.
   */
  private async runInstallCommands(commands: string[], markerDir: string, markerFile: string): Promise<void> {
    try {
      for (const cmd of commands) {
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

      // All commands succeeded — write marker
      fs.mkdirSync(markerDir, { recursive: true });
      fs.writeFileSync(markerFile, new Date().toISOString());

      this._lastInstallResult = { ok: true };
      // See above — flip `running` to false before the success broadcast so
      // the next `/install/status` poll observes consistent state.
      this._installRunning = false;
      this._installProcess = null;
      this.broadcastSSE({ type: "install_done", data: {} });
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
    const requestId = `svc-${++this._serviceRequestCounter}-${Date.now()}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingServiceRequests.delete(requestId);
        reject(new Error(`Service ${action} request timed out`));
      }, SessionWorker.SERVICE_REQUEST_TIMEOUT_MS);

      this._pendingServiceRequests.set(requestId, { resolve, reject, timer });

      this.broadcastSSE({
        type: "service_request",
        data: { requestId, action, name },
      });
    });
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
      if (this.terminal) {
        sendEvent({ type: "terminal_data", data: { data: "" } });
      }
      // Replay last install result so an orchestrator that reconnects after
      // missing the original install_done/install_error still sees the
      // outcome. The orchestrator's `_resolveInstallComplete` is idempotent
      // (gates on a non-null resolver), so duplicate events are harmless if
      // the original event already arrived.
      if (this._lastInstallResult && !this._installRunning) {
        if (this._lastInstallResult.ok) {
          sendEvent({ type: "install_done", data: {} });
        } else {
          sendEvent({
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
    for (const [id, pending] of this._pendingServiceRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Worker shutting down"));
      this._pendingServiceRequests.delete(id);
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
  const worker = new SessionWorker({
    agentFactory: () => new ClaudeAdapter(new ClaudeProcess()),
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
