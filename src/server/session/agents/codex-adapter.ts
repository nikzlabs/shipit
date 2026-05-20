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
 */

import { EventEmitter } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import type {
  AgentId,
  AgentCapabilities,
  AgentEvent,
  AgentProcess,
  AgentProcessEvents,
  AgentRunParams,
  AgentContentBlock,
} from "./agent-process.js";

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
 * the shared `/credentials` volume (see Dockerfile.* — feature 119).
 */
const CODEX_AUTH_FILE = "/root/.codex/auth.json";

/**
 * True iff /root/.codex/auth.json exists and is a non-empty regular file.
 * Exported for unit tests and for reuse by AgentRegistry.checkCodexAuth.
 */
export function hasCodexFileAuth(): boolean {
  try {
    if (!existsSync(CODEX_AUTH_FILE)) return false;
    const st = statSync(CODEX_AUTH_FILE);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

// ---- Codex item types ----

/**
 * An item from a Codex turn — message, command, file change, etc.
 *
 * Shapes follow the Codex App Server v2 protocol (CLI 0.132.x). Generate the
 * authoritative schema with `codex app-server generate-json-schema --out DIR`
 * and read `ItemCompletedNotification.json` → `definitions.ThreadItem`. The
 * `type` discriminator selects the variant; the fields below are the union of
 * the variants we map to ShipIt events.
 */
interface CodexItem {
  type?: string;
  id?: string;
  // agentMessage — final assistant text (a plain string, NOT a content array)
  text?: string;
  // userMessage / reasoning — typed content blocks (we don't surface these)
  content?: { type: string; text?: string }[];
  // commandExecution — shell tool calls
  command?: string;
  cwd?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  status?: string;
  // fileChange — applied patch
  changes?: { path: string; kind?: string; diff?: string }[];
  // mcpToolCall / dynamicToolCall — generic tool invocations
  tool?: string;
  arguments?: string; // JSON-encoded arguments
  result?: unknown;
  error?: unknown;
}

/**
 * Token usage snapshot from a `thread/tokenUsage/updated` notification.
 * `total` is the cumulative turn rollup (billing); `last` is the most recent
 * API call (real context-window occupancy — see AgentResultEvent.contextTokens).
 */
interface CodexTokenUsage {
  total?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
  last?: { totalTokens?: number };
  modelContextWindow?: number;
}

/**
 * One rate-limit window from an `account/rateLimits/updated` notification.
 * `usedPercent` is 0–100, `resetsAt` is epoch *seconds*, `windowDurationMins`
 * distinguishes the 5-hour (300) and weekly (10080) windows. The app-server
 * sends two: `primary` (the 5h session window) and `secondary` (weekly).
 */
interface CodexRateLimitWindow {
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

export class CodexAdapter
  extends EventEmitter<AgentProcessEvents>
  implements AgentProcess
{
  readonly agentId: AgentId = "codex";

  readonly capabilities: AgentCapabilities = {
    supportsResume: true,
    supportsImages: false,
    supportsSystemPrompt: true,
    supportsPermissionModes: false,
    supportedPermissionModes: [],
    toolNames: ["shell", "file_write", "file_read", "file_edit"],
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
    // Codex has neither a subagent primitive nor a hook for registering
    // custom tools. 125 requires both, so the chat-native review flow is
    // gated off on Codex sessions.
    supportsReview: false,
    supportsSteering: true,
  };

  private proc: ChildProcess | null = null;
  private buffer = "";
  private nextId = 1;
  private threadId: string | null = null;
  private initialized = false;
  private turnStartTime = 0;

  /**
   * itemIds whose text we already streamed via `item/agentMessage/delta`.
   * On the matching `item/completed` we skip re-emitting the full text — the
   * orchestrator APPENDS each `agent_assistant` text block (`accumulatedText
   * += text`), so emitting both the deltas and the final text would double it.
   */
  private streamedAgentItems = new Set<string>();

  /** Latest token usage from `thread/tokenUsage/updated`, surfaced at turn end. */
  private lastTokenUsage: CodexTokenUsage | null = null;

  /** Pending JSON-RPC requests awaiting a response, keyed by id. */
  private pendingRequests = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (err: Error) => void }
  >();

  /**
   * Spawn the Codex App Server process.
   * The process stays alive across turns — we create threads and turns within it.
   */
  run(params: AgentRunParams): void {
    this.turnStartTime = Date.now();

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
    //      writes credentials to /root/.codex/auth.json (a symlink into the
    //      shared credentials volume). When present, the CLI uses the user's
    //      ChatGPT plan / Codex credits.
    //   2. OPENAI_API_KEY env var — bills against the user's OpenAI Platform
    //      account (separate from any ChatGPT subscription).
    //
    // If both are configured, we prefer the subscription path: strip the env
    // key from the spawned child so `codex` doesn't silently route through
    // Platform API billing — that's exactly the bug this feature exists to
    // fix.
    const hasFileAuth = hasCodexFileAuth();
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
    this.initializeAndRun(params).catch((err: unknown) => {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    });
  }

  readonly isStreaming = false;

  writeStdin(data: string): void {
    // For Codex, user input during a turn is sent via turn/steer.
    //
    // `input` is an array of content blocks, not a string. The Codex
    // app-server tightened its schema in CLI 0.131.x — sending a bare
    // string now fails with JSON-RPC -32600 "invalid type: string,
    // expected a sequence". See `initializeAndRun` for the matching
    // `turn/start` shape.
    if (this.proc && this.threadId) {
      this.sendNotification("turn/steer", {
        threadId: this.threadId,
        input: [{ type: "text", text: data.trim() }],
      });
    }
  }

  sendUserMessage(text: string, _opts?: { images?: unknown[] }): void {
    // Codex steers via turn/steer (writeStdin already does this)
    this.writeStdin(text);
  }

  interrupt(): void {
    // Codex doesn't have a graceful interrupt — just kill the process
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
      this.handleServerRequest(msg);
      return;
    }

    // Response to one of OUR pending requests: an id, no method.
    if (hasId) {
      const resp = msg as JsonRpcResponse;
      const pending = this.pendingRequests.get(resp.id);
      if (pending) {
        this.pendingRequests.delete(resp.id);
        if (resp.error) {
          pending.reject(new Error(`JSON-RPC error ${resp.error.code}: ${resp.error.message}`));
        } else {
          pending.resolve(resp.result);
        }
      }
      return;
    }

    // Server notification: a method, no id.
    this.handleNotification(msg as JsonRpcServerNotification);
  }

  /**
   * Answer a server→client request from the app-server.
   *
   * ShipIt runs Codex inside its own session container — the container IS the
   * sandbox and the agent is meant to operate the box autonomously (CLAUDE.md
   * §5), exactly like the Claude adapter, which auto-approves everything. So we
   * auto-approve every approval request. `approvalPolicy: "never"` (see
   * `initializeAndRun`) suppresses MOST prompts, but the model can still
   * request escalated permissions explicitly, which forces an approval request
   * regardless of policy. Leaving that unanswered is THE bug behind "Codex
   * stuck on Thinking…": the turn blocks (status flips to waitingOnApproval)
   * waiting for a response that never comes.
   *
   * Decision enums come straight from the generated v2 schema
   * (`codex app-server generate-json-schema`): CommandExecution/FileChange
   * approvals take `"accept"`; the legacy v1 ReviewDecision takes `"approved"`.
   */
  private handleServerRequest(req: JsonRpcServerRequest): void {
    switch (req.method) {
      // v2 protocol (turn/start) — CommandExecution/FileChange ApprovalDecision.
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval": {
        this.sendResponse(req.id, { decision: "accept" });
        return;
      }
      // v1 (legacy) protocol — ReviewDecision.
      case "execCommandApproval":
      case "applyPatchApproval": {
        this.sendResponse(req.id, { decision: "approved" });
        return;
      }
      default: {
        // Any other server→client request (tool input, MCP elicitation, …) we
        // can't satisfy without a human. Reply with a JSON-RPC error rather
        // than leaving it hanging — the turn then fails fast and visibly
        // instead of silently stalling on "Thinking…".
        this.emit("log", "codex-rpc", `unhandled server request: ${req.method}`);
        this.sendErrorResponse(req.id, -32601, `Method not handled by ShipIt: ${req.method}`);
      }
    }
  }

  /** Handle streaming notifications from the Codex App Server. */
  private handleNotification(notif: JsonRpcServerNotification): void {
    const params = notif.params ?? {};

    switch (notif.method) {
      case "thread/started": {
        // CLI 0.132.x nests the id under `thread.id`; older shape had a
        // top-level `threadId`. Accept both.
        const thread = params.thread as { id?: string } | undefined;
        this.threadId = thread?.id ?? (params.threadId as string) ?? this.threadId;
        break;
      }

      case "turn/started": {
        // Turn has begun — nothing to emit yet
        break;
      }

      case "thread/status/changed": {
        // Activity/status transitions (e.g. activeFlags: ["waitingOnApproval"]).
        // We don't surface a distinct "waiting for approval" UI state because
        // approval requests are auto-answered in handleServerRequest — just
        // like Claude, the agent never actually blocks on a human here, so the
        // wait is transient and a separate indicator would only flicker. Log
        // it for diagnostics.
        const status = params.status as { activeFlags?: string[] } | undefined;
        const flags = status?.activeFlags?.join(",") ?? "";
        this.emit("log", "codex-rpc", `thread/status/changed: ${flags || "active"}`);
        break;
      }

      case "thread/tokenUsage/updated": {
        this.lastTokenUsage = (params.tokenUsage as CodexTokenUsage) ?? this.lastTokenUsage;
        break;
      }

      case "account/rateLimits/updated": {
        this.handleRateLimits(params);
        break;
      }

      case "item/started": {
        this.handleItem(params, "started");
        break;
      }

      case "item/completed": {
        this.handleItem(params, "completed");
        break;
      }

      case "item/agentMessage/delta": {
        // Incremental text delta for streaming
        this.handleMessageDelta(params);
        break;
      }

      case "turn/completed": {
        this.handleTurnCompleted(params);
        break;
      }

      default: {
        // Log unhandled notifications for debugging
        this.emit("log", "codex-rpc", `${notif.method}: ${JSON.stringify(params).slice(0, 200)}`);
        break;
      }
    }
  }

  // ---- Event mapping (Codex → AgentEvent) ----

  /**
   * Map a Codex `item/started` or `item/completed` notification to ShipIt
   * AgentEvents. `phase` distinguishes the two so tool calls render live
   * (tool_use on "started") with their output attached afterward (tool_result
   * on "completed").
   *
   * The item shapes are the Codex App Server v2 protocol (CLI 0.132.x) — the
   * pre-0.132 `role:"assistant"`/`function_call`/`function_call_output` shapes
   * this adapter used to parse no longer appear on the wire. See CodexItem.
   */
  private handleItem(params: Record<string, unknown>, phase: "started" | "completed"): void {
    const item = (params.item ?? params) as CodexItem;
    const id = item.id ?? `codex-${Date.now()}`;

    switch (item.type) {
      case "agentMessage": {
        // Final assistant text. Streamed incrementally via
        // `item/agentMessage/delta`; if we already streamed this item, the
        // completed text would be a duplicate (the orchestrator appends).
        if (phase !== "completed") return;
        if (item.id && this.streamedAgentItems.has(item.id)) return;
        if (item.text) this.emitAssistant([{ type: "text", text: item.text }]);
        return;
      }

      case "commandExecution": {
        if (phase === "started") {
          this.emitAssistant([
            { type: "tool_use", id, name: "shell", input: { command: item.command ?? "", cwd: item.cwd } },
          ]);
        } else {
          const out = item.aggregatedOutput ?? "";
          const exit = item.exitCode;
          const content =
            exit !== null && exit !== undefined && exit !== 0 ? `${out}\n[exit code: ${exit}]` : out;
          this.emitToolResult(id, content);
        }
        return;
      }

      case "fileChange": {
        // The patch has already been applied to disk by the time we see the
        // completed item; surface it as a tool call so the edit is visible.
        if (phase !== "completed") return;
        const changes = item.changes ?? [];
        this.emitAssistant([
          { type: "tool_use", id, name: "apply_patch", input: { files: changes.map((c) => c.path) } },
        ]);
        const summary = changes.map((c) => `${c.kind ?? "update"} ${c.path}`).join("\n");
        this.emitToolResult(id, summary || "applied");
        return;
      }

      case "mcpToolCall":
      case "dynamicToolCall": {
        if (phase === "started") {
          let input: Record<string, unknown> = {};
          if (item.arguments) {
            try {
              input = JSON.parse(item.arguments) as Record<string, unknown>;
            } catch {
              input = { raw: item.arguments };
            }
          }
          this.emitAssistant([{ type: "tool_use", id, name: item.tool ?? "tool", input }]);
        } else {
          const payload = item.result ?? item.error ?? "";
          this.emitToolResult(id, typeof payload === "string" ? payload : JSON.stringify(payload));
        }
        break;
      }

      // userMessage (echo of our own prompt), reasoning, plan, webSearch,
      // imageView, etc. have no ShipIt mapping — ignore them.
      default:
        break;
    }
  }

  /** Emit an assistant event with the given content blocks. */
  private emitAssistant(content: AgentContentBlock[]): void {
    this.emit("event", { type: "agent_assistant", content } as AgentEvent);
  }

  /** Emit a tool-result event for the given tool_use id. */
  private emitToolResult(toolUseId: string, content: string): void {
    this.emit("event", {
      type: "agent_tool_result",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
    } as AgentEvent);
  }

  /**
   * Handle incremental message deltas (streaming text). The v2 protocol
   * delivers `delta` as a plain string with the item's `itemId`; we record the
   * id so the matching `item/completed` agentMessage isn't re-emitted.
   */
  private handleMessageDelta(params: Record<string, unknown>): void {
    const delta = params.delta;
    if (typeof delta !== "string" || delta.length === 0) return;
    const itemId = params.itemId as string | undefined;
    if (itemId) this.streamedAgentItems.add(itemId);
    this.emitAssistant([{ type: "text", text: delta }]);
  }

  /** Handle turn completion — emit agent_result. */
  private handleTurnCompleted(params: Record<string, unknown>): void {
    // v2 nests status under `turn`; older shape had a top-level `status`.
    const turn = params.turn as { status?: string } | undefined;
    const status = turn?.status ?? (params.status as string) ?? "completed";
    const usage = this.lastTokenUsage;
    const durationMs = Date.now() - this.turnStartTime;

    this.emit("event", {
      type: "agent_result",
      status: status === "completed" ? "success" : "error",
      sessionId: this.threadId ?? "unknown",
      // `total` is the cumulative turn rollup (billing); `last.totalTokens` is
      // the real context-window occupancy (input + cache from the final call).
      tokens: usage?.total
        ? {
            input: usage.total.inputTokens ?? 0,
            output: usage.total.outputTokens ?? 0,
            cacheRead: usage.total.cachedInputTokens,
          }
        : undefined,
      contextTokens: usage?.last?.totalTokens,
      contextWindow: usage?.modelContextWindow,
      durationMs,
      error: status !== "completed" ? `Turn ended with status: ${status}` : undefined,
    } as AgentEvent);

    // Kill the app-server process after the turn completes
    // (matching the one-shot-per-turn pattern of ClaudeAdapter)
    this.kill();
  }

  /**
   * Map an `account/rateLimits/updated` notification to an
   * `agent_rate_limits` event. The app-server reports two windows —
   * `primary` (5h session) and `secondary` (weekly) — the same data it
   * draws its `/status` line from. The orchestrator routes this into the
   * subscription-limits badge. We don't emit when neither window parses,
   * so a malformed payload simply leaves the badge on its last snapshot.
   */
  private handleRateLimits(params: Record<string, unknown>): void {
    const rl = params.rateLimits as Record<string, unknown> | undefined;
    if (!rl || typeof rl !== "object") return;

    const session = this.parseRateWindow(rl.primary);
    const weekly = this.parseRateWindow(rl.secondary);
    if (!session && !weekly) return;

    this.emit("event", { type: "agent_rate_limits", session, weekly } as AgentEvent);
  }

  /** Normalize one Codex rate-limit window into `{ usedPct, resetAt }`. */
  private parseRateWindow(
    raw: unknown,
  ): { usedPct: number; resetAt: string } | null {
    if (!raw || typeof raw !== "object") return null;
    const w = raw as CodexRateLimitWindow;
    if (typeof w.usedPercent !== "number" || !Number.isFinite(w.usedPercent)) return null;
    if (typeof w.resetsAt !== "number" || !Number.isFinite(w.resetsAt) || w.resetsAt <= 0) return null;
    const usedPct = Math.min(100, Math.max(0, w.usedPercent));
    // resetsAt is epoch seconds; tolerate a ms value defensively.
    const ms = w.resetsAt < 10_000_000_000 ? w.resetsAt * 1000 : w.resetsAt;
    return { usedPct, resetAt: new Date(ms).toISOString() };
  }

  // ---- Initialization and turn lifecycle ----

  /**
   * Perform the JSON-RPC initialization handshake, create/resume a thread,
   * and start a turn with the user's prompt.
   */
  private async initializeAndRun(params: AgentRunParams): Promise<void> {
    // Step 1: Initialize handshake
    await this.sendRequest("initialize", {
      clientInfo: {
        name: "shipit",
        title: "ShipIt IDE",
        version: "1.0.0",
      },
    });
    this.sendNotification("initialized");
    this.initialized = true;

    // Step 2: Start or resume a thread.
    //
    // ShipIt's environment instructions (the "you are running inside ShipIt…"
    // system prompt built by buildAgentSystemInstructions) arrive as
    // `params.systemPrompt`. Codex's app-server has no per-turn system-prompt
    // slot, but `thread/start`/`thread/resume` accept `developerInstructions` —
    // appended to the model's base instructions rather than replacing them
    // (that's `baseInstructions`, which we deliberately leave alone). Without
    // this, Codex sessions had no idea they were running inside ShipIt, unlike
    // Claude (which gets the same text via `--system-prompt`).
    const threadBase: Record<string, unknown> = {};
    if (params.systemPrompt) {
      threadBase.developerInstructions = params.systemPrompt;
    }

    let threadResult: unknown;
    if (params.sessionId) {
      // Resume existing thread
      try {
        threadResult = await this.sendRequest("thread/resume", {
          ...threadBase,
          threadId: params.sessionId,
        });
      } catch {
        // If resume fails, start a new thread
        threadResult = await this.sendRequest("thread/start", { ...threadBase });
      }
    } else {
      threadResult = await this.sendRequest("thread/start", { ...threadBase });
    }

    // Extract thread ID from the response.
    //
    // CLI 0.132.x nests the id under `thread.id`; the pre-0.132 shape had a
    // top-level `threadId`. Accept both. Reading only `threadId` was THE bug
    // behind "There's an issue with the selected model (gpt-5.x)": with the
    // new shape `this.threadId` stayed null, so `turn/start` went out with a
    // null threadId and the app-server rejected the whole turn with
    // -32600 "missing field `threadId`" — which the model-picker rendered as
    // a model-access error. The model was never the problem.
    const threadData = threadResult as { thread?: { id?: string }; threadId?: string } | undefined;
    const resolvedThreadId = threadData?.thread?.id ?? threadData?.threadId;
    if (resolvedThreadId) {
      this.threadId = resolvedThreadId;
    }

    // Emit agent_init so the server can track the session
    this.emit("event", {
      type: "agent_init",
      agentId: "codex",
      sessionId: this.threadId ?? `codex-${Date.now()}`,
      model: params.model ?? "gpt-5.5",
      tools: this.capabilities.toolNames,
    } as AgentEvent);

    // Step 3: Build turn input.
    //
    // `input` is an array of typed content blocks (`{type:"text",text:"…"}`)
    // — Codex CLI 0.131.x tightened the `turn/start` schema and the
    // app-server now rejects a bare string with:
    //
    //   {"error":{"code":-32600,
    //     "message":"Invalid request: invalid type: string \"…\",
    //                expected a sequence"}}
    //
    // The earlier UI symptom was a confusing "There's an issue with the
    // selected model (gpt-5.4)" — that was the model-picker rendering a
    // generic failure for the rejected turn, not an actual model access
    // problem. The fix is to send the new shape; gpt-5.4 (and the rest of
    // the lineup) work fine once the request is well-formed.
    const turnParams: Record<string, unknown> = {
      threadId: this.threadId,
      input: [{ type: "text", text: params.prompt }],
      // ShipIt runs each agent inside its own session container — the
      // container IS the sandbox and the agent is meant to operate the box
      // autonomously (CLAUDE.md §5). So we disable Codex's own approval gate
      // and internal sandbox: otherwise every shell command stalls on an
      // `item/commandExecution/requestApproval` that nothing answers, and
      // Codex's bubblewrap sandbox fails outright in-container ("No
      // permissions to create a new namespace"). Both apply for this turn and
      // subsequent steers. See TurnStartParams in the generated v2 schema.
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    };

    if (params.cwd) {
      turnParams.cwd = params.cwd;
    }

    if (params.model) {
      turnParams.model = params.model;
    }

    // Step 4: Start the turn (this triggers streaming notifications)
    await this.sendRequest("turn/start", turnParams);
  }
}
