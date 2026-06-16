/**
 * CodexAdapter — implements the AgentProcess interface for the OpenAI Codex CLI.
 *
 * Communication uses the Codex App Server JSON-RPC 2.0 protocol over stdio
 * (JSONL framing). The adapter spawns `codex app-server` as a child process,
 * performs the initialize handshake, manages thread/turn lifecycle, and
 * translates streaming notifications into normalized AgentEvent objects.
 *
 * Protocol reference:
 * - JSON-RPC 2.0 over JSONL on stdio
 * - Lifecycle: initialize → thread/start → turn/start → stream events → turn/completed
 * - Three message types: requests (with id), responses (echo id), notifications (no id)
 *
 * This file keeps the process lifecycle, the JSON-RPC wire format (send/receive
 * framing), and the public AgentProcess orchestration. The thread/turn event
 * stream processing lives in `CodexEventHandler`, tool/diff normalization in
 * `codex-tool-normalizer.ts`, and rate-limit/token-usage tracking in
 * `codex-rate-limits.ts` (P14 of docs/201). The adapter wires those together
 * via the `CodexTransport` surface and delegates protocol parsing to them.
 */

import { EventEmitter } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type {
  AgentId,
  AgentCapabilities,
  AgentMcpWriteContext,
  AgentMcpWriteResult,
  AgentProcess,
  AgentProcessEvents,
  AgentRunParams,
  PermissionRequester,
} from "../agent-process.js";
import { resolveMcpServer } from "../../mcp-resolve.js";
import { getErrorMessage } from "../../../shared/utils.js";
import {
  PLAYWRIGHT_MCP_ARGS,
  PLAYWRIGHT_MCP_COMMAND,
} from "../playwright-mcp.js";
import { CODEX_TOOL_NAMES } from "../../../shared/agent-registry.js";
import { codexHome } from "../../../shared/agent-home.js";
import { CodexRateLimits } from "./codex-rate-limits.js";
import { CodexEventHandler } from "./codex-event-handler.js";

// Re-exported for unit tests and external callers that historically imported
// these pure helpers from the adapter module (they now live in the normalizer).
export { unwrapShellCommand, buildCodexPermissionInput } from "./codex-tool-normalizer.js";

// ---- Codex JSON-RPC protocol types ----

/** Outbound request (client → app-server). */
interface JsonRpcRequest {
  method: string;
  id: number;
  params?: Record<string, unknown>;
}

/** Outbound notification (client → app-server, no id). */
interface JsonRpcNotification {
  method: string;
  params?: Record<string, unknown>;
}

/** Inbound response (app-server → client). */
interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Inbound notification (app-server → client, no id). */
interface JsonRpcServerNotification {
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Inbound request (app-server → client) — has BOTH an id and a method. The
 * app-server blocks the turn until we send back a JsonRpcOutboundResponse with
 * the matching id. Approval prompts arrive this way.
 */
interface JsonRpcServerRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** Outbound response (client → app-server) — echoes a server request's id. */
interface JsonRpcOutboundResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

type JsonRpcInbound = JsonRpcResponse | JsonRpcServerNotification | JsonRpcServerRequest;

/**
 * Path where the Codex CLI persists ChatGPT subscription credentials after
 * `codex login --device-auth`. In ShipIt this resolves through a symlink to
 * the shared `/credentials` volume (see Dockerfile.* — feature 119). The home
 * is `${agentHome()}/.codex` — `/home/shipit/.codex` in a session container,
 * `/root/.codex` in local mode (docs/150). Resolved at call time so the same
 * code serves both runtimes.
 */
function codexAuthFile(): string {
  return path.join(codexHome(), "auth.json");
}

/**
 * True iff `${agentHome()}/.codex/auth.json` exists and is a non-empty regular
 * file. Exported for unit tests and for reuse by AgentRegistry.checkCodexAuth.
 */
export function hasCodexFileAuth(): boolean {
  try {
    const file = codexAuthFile();
    if (!existsSync(file)) return false;
    const st = statSync(file);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

export class CodexAdapter
  extends EventEmitter<AgentProcessEvents>
  implements AgentProcess
{
  constructor(private readonly hasFileAuth = hasCodexFileAuth) {
    super();
    this.rateLimits = new CodexRateLimits();
    this.eventHandler = new CodexEventHandler(
      {
        emitEvent: (event) => { this.emit("event", event); },
        emitLog: (source, text) => { this.emit("log", source, text); },
        sendRequest: (method, params) => this.sendRequest(method, params),
        sendResponse: (id, result) => { this.sendResponse(id, result); },
        sendErrorResponse: (id, code, message) => { this.sendErrorResponse(id, code, message); },
        sendNotification: (method, params) => { this.sendNotification(method, params); },
        kill: () => { this.kill(); },
      },
      this.rateLimits,
      [...CODEX_TOOL_NAMES],
    );
  }

  readonly agentId: AgentId = "codex";

  readonly capabilities: AgentCapabilities = {
    supportsResume: true,
    supportsImages: false,
    supportsSystemPrompt: true,
    supportsPermissionModes: false,
    supportedPermissionModes: [],
    // Current Codex app-server surface ShipIt handles: shell command items,
    // file-change/apply-patch items, MCP/dynamic tools, subagent collaboration,
    // web/image/tool-discovery items, and ShipIt's ask bridge.
    toolNames: [...CODEX_TOOL_NAMES],
    // Mirror of agent-registry.ts. Verified against the ChatGPT
    // `/backend-api/codex/models` endpoint — every entry returned for a
    // Plus plan with `visibility: list` and `supported_in_api: true`,
    // including the codex-specialized `gpt-5.3-codex` variant. Keep in
    // sync with the registry; both feed the same picker in the UI.
    models: [
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex",
      "gpt-5.2",
    ],
    // docs/125 — Codex satisfies both ingredients the chat-native review flow
    // needs: subagents (model spawns them via the `spawn_agent` collab tool on
    // explicit instruction — exactly what the composed review prompt asks for)
    // and custom MCP tools (`[mcp_servers.*]` in config.toml). The worker
    // writes the consolidated `shipit` bridge into the Codex config before spawn
    // (see CodexAdapter.writeMcpConfig), so `submit_review`
    // is available to the parent and any subagent it spawns.
    supportsReview: true,
    supportsSteering: true,
    // docs/178 — the app-server exposes `thread/compact/start` and emits
    // `contextCompaction` items we map to normalized compaction signals.
    supportsCompaction: true,
    skillsDirName: ".codex",
    skillInvocationPrefix: "$",
  };

  private proc: ChildProcess | null = null;
  private buffer = "";
  private nextId = 1;

  /** The thread/turn event-stream processor (initialize, item/turn handling). */
  private readonly eventHandler: CodexEventHandler;

  /** Rate-limit + token-usage tracker, shared with the event handler. */
  private readonly rateLimits: CodexRateLimits;

  /** Pending JSON-RPC requests awaiting a response, keyed by id. */
  private pendingRequests = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (err: Error) => void }
  >();

  setPermissionRequester(requester: PermissionRequester): void {
    this.eventHandler.setPermissionRequester(requester);
  }

  /**
   * Spawn the Codex App Server process.
   * The process stays alive across turns — we create threads and turns within it.
   */
  run(params: AgentRunParams): void {
    this.eventHandler.beginTurn(params.cwd);

    // Check binary exists before attempting spawn
    try {
      execFileSync("which", ["codex"], { stdio: "ignore" });
    } catch {
      this.emit("error", new Error(
        "Codex CLI is not installed. Install it with: npm install -g @openai/codex"
      ));
      return;
    }

    const cwd = params.cwd;
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
    };

    // Auth resolution — see docs/119-codex-subscription-auth/plan.md.
    //
    // Two modes:
    //   1. ChatGPT subscription login — the `codex login --device-auth` flow
    //      writes credentials to ~/.codex/auth.json (a symlink into the
    //      shared credentials volume). When present, the CLI uses the user's
    //      ChatGPT plan / Codex credits.
    //   2. OPENAI_API_KEY env var — bills against the user's OpenAI Platform
    //      account (separate from any ChatGPT subscription).
    //
    // If both are configured, we prefer the subscription path: strip the env
    // key from the spawned child so `codex` doesn't silently route through
    // Platform API billing — that's exactly the bug this feature exists to
    // fix.
    const hasFileAuth = this.hasFileAuth();
    const hasEnvAuth = !!env.OPENAI_API_KEY;

    if (!hasFileAuth && !hasEnvAuth) {
      this.emit("auth_required");
      return;
    }

    if (hasFileAuth) {
      delete env.OPENAI_API_KEY;
      this.emit("log", "codex", "using ChatGPT subscription (~/.codex/auth.json)");
    } else {
      this.emit("log", "codex", "using OPENAI_API_KEY (Platform API billing)");
    }

    const args = ["app-server"];

    this.emit("log", "codex", `spawning: codex ${args.join(" ")} | cwd: ${cwd}`);

    try {
      this.proc = spawn("codex", args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      return;
    }

    this.buffer = "";

    // Read stdout line by line (JSONL framing)
    this.proc.stdout?.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf-8");
      this.drainLines();
    });

    // Log stderr but also detect auth issues
    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8").trim();
      if (text) {
        this.emit("log", "codex-stderr", text);
        const lc = text.toLowerCase();
        if (
          lc.includes("unauthorized") ||
          lc.includes("invalid api key") ||
          lc.includes("authentication") ||
          lc.includes("api key")
        ) {
          this.emit("auth_required");
        }
      }
    });

    this.proc.on("error", (err) => {
      this.emit("error", err);
    });

    this.proc.on("close", (code) => {
      this.drainLines(true);
      this.emit("done", code ?? 1);
      this.proc = null;
    });

    // Start the initialization handshake, then create a thread and turn
    this.eventHandler.initializeAndRun(params).catch((err: unknown) => {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    });
  }

  readonly isStreaming = false;

  writeStdin(data: string): void {
    // For Codex, user input during a turn (live steering) is sent via
    // `turn/steer`. Getting this to actually take required two non-obvious
    // pieces — both verified by driving the real app-server (0.130/0.132):
    //
    // 1. `turn/steer` is a JSON-RPC **request**, not a notification. It has a
    //    `TurnSteerResponse` (returns `{turnId}`). The app-server silently
    //    DROPS a `turn/steer` sent without an `id` — no error, the turn just
    //    runs to completion ignoring the message. So we must use
    //    `sendRequest`, not `sendNotification`. (This was the bug behind
    //    "Codex ignores live-steer messages sent mid-turn".)
    //
    // 2. `expectedTurnId` is mandatory (`TurnSteerParams`): validated
    //    non-empty and must match the currently active turn, else the request
    //    is rejected. We capture `currentTurnId` from the `turn/started`
    //    event (and the `turn/start` response as a fallback); if it isn't set
    //    there's no active turn to steer, so we skip.
    //
    // `input` is an array of content blocks, not a bare string — the same
    // shape as `turn/start` (see `initializeAndRun`); a string is rejected
    // with -32600 "invalid type: string, expected a sequence".
    const threadId = this.eventHandler.getThreadId();
    const currentTurnId = this.eventHandler.getCurrentTurnId();
    if (this.proc && threadId && currentTurnId) {
      const steerText = data.trim();
      void (async () => {
        try {
          await this.sendRequest("turn/steer", {
            threadId,
            expectedTurnId: currentTurnId,
            input: [{ type: "text", text: steerText }],
          });
          // docs/140 — the request resolved, so the app-server accepted the
          // steer into the active turn. Emit the delivery ACK (the same event
          // Claude surfaces from its --replay-user-messages echo) so the
          // orchestrator marks this steer `delivered` and does NOT re-queue it
          // at turn end. Without this, an accepted Codex steer that produced no
          // further assistant group would be misread as a lost gap-steer and
          // re-sent (double-processed) by `requeueUndeliveredSteers`.
          this.emit("event", { type: "agent_user_replay", text: steerText });
        } catch (err: unknown) {
          // A rejection here (e.g. ActiveTurnNotSteerable during a
          // review/compaction turn, or the turn ending as we send) means the
          // steer didn't land. The orchestrator already optimistically rendered
          // the message, so emit `agent_steer_rejected` (docs/140) — the
          // listener removes the optimistic bubble and re-queues the text so it
          // runs as the next turn instead of silently vanishing. Also log for
          // diagnostics.
          const reason = err instanceof Error ? err.message : String(err);
          this.emit("log", "codex", `turn/steer rejected: ${reason}`);
          this.emit("event", { type: "agent_steer_rejected", text: steerText });
        }
      })();
    }
  }

  sendUserMessage(text: string, _opts?: { images?: unknown[] }): void {
    // Codex steers via turn/steer (writeStdin already does this)
    this.writeStdin(text);
  }

  /**
   * docs/178 — trigger a context compaction on the live app-server via the
   * `thread/compact/start` RPC. Only works when a process + thread are resident
   * (i.e. a turn is in flight); Codex tears its app-server down on turn
   * completion, so between turns there's nothing to talk to and the orchestrator
   * routes through `run({ compact: true })` (which spawns a fresh app-server,
   * resumes the thread, and issues the same RPC) instead. We mark
   * `compactionRequested` so the resulting `contextCompaction` items are labeled
   * `"manual"` rather than `"auto"`.
   */
  compact(_instructions?: string): void {
    // docs/178 §4 — Codex's `thread/compact/start` RPC takes only a threadId;
    // it has no slot for custom-compaction instructions, so any `/compact <args>`
    // text is intentionally dropped (Claude-only feature).
    const threadId = this.eventHandler.getThreadId();
    if (this.proc && threadId) {
      this.eventHandler.markCompactionRequested();
      this.sendRequest("thread/compact/start", { threadId }).catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        this.emit("log", "codex", `thread/compact/start rejected: ${reason}`);
      });
      return;
    }
    console.warn(
      "[codex-adapter] compact() called with no live thread — the orchestrator should have spawned a compaction run instead",
    );
  }

  interrupt(): void {
    // Graceful interrupt (docs/140): ask the app-server to abort the in-flight
    // turn via `turn/interrupt` rather than SIGTERMing the process. The server
    // ends the turn with `turn/completed status:"interrupted"`, which
    // `handleTurnCompleted` maps to an `agent_result` (error) and then tears
    // the process down — same teardown the hard kill produced, but the model
    // stops cleanly and the transcript records a real turn boundary instead of
    // a process death (which is what the AskUserQuestion interrupt flow needs:
    // the turn must END so the answer can start a fresh one).
    //
    // Fall back to `kill()` when there's no active turn to cancel, or if the
    // request is rejected (older app-server without the method) — in both cases
    // the graceful path can't complete and we must not leave the process
    // resident waiting for input that never comes.
    const threadId = this.eventHandler.getThreadId();
    const currentTurnId = this.eventHandler.getCurrentTurnId();
    if (this.proc && threadId && currentTurnId) {
      this.sendRequest("turn/interrupt", {
        threadId,
        turnId: currentTurnId,
      }).catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        this.emit("log", "codex", `turn/interrupt rejected, killing: ${reason}`);
        this.kill();
      });
      return;
    }
    this.kill();
  }

  kill(): void {
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
    this.pendingRequests.forEach(({ reject }) => reject(new Error("Process killed")));
    this.pendingRequests.clear();
  }

  // ---- MCP config writer (docs/088, docs/125, docs/155 hair 10) ----

  /**
   * Codex reads MCP server definitions from `~/.codex/config.toml` at
   * app-server startup, not from a per-run path like Claude. So we rewrite
   * the ShipIt-managed block in that file before every spawn and return any
   * resolved secret values via `runtimeEnv` (the worker sets them on the
   * child process env for this run). The block is delimited so we never
   * clobber a user's own MCP entries elsewhere in the file.
   *
   * For stdio servers:
   *  - `env` entries become Codex `env_vars` (the actual values are passed
   *    through `runtimeEnv` to the spawned child, so the `.toml` itself
   *    never has resolved secrets in it).
   * For HTTP servers:
   *  - `Authorization: Bearer <token>` becomes Codex `bearer_token_env_var`,
   *    matching `codex mcp add --bearer-token-env-var`. The env var stores
   *    only the token, not the literal `Bearer ` prefix.
   *  - Other `headers` entries become Codex `env_http_headers`, backed by
   *    synthetic per-run environment variables.
   *
   * Resolved secrets embedded in `args` still have to be written literally
   * because Codex has no argv env indirection.
   */
  writeMcpConfig(ctx: AgentMcpWriteContext): AgentMcpWriteResult {
    const codexConfigDir = codexHome();
    const configPath = path.join(codexConfigDir, "config.toml");
    const runtimeEnv: Record<string, string> = {};
    const lines: string[] = [
      CODEX_MCP_BEGIN,
      "# ShipIt-managed MCP servers. This block is regenerated before each Codex turn.",
    ];

    // docs/079 — built-in Playwright (browser) server, mirroring the Claude
    // adapter. Codex runs with approvalPolicy:"never", so these tools
    // auto-approve like every other tool; no allowlist plumbing is needed.
    // See playwright-mcp.ts for the `sh -c` launch / `--browser chromium`
    // rationale.
    lines.push(
      "",
      "[mcp_servers.playwright]",
      `command = ${tomlString(PLAYWRIGHT_MCP_COMMAND)}`,
      `args = ${tomlArray([...PLAYWRIGHT_MCP_ARGS])}`,
    );

    // SHI-128 / docs/199 — ONE consolidated stdio bridge serves all of ShipIt's
    // internal tools under the single `shipit` server, instead of five separate
    // processes. The `SHIPIT_MCP_TOOLS` env selects which tools to expose; Codex
    // gets review (docs/125), present (docs/093), voice (docs/163), ask
    // (docs/147 — Codex lacks a Default-mode native question tool, so this
    // exposes one whose output handleItem normalizes into an AskUserQuestion
    // tool_use), and bug (docs/164) — NOT permission (Codex uses its native
    // approval channel). The value is passed through `runtimeEnv` (the child's
    // env) and allowlisted via `env_vars`, matching how user-server env is wired.
    if (ctx.shipitBridge) {
      runtimeEnv.SHIPIT_MCP_TOOLS = "review,present,voice,ask,bug,propose_actions";
      lines.push(
        "",
        "[mcp_servers.shipit]",
        `command = ${tomlString(ctx.shipitBridge.tsxBin)}`,
        `args = ${tomlArray([ctx.shipitBridge.bridgePath])}`,
        `env_vars = ${tomlArray(["SHIPIT_MCP_TOOLS"])}`,
      );
    }

    for (const server of ctx.servers) {
      const { resolved, missing } = resolveMcpServer(server);
      if (!resolved) {
        const reason = `missing secret: ${missing.join(", ")}`;
        console.warn(`[mcp] dropping server "${server.name}": ${reason}`);
        ctx.onServerFailed(server.name, reason);
        continue;
      }

      lines.push("", `[mcp_servers.${server.name}]`);
      if (server.type === "stdio") {
        const command = resolved.command;
        if (typeof command === "string") {
          lines.push(`command = ${tomlString(command)}`);
        }
        const args = resolved.args;
        if (Array.isArray(args) && args.every((arg) => typeof arg === "string")) {
          lines.push(`args = ${tomlArray(args)}`);
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
            lines.push(`env_vars = ${tomlArray(envKeys)}`);
          }
        }
      } else {
        const url = resolved.url;
        if (typeof url === "string") {
          lines.push(`url = ${tomlString(url)}`);
        }
        const headers = resolved.headers;
        if (headers && typeof headers === "object" && !Array.isArray(headers)) {
          const envHeaders: Record<string, string> = {};
          let i = 0;
          for (const [header, value] of Object.entries(headers)) {
            if (typeof value !== "string") continue;
            if (header.toLowerCase() === "authorization") {
              const bearerToken = parseBearerToken(value);
              if (bearerToken) {
                const envKey = `SHIPIT_MCP_${server.name.toUpperCase()}_BEARER_TOKEN`;
                runtimeEnv[envKey] = bearerToken;
                lines.push(`bearer_token_env_var = ${tomlString(envKey)}`);
                continue;
              }
            }
            const envKey = `SHIPIT_MCP_${server.name.toUpperCase()}_HTTP_HEADER_${i++}`;
            runtimeEnv[envKey] = value;
            envHeaders[header] = envKey;
          }
          if (Object.keys(envHeaders).length > 0) {
            lines.push(`env_http_headers = ${tomlInlineStringMap(envHeaders)}`);
          }
        }
      }
    }

    lines.push("", CODEX_MCP_END, "");

    try {
      let existing = "";
      try {
        existing = readFileSync(configPath, "utf-8");
      } catch { /* no config yet */ }
      mkdirSync(codexConfigDir, { recursive: true });
      writeFileSync(configPath, replaceManagedCodexMcpBlock(existing, lines.join("\n")));
    } catch (err) {
      console.warn(`[mcp] failed to register codex MCP config: ${getErrorMessage(err)}`);
    }

    return { runtimeEnv };
  }

  // ---- JSON-RPC transport ----

  /** Send a JSON-RPC request and return a promise for the response. */
  private sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const msg: JsonRpcRequest = { method, id };
    if (params) msg.params = params;

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.writeJsonRpc(msg);
    });
  }

  /** Send a JSON-RPC notification (fire-and-forget, no response expected). */
  private sendNotification(method: string, params?: Record<string, unknown>): void {
    const msg: JsonRpcNotification = { method };
    if (params) msg.params = params;
    this.writeJsonRpc(msg);
  }

  /** Reply to a server→client request with a successful result. */
  private sendResponse(id: number, result: unknown): void {
    this.writeJsonRpc({ id, result });
  }

  /** Reply to a server→client request with a JSON-RPC error. */
  private sendErrorResponse(id: number, code: number, message: string): void {
    this.writeJsonRpc({ id, error: { code, message } });
  }

  /** Write a JSON-RPC message to the process stdin. */
  private writeJsonRpc(msg: JsonRpcRequest | JsonRpcNotification | JsonRpcOutboundResponse): void {
    if (!this.proc?.stdin?.writable) return;
    const line = `${JSON.stringify(msg)  }\n`;
    this.proc.stdin.write(line);
  }

  // ---- JSONL parsing ----

  private drainLines(flush = false): void {
    const lines = this.buffer.split("\n");
    if (!flush) {
      this.buffer = lines.pop() ?? "";
    } else {
      this.buffer = "";
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcInbound;
        this.handleMessage(msg);
      } catch {
        // Non-JSON line — log it
        this.emit("log", "codex-stdout", trimmed);
      }
    }
  }

  // ---- Message dispatch ----

  private handleMessage(msg: JsonRpcInbound): void {
    const hasId = "id" in msg && msg.id !== null && msg.id !== undefined;
    const hasMethod =
      "method" in msg && typeof (msg as { method?: unknown }).method === "string";

    // Server→client REQUEST: carries BOTH an id and a method. The app-server
    // blocks the turn until we answer it (approval prompts arrive this way).
    // This MUST be checked before the response branch — a server request also
    // has an id, and treating it as a response to one of our calls drops it on
    // the floor, hanging the turn forever (status → waitingOnApproval, UI stuck
    // on "Thinking…").
    if (hasId && hasMethod) {
      this.eventHandler.handleServerRequest(msg);
      return;
    }

    // Response to one of OUR pending requests: an id, no method.
    if (hasId) {
      const resp = msg as JsonRpcResponse;
      const pending = this.pendingRequests.get(resp.id);
      if (pending) {
        this.pendingRequests.delete(resp.id);
        if (resp.error) {
          pending.reject(new Error(`JSON-RPC error ${resp.error.code}: ${this.rateLimits.normalizeJsonRpcError(resp.error.message)}`));
        } else {
          pending.resolve(resp.result);
        }
      }
      return;
    }

    // Server notification: a method, no id.
    this.eventHandler.handleNotification(msg as JsonRpcServerNotification);
  }
}

// ---- TOML emit helpers (kept module-local — Codex is the only adapter
// emitting a TOML block today, and breaking these out for symmetry with the
// other adapters would over-generalize). ----

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: string[]): string {
  return `[${values.map((v) => tomlString(v)).join(", ")}]`;
}

function tomlInlineStringMap(values: Record<string, string>): string {
  const entries = Object.entries(values).map(
    ([key, value]) => `${tomlString(key)} = ${tomlString(value)}`,
  );
  return `{ ${entries.join(", ")} }`;
}

function parseBearerToken(value: string): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  const token = match?.[1]?.trim();
  return token ? token : null;
}

const CODEX_MCP_BEGIN = "# <shipit-managed-mcp>";
const CODEX_MCP_END = "# </shipit-managed-mcp>";

function replaceManagedCodexMcpBlock(existing: string, block: string): string {
  const start = existing.indexOf(CODEX_MCP_BEGIN);
  const end = existing.indexOf(CODEX_MCP_END);
  const normalizedBlock = block.endsWith("\n") ? block : `${block}\n`;
  if (start !== -1 && end !== -1 && end > start) {
    const afterEnd = end + CODEX_MCP_END.length;
    return `${existing.slice(0, start).trimEnd()}\n\n${normalizedBlock}${existing.slice(afterEnd).trimStart()}`;
  }
  return `${existing.trimEnd()}${existing.trimEnd() ? "\n\n" : ""}${normalizedBlock}`;
}
