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

/** Inbound notification (app-server → client). */
interface JsonRpcServerNotification {
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcInbound = JsonRpcResponse | JsonRpcServerNotification;

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

/** An item from a Codex turn — message, command, file change, etc. */
interface CodexItem {
  type?: string;
  // Agent message items
  role?: string;
  content?: { type: string; text?: string; annotations?: unknown[] }[];
  // Command execution items
  call_id?: string;
  name?: string;
  arguments?: string; // JSON-encoded arguments
  status?: string;
  output?: string;
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
  };

  private proc: ChildProcess | null = null;
  private buffer = "";
  private nextId = 1;
  private threadId: string | null = null;
  private initialized = false;
  private turnStartTime = 0;

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

  writeStdin(data: string): void {
    // For Codex, user input during a turn is sent via turn/steer
    if (this.proc && this.threadId) {
      this.sendNotification("turn/steer", {
        threadId: this.threadId,
        input: data.trim(),
      });
    }
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

  /** Write a JSON-RPC message to the process stdin. */
  private writeJsonRpc(msg: JsonRpcRequest | JsonRpcNotification): void {
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
    // Response to a pending request
    if ("id" in msg && msg.id !== null && msg.id !== undefined) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        const resp = msg;
        if (resp.error) {
          pending.reject(new Error(`JSON-RPC error ${resp.error.code}: ${resp.error.message}`));
        } else {
          pending.resolve(resp.result);
        }
      }
      return;
    }

    // Server notification
    const notif = msg as JsonRpcServerNotification;
    this.handleNotification(notif);
  }

  /** Handle streaming notifications from the Codex App Server. */
  private handleNotification(notif: JsonRpcServerNotification): void {
    const params = notif.params ?? {};

    switch (notif.method) {
      case "thread/started": {
        this.threadId = (params.threadId as string) ?? this.threadId;
        break;
      }

      case "turn/started": {
        // Turn has begun — nothing to emit yet
        break;
      }

      case "item/started":
      case "item/completed": {
        this.handleItem(params);
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

  /** Handle an item notification (started or completed). */
  private handleItem(params: Record<string, unknown>): void {
    const item = (params.item ?? params) as CodexItem;

    // Agent message items (role: "assistant")
    if (item.role === "assistant" && item.content) {
      const blocks = this.mapContentBlocks(item.content);
      if (blocks.length > 0) {
        this.emit("event", {
          type: "agent_assistant",
          content: blocks,
        } as AgentEvent);
      }
      return;
    }

    // Function/tool call items
    if (item.type === "function_call" || item.name) {
      const toolName = item.name ?? "unknown";
      let input: Record<string, unknown> = {};
      if (item.arguments) {
        try {
          input = JSON.parse(item.arguments) as Record<string, unknown>;
        } catch {
          input = { raw: item.arguments };
        }
      }

      this.emit("event", {
        type: "agent_assistant",
        content: [
          {
            type: "tool_use",
            id: item.call_id ?? `codex-${Date.now()}`,
            name: toolName,
            input,
          },
        ],
      } as AgentEvent);
      return;
    }

    // Function call output (tool result)
    if (item.type === "function_call_output" && item.output !== null && item.output !== undefined) {
      this.emit("event", {
        type: "agent_tool_result",
        content: [
          {
            type: "tool_result",
            tool_use_id: item.call_id ?? "unknown",
            content: item.output,
          },
        ],
      } as AgentEvent);
      
    }
  }

  /** Handle incremental message deltas (streaming text). */
  private handleMessageDelta(params: Record<string, unknown>): void {
    const delta = params.delta as { content?: { type: string; text?: string }[] } | undefined;
    if (!delta?.content) return;

    const blocks = this.mapContentBlocks(delta.content);
    if (blocks.length > 0) {
      this.emit("event", {
        type: "agent_assistant",
        content: blocks,
      } as AgentEvent);
    }
  }

  /** Handle turn completion — emit agent_result. */
  private handleTurnCompleted(params: Record<string, unknown>): void {
    const status = (params.status as string) ?? "completed";
    const usage = params.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    const durationMs = Date.now() - this.turnStartTime;

    this.emit("event", {
      type: "agent_result",
      status: status === "completed" ? "success" : "error",
      sessionId: this.threadId ?? "unknown",
      tokens: usage
        ? {
            input: usage.input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
          }
        : undefined,
      durationMs,
      error: status !== "completed" ? `Turn ended with status: ${status}` : undefined,
    } as AgentEvent);

    // Kill the app-server process after the turn completes
    // (matching the one-shot-per-turn pattern of ClaudeAdapter)
    this.kill();
  }

  /** Map Codex content blocks to AgentContentBlock format. */
  private mapContentBlocks(
    blocks: { type: string; text?: string; annotations?: unknown[] }[],
  ): AgentContentBlock[] {
    const result: AgentContentBlock[] = [];
    for (const block of blocks) {
      if (block.type === "output_text" || block.type === "text") {
        if (block.text) {
          result.push({ type: "text", text: block.text });
        }
      }
    }
    return result;
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

    // Step 2: Start or resume a thread
    let threadResult: unknown;
    if (params.sessionId) {
      // Resume existing thread
      try {
        threadResult = await this.sendRequest("thread/resume", {
          threadId: params.sessionId,
        });
      } catch {
        // If resume fails, start a new thread
        threadResult = await this.sendRequest("thread/start", {});
      }
    } else {
      threadResult = await this.sendRequest("thread/start", {});
    }

    // Extract thread ID from the response
    const threadData = threadResult as { threadId?: string } | undefined;
    if (threadData?.threadId) {
      this.threadId = threadData.threadId;
    }

    // Emit agent_init so the server can track the session
    this.emit("event", {
      type: "agent_init",
      agentId: "codex",
      sessionId: this.threadId ?? `codex-${Date.now()}`,
      model: params.model ?? "gpt-5.5",
      tools: this.capabilities.toolNames,
    } as AgentEvent);

    // Step 3: Build turn input
    const turnParams: Record<string, unknown> = {
      threadId: this.threadId,
      input: params.prompt,
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
