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
import type { AgentProcess, AgentRunParams, AgentEvent, AgentId, McpServerConfig } from "./agents/agent-process.js";
import { resolveMcpServer, substituteMcpPlaceholders } from "./mcp-resolve.js";
import { TerminalProcess } from "./terminal.js";
import { FileWatcher } from "./file-watcher.js";
import os from "node:os";
import { CONTAINER_WORKSPACE_DIR } from "../shared/fs-constants.js";
import { scanFileTree } from "../shared/file-tree.js";
import { scanSkillsDir } from "../shared/skill-scan.js";
import { getErrorMessage } from "../shared/utils.js";
import { ClaudeProcess } from "./claude.js";
import { ClaudeAdapter } from "./agents/claude-adapter.js";
import { CodexAdapter } from "./agents/codex-adapter.js";
import { registerAgentOpsRoutes } from "./agent-ops-routes.js";
import type { OrchestratorClient } from "./orchestrator-client.js";
import { ServiceRequestQueue } from "./service-request-queue.js";
import { SseBroadcaster } from "./sse-broadcaster.js";
import type { SseClient, WorkerSSEEvent } from "./sse-broadcaster.js";
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
    registerAgentOpsRoutes(app, {
      createOrchestratorClient: this._createOrchestratorClient,
    });

    return app;
  }

  /**
   * Generate an MCP config file for Claude Code.
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

    // docs/125 — internal review tool. The bridge is a thin stdio→HTTP shim
    // (mcp-review-bridge.ts) launched via tsx-by-absolute-path, mirroring the
    // `gh`/`shipit` shim install in the Dockerfile (bare `tsx` fails to resolve
    // when the agent's cwd is a user repo without a tsx dep). It reads
    // WORKER_PORT from the inherited env to reach the worker's
    // /agent-ops/review/submit broker. Skipped if the bridge file isn't present
    // (e.g. a stripped-down test image) so agent start never fails on it.
    const reviewBridge = this.reviewBridgePaths();
    if (reviewBridge) {
      mcpServers["shipit-review"] = {
        command: reviewBridge.tsxBin,
        args: [reviewBridge.bridgePath],
      };
    }

    // docs/088: merge user-configured MCP servers. Configs arrive UNRESOLVED
    // — `$secret:` placeholders are substituted here against the worker's own
    // process.env (populated by 087's agent-env pipeline). A server that
    // references a missing secret is dropped and reported over SSE; it never
    // blocks agent start.
    //
    // We only emit `mcp_server_status` here for the *failure* case (missing
    // secret) — that's a definitive "this server is not going to start" signal
    // we know before the CLI runs. The matching `loaded` signal is emitted
    // later when the Claude CLI's init event reports the server as
    // `connected`; see ClaudeAdapter's `mcp_status` channel and
    // `wireAgentEvents()`. Emitting `loaded` here would be misleading: it
    // would mean "we sent the config" rather than "the connection succeeded."
    for (const server of params?.mcpServers ?? []) {
      const { resolved, missing } = resolveMcpServer(server);
      if (resolved) {
        mcpServers[server.name] = resolved;
      } else {
        const reason = `missing secret: ${missing.join(", ")}`;
        console.warn(`[mcp] dropping server "${server.name}": ${reason}`);
        this.broadcastSSE({
          type: "mcp_server_status",
          data: { name: server.name, state: "failed", reason },
        });
      }
    }

    fs.writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2));
    return configPath;
  }

  private static readonly CODEX_MCP_BEGIN = "# <shipit-managed-mcp>";
  private static readonly CODEX_MCP_END = "# </shipit-managed-mcp>";

  private tomlString(value: string): string {
    return JSON.stringify(value);
  }

  private tomlArray(values: string[]): string {
    return `[${values.map((v) => this.tomlString(v)).join(", ")}]`;
  }

  private tomlInlineStringMap(values: Record<string, string>): string {
    const entries = Object.entries(values).map(
      ([key, value]) => `${this.tomlString(key)} = ${this.tomlString(value)}`,
    );
    return `{ ${entries.join(", ")} }`;
  }

  private replaceManagedCodexMcpBlock(existing: string, block: string): string {
    const start = existing.indexOf(SessionWorker.CODEX_MCP_BEGIN);
    const end = existing.indexOf(SessionWorker.CODEX_MCP_END);
    const normalizedBlock = block.endsWith("\n") ? block : `${block}\n`;
    if (start !== -1 && end !== -1 && end > start) {
      const afterEnd = end + SessionWorker.CODEX_MCP_END.length;
      return `${existing.slice(0, start).trimEnd()}\n\n${normalizedBlock}${existing.slice(afterEnd).trimStart()}`;
    }
    return `${existing.trimEnd()}${existing.trimEnd() ? "\n\n" : ""}${normalizedBlock}`;
  }

  /**
   * docs/088/docs/125 — register ShipIt-managed MCP servers for Codex.
   *
   * Codex reads MCP server definitions from `~/.codex/config.toml` at
   * app-server startup. Unlike Claude's per-turn temp JSON, this file persists
   * next to Codex auth state, so we avoid writing resolved secrets into it for
   * the common env/header cases:
   *
   * - stdio `env` entries become Codex `env_vars`, with the actual values
   *   supplied to the spawned child process environment for this run.
   * - HTTP `headers` entries become Codex `env_http_headers`, backed by
   *   synthetic per-run environment variables.
   *
   * Resolved secrets embedded in `args` still have to be written literally
   * because Codex has no argv env indirection.
   */
  private ensureCodexMcpConfig(params?: AgentRunParams): Record<string, string> {
    const codexHome = process.env.CODEX_HOME || "/root/.codex";
    const configPath = path.join(codexHome, "config.toml");
    const runtimeEnv: Record<string, string> = {};
    const lines: string[] = [
      SessionWorker.CODEX_MCP_BEGIN,
      "# ShipIt-managed MCP servers. This block is regenerated before each Codex turn.",
    ];

    const bridge = this.reviewBridgePaths();
    if (bridge) {
      lines.push(
        "",
        "# docs/125 — internal review tool bridge.",
        "[mcp_servers.shipit-review]",
        `command = ${this.tomlString(bridge.tsxBin)}`,
        `args = ${this.tomlArray([bridge.bridgePath])}`,
      );
    }

    for (const server of params?.mcpServers ?? []) {
      const { resolved, missing } = resolveMcpServer(server);
      if (!resolved) {
        const reason = `missing secret: ${missing.join(", ")}`;
        console.warn(`[mcp] dropping server "${server.name}": ${reason}`);
        this.broadcastSSE({
          type: "mcp_server_status",
          data: { name: server.name, state: "failed", reason },
        });
        continue;
      }

      lines.push("", `[mcp_servers.${server.name}]`);
      if (server.type === "stdio") {
        const command = resolved.command;
        if (typeof command === "string") {
          lines.push(`command = ${this.tomlString(command)}`);
        }
        const args = resolved.args;
        if (Array.isArray(args) && args.every((arg) => typeof arg === "string")) {
          lines.push(`args = ${this.tomlArray(args)}`);
        }
        const env = resolved.env;
        if (env && typeof env === "object" && !Array.isArray(env)) {
          const envKeys: string[] = [];
          for (const [key, value] of Object.entries(env)) {
            if (typeof value !== "string") continue;
            runtimeEnv[key] = value;
            envKeys.push(key);
          }
          if (envKeys.length > 0) {
            lines.push(`env_vars = ${this.tomlArray(envKeys)}`);
          }
        }
      } else {
        const url = resolved.url;
        if (typeof url === "string") {
          lines.push(`url = ${this.tomlString(url)}`);
        }
        const headers = resolved.headers;
        if (headers && typeof headers === "object" && !Array.isArray(headers)) {
          const envHeaders: Record<string, string> = {};
          let i = 0;
          for (const [header, value] of Object.entries(headers)) {
            if (typeof value !== "string") continue;
            const envKey = `SHIPIT_MCP_${server.name.toUpperCase()}_HTTP_HEADER_${i++}`;
            runtimeEnv[envKey] = value;
            envHeaders[header] = envKey;
          }
          if (Object.keys(envHeaders).length > 0) {
            lines.push(`env_http_headers = ${this.tomlInlineStringMap(envHeaders)}`);
          }
        }
      }
    }

    lines.push("", SessionWorker.CODEX_MCP_END, "");

    try {
      let existing = "";
      try {
        existing = fs.readFileSync(configPath, "utf-8");
      } catch { /* no config yet */ }
      fs.mkdirSync(codexHome, { recursive: true });
      fs.writeFileSync(configPath, this.replaceManagedCodexMcpBlock(existing, lines.join("\n")));
    } catch (err) {
      console.warn(`[mcp] failed to register codex MCP config: ${getErrorMessage(err)}`);
    }

    return runtimeEnv;
  }

  /**
   * Resolve the absolute paths needed to launch the review MCP bridge
   * (docs/125): the `tsx` binary and `mcp-review-bridge.ts`, both relative to
   * this module. Returns null if either is missing so a stripped-down or
   * non-container environment doesn't break agent start. Mirrors the Dockerfile
   * `gh` shim's tsx-by-absolute-path invocation.
   */
  private reviewBridgePaths(): { tsxBin: string; bridgePath: string } | null {
    const sessionDir = path.dirname(fileURLToPath(import.meta.url));
    const bridgePath = path.join(sessionDir, "mcp-review-bridge.ts");
    // <root>/src/server/session → <root>/node_modules/.bin/tsx
    const tsxBin = path.resolve(sessionDir, "../../../node_modules/.bin/tsx");
    if (!fs.existsSync(bridgePath) || !fs.existsSync(tsxBin)) return null;
    return { tsxBin, bridgePath };
  }

  /**
   * docs/125 — compatibility wrapper for tests and older call sites that only
   * need the review bridge. The shared Codex MCP writer owns the generated
   * block and preserves any user-owned config outside that block.
   */
  private ensureCodexReviewMcpConfig(): void {
    this.ensureCodexMcpConfig();
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

        // docs/088/docs/125 — Codex loads MCP servers from config.toml, not a
        // per-run path, so register ShipIt-managed servers before spawn and
        // provide any resolved secret values through the child environment.
        const codexMcpEnv = agentId === "codex" ? this.ensureCodexMcpConfig(params) : {};

        this.agent = this.agentFactory(agentId);
        this.wireAgentEvents(this.agent);
        this.withTemporaryEnv(codexMcpEnv, () => {
          this.agent?.run({ ...params, cwd: this.workspaceDir, mcpConfigPath });
        });

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

    // POST /agent/message — inject a user message (live steering, docs/140)
    app.post<{ Body: { text: string } }>(
      "/agent/message",
      async (request, reply) => {
        if (!this.agent) {
          return reply.code(400).send({ error: "No agent running" });
        }
        const { text } = request.body;
        if (typeof text !== "string" || !text) {
          return reply.code(400).send({ error: "text is required" });
        }
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
   * Resolve `$secret:` and `$platform:` placeholders in a user MCP server
   * config against `process.env`, returning a fully-resolved
   * `McpServerConfig`. Used by the test endpoint. Returns `{ ok: false }`
   * when a referenced secret/token is absent.
   *
   * Delegates substitution to the shared {@link substituteMcpPlaceholders}
   * helper so the test path understands the exact same placeholder forms as
   * the agent's `generateMcpConfig()` — including `$platform:<source>` used by
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
   * Run install commands sequentially, streaming output via SSE.
   * Writes a marker file on success to skip redundant re-runs.
   *
   * Fast path (docs/148): for a single bare `npm install|ci|i`, `yarn
   * [install]`, or `pnpm install|i` against a workspace with exactly one
   * lockfile, look up a previously-materialized `node_modules` keyed by
   * lockfile content + runtime + tuned command. On hit, copy the tree in
   * via tar/cp and write the marker — no install runs. On miss, run the
   * (optionally tuned) install as today, then publish the resulting tree
   * to the store via temp-dir + atomic rename. Any failure on the fast
   * path falls through to a plain real install (the populate is best-effort).
   */
  private async runInstallCommands(commands: string[], markerDir: string, markerFile: string): Promise<void> {
    try {
      const fast = this.computeFastPath(commands);
      if (fast) {
        const materialized = await this.tryMaterializeFromStore(fast);
        if (materialized) {
          this.writeMarker(markerDir, markerFile);
          this._lastInstallResult = { ok: true };
          this._installRunning = false;
          this._installProcess = null;
          this.broadcastSSE({ type: "install_done", data: {} });
          return;
        }
      }

      // Real-install path. For the fast-path candidate we substitute the
      // tuned command (Option E flags) so the populated store reflects what
      // was actually built.
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

      // Populate the store after a successful real install. Best-effort —
      // a populate failure must not fail the install (the workspace already
      // has a working `node_modules`).
      if (fast) {
        await this.tryPopulateStore(fast).catch((err: unknown) => {
          console.warn(
            `[install] populateStore failed for ${fast.storeKey}:`,
            getErrorMessage(err),
          );
        });
      }

      // All commands succeeded — write marker
      this.writeMarker(markerDir, markerFile);

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
   * Decide whether the install request is a fast-path candidate. Returns
   * the resolved store path + tuned command on success, or null when any
   * gate fails (kill switch, non-cacheable command, multi-command sequence,
   * 0 or multiple lockfiles).
   */
  private computeFastPath(
    commands: string[],
  ): { storeKey: string; storeDir: string; tunedCommand: string } | null {
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
  private async tryMaterializeFromStore(
    fast: { storeKey: string; storeDir: string; tunedCommand: string },
  ): Promise<boolean> {
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

      // Replay current state so late-connecting clients don't miss events
      if (this.terminal) {
        this.sse.sendTo(client, { type: "terminal_data", data: { data: "" } });
      }
      // Replay last install result so an orchestrator that reconnects after
      // missing the original install_done/install_error still sees the
      // outcome. The orchestrator's `_resolveInstallComplete` is idempotent
      // (gates on a non-null resolver), so duplicate events are harmless if
      // the original event already arrived.
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

  /** Wire agent events to the SSE stream. */
  private wireAgentEvents(agent: AgentProcess): void {
    agent.on("event", (event: AgentEvent) => {
      this.broadcastSSE({ type: "agent_event", data: event });
    });

    // Capture `agent` in the closure so the done/error handlers compare against
    // the specific instance they were wired to. Without this guard, a late
    // `done` from an OLD streaming process (killed by /agent/kill during the
    // 409-retry dance in container-session-runner.ts) would null out the
    // freshly-spawned NEW agent that already replaced `this.agent`, stranding
    // the worker with no agent reference while the new CLI keeps running.
    agent.on("done", (exitCode: number) => {
      this.broadcastSSE({ type: "agent_done", data: { exitCode } });
      if (this.agent === agent) {
        this.agent = null;
      }
    });

    agent.on("error", (err: Error) => {
      this.broadcastSSE({ type: "agent_error", data: { message: err.message } });
      if (this.agent === agent) {
        this.agent = null;
      }
    });

    agent.on("auth_required", () => {
      this.broadcastSSE({ type: "agent_auth_required", data: {} });
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
export const createWorkerAgent: WorkerAgentFactory = (agentId: AgentId) =>
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
