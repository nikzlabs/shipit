/**
 * CodexEventHandler — the thread/turn event-stream processing for the Codex
 * adapter.
 *
 * It owns the per-turn parsing state (streamed-item dedup, emitted-tool dedup,
 * thread/turn identity, compaction tracking) and translates the Codex App
 * Server's streaming JSON-RPC notifications and blocking approval requests into
 * normalized ShipIt AgentEvents. Process spawning and the JSON-RPC wire format
 * (send/receive framing) stay in `CodexAdapter`; the handler reaches them
 * through the injected `CodexTransport` so the same parsing logic is unit-test
 * friendly and decoupled from the child process.
 *
 * The emitted event shapes, the docs/193 permission translation, and the
 * docs/178 compaction signals are byte-for-byte the same as when this lived
 * inline in the adapter — the orchestrator-side normalization depends on them.
 */

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type {
  AgentContentBlock,
  AgentEvent,
  AgentRunParams,
  PermissionRequester,
} from "../agent-process.js";
import type { CodexRateLimits, CodexTokenUsage } from "./codex-rate-limits.js";
import {
  buildCodexPermissionInput,
  contentToAddedDiff,
  fileChangeKindLabel,
  isAskUserQuestionTool,
  normalizeFileChangeDiff,
  normalizeWebSearchItem,
  summarizeCodexSubagentPrompt,
  unwrapShellCommand,
  type CodexItem,
} from "./codex-tool-normalizer.js";

/** Inbound request (app-server → client) — has BOTH an id and a method. */
interface JsonRpcServerRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** Inbound notification (app-server → client, no id). */
interface JsonRpcServerNotification {
  method: string;
  params?: Record<string, unknown>;
}

/**
 * The slice of the adapter the event handler depends on: emitting normalized
 * events/logs, the JSON-RPC transport, and process teardown. Implemented by
 * `CodexAdapter`, which retains the wire format and child-process lifecycle.
 */
export interface CodexTransport {
  emitEvent(event: AgentEvent): void;
  emitLog(source: string, text: string): void;
  sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown>;
  sendResponse(id: number, result: unknown): void;
  sendErrorResponse(id: number, code: number, message: string): void;
  sendNotification(method: string, params?: Record<string, unknown>): void;
  kill(): void;
}

export class CodexEventHandler {
  constructor(
    private readonly ctx: CodexTransport,
    private readonly rateLimits: CodexRateLimits,
    private readonly toolNames: string[],
  ) {}

  private threadId: string | null = null;
  private initialized = false;
  private turnStartTime = 0;
  private cwd = "";

  /**
   * Id of the turn currently in flight, captured from the `turn/started`
   * event (and the `turn/start` response as a fallback). `turn/steer` requires
   * it as `expectedTurnId` — the app-server validates it is non-empty and
   * matches the active turn, and silently drops the steer otherwise. Cleared
   * on `turn/completed`. Without this, live steering of Codex was a no-op.
   */
  private currentTurnId: string | null = null;

  /**
   * itemIds whose text we already streamed via `item/agentMessage/delta`.
   * On the matching `item/completed` we skip re-emitting the full text — the
   * orchestrator APPENDS each `agent_assistant` text block (`accumulatedText
   * += text`), so emitting both the deltas and the final text would double it.
   */
  private streamedAgentItems = new Set<string>();

  /**
   * Tool-use ids already surfaced to ShipIt's chat model this turn. Codex App
   * Server v2 does not consistently send `item/started` for every tool shape
   * (notably MCP/dynamic tools can be completed-only), so completed handlers
   * synthesize the missing tool_use before the result. This set prevents a
   * duplicate card when both phases arrive.
   */
  private emittedToolUseIds = new Set<string>();

  /**
   * docs/178 — true once ShipIt has asked this app-server to compact (via
   * `compact()` or a `compact`-flagged run). Codex emits no manual/auto field on
   * its `contextCompaction` items, so the adapter labels the normalized event by
   * correlation: `"manual"` when we requested it, `"auto"` otherwise (the CLI
   * compacted on its own). Reset is unnecessary — the adapter instance is
   * one-shot-per-turn (killed on turn completion).
   */
  private compactionRequested = false;

  /**
   * docs/178 — true when this run was spawned purely to compact
   * (`run({ compact: true })`): we issue `thread/compact/start` instead of a
   * `turn/start`, so there is no normal turn lifecycle to end the run. The
   * `contextCompaction` `item/completed` becomes the turn terminus — we emit a
   * synthetic `agent_result` and tear down. `compactionTerminated` guards
   * against a double `agent_result` if the app-server ALSO sends `turn/completed`.
   */
  private compactSpawnMode = false;
  private compactionTerminated = false;

  /** Context occupancy captured when compaction started, used as `preTokens`. */
  private compactionPreTokens: number | undefined;

  /**
   * docs/193 — the worker's `PermissionBroker.request`, injected before run.
   * When set, the app-server's blocking approval requests are routed through it
   * (surfacing the shared approve/deny card) instead of being auto-accepted.
   */
  private requestPermission: PermissionRequester | null = null;

  // ---- Adapter-facing accessors ----

  getThreadId(): string | null {
    return this.threadId;
  }

  getCurrentTurnId(): string | null {
    return this.currentTurnId;
  }

  setPermissionRequester(requester: PermissionRequester): void {
    this.requestPermission = requester;
  }

  /** Mark a compaction as ShipIt-requested so its items are labeled "manual". */
  markCompactionRequested(): void {
    this.compactionRequested = true;
  }

  /** Reset per-turn state at the start of a run (mirrors `run()`'s old prologue). */
  beginTurn(cwd: string): void {
    this.turnStartTime = Date.now();
    this.cwd = cwd;
    this.emittedToolUseIds.clear();
  }

  // ---- Server→client request handling ----

  /**
   * Answer a server→client request from the app-server.
   *
   * Approval requests (the `item/.../requestApproval` pair, legacy
   * `execCommandApproval` / `applyPatchApproval`) are the app-server's blocking
   * permission gate: it holds the turn (status → waitingOnApproval) until we
   * respond. The model can
   * raise one even under `approvalPolicy: "never"` by explicitly requesting
   * escalated permissions; leaving it unanswered is THE bug behind "Codex stuck
   * on Thinking…".
   *
   * docs/193 — instead of always auto-accepting (which routed around the user
   * for genuinely escalated actions), route the request through the shared
   * `PermissionBroker` when one is injected, so it surfaces the same approve/
   * deny card as Claude's sensitive-file gate. When no requester is wired
   * (tests / the broker is unavailable) OR the broker path throws, fall back to
   * the historical auto-accept so a turn can never hang waiting on a human who
   * isn't being asked.
   *
   * Decision enums come from the generated v2 schema (`codex app-server
   * generate-json-schema`): CommandExecution/FileChange ApprovalDecision is
   * `"accept"`/`"reject"`; the legacy v1 ReviewDecision is `"approved"`/`"denied"`.
   */
  handleServerRequest(req: JsonRpcServerRequest): void {
    switch (req.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        this.resolveApproval(req, "v2");
        return;
      case "execCommandApproval":
      case "applyPatchApproval":
        this.resolveApproval(req, "v1");
        return;
      default: {
        // Any other server→client request (tool input, MCP elicitation, …) we
        // can't satisfy without a human. Reply with a JSON-RPC error rather
        // than leaving it hanging — the turn then fails fast and visibly
        // instead of silently stalling on "Thinking…".
        this.ctx.emitLog("codex-rpc", `unhandled server request: ${req.method}`);
        this.ctx.sendErrorResponse(req.id, -32601, `Method not handled by ShipIt: ${req.method}`);
      }
    }
  }

  /**
   * docs/193 — surface a Codex approval request as the shared approve/deny card
   * (when a broker requester is wired) and answer the blocking JSON-RPC request
   * with the user's decision, mapped to the protocol's enum. Auto-accepts when
   * no requester is available or the broker path errors (never hang the turn).
   */
  private resolveApproval(req: JsonRpcServerRequest, protocol: "v1" | "v2"): void {
    const accept = protocol === "v2" ? "accept" : "approved";
    const reject = protocol === "v2" ? "reject" : "denied";

    if (!this.requestPermission) {
      this.ctx.sendResponse(req.id, { decision: accept });
      return;
    }

    const input = buildCodexPermissionInput(req.method, req.params ?? {});
    const requester = this.requestPermission;
    void (async () => {
      try {
        const decision = await requester({ ...input, agentId: "codex" });
        this.ctx.sendResponse(req.id, { decision: decision.behavior === "allow" ? accept : reject });
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        this.ctx.emitLog("codex-rpc", `permission broker error, auto-accepting: ${reason}`);
        this.ctx.sendResponse(req.id, { decision: accept });
      }
    })();
  }

  // ---- Notification handling ----

  /** Handle streaming notifications from the Codex App Server. */
  handleNotification(notif: JsonRpcServerNotification): void {
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
        // Turn has begun — capture its id so live steering can pass it as
        // `expectedTurnId` on `turn/steer`. The v2 shape nests it under
        // `turn.id`; accept a top-level `turnId` defensively.
        const turn = params.turn as { id?: string } | undefined;
        this.currentTurnId = turn?.id ?? (params.turnId as string) ?? this.currentTurnId;
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
        this.ctx.emitLog("codex-rpc", `thread/status/changed: ${flags || "active"}`);
        break;
      }

      case "thread/tokenUsage/updated": {
        this.rateLimits.recordTokenUsage(params.tokenUsage as CodexTokenUsage | undefined);
        break;
      }

      case "account/rateLimits/updated": {
        const event = this.rateLimits.updateRateLimits(params);
        if (event) this.ctx.emitEvent(event);
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
        this.ctx.emitLog("codex-rpc", `${notif.method}: ${JSON.stringify(params).slice(0, 200)}`);
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
        // `item/agentMessage/delta`.
        if (phase !== "completed") return;
        if (item.id && this.streamedAgentItems.has(item.id)) {
          // The deltas already populated accumulatedText / chatMessageGroups,
          // but the orchestrator's `runner.turnSummary = text` overwrites on
          // every event — so the LAST tiny delta (often a single punctuation
          // character like ".") became the turn summary, and therefore the
          // commit message. Re-emit the FULL text marked as the stream
          // completion so the orchestrator can replace turnSummary without
          // double-counting accumulatedText / message groups.
          if (item.text) {
            this.ctx.emitEvent({
              type: "agent_assistant",
              content: [{ type: "text", text: item.text }],
              isStreamCompletion: true,
            });
          }
          return;
        }
        if (item.text) this.emitAssistant([{ type: "text", text: item.text }]);
        return;
      }

      case "contextCompaction": {
        // docs/178 — the app-server compacted the thread's context (manually via
        // our `thread/compact/start`, or on its own when the window filled). Map
        // it to the normalized compaction signals. Codex carries no manual/auto
        // field, so label by correlation (`compactionRequested`); token figures
        // come from the adjacent `thread/tokenUsage/updated` snapshot (`last`
        // = real context occupancy).
        const trigger: "manual" | "auto" = this.compactionRequested ? "manual" : "auto";
        if (phase === "started") {
          this.compactionPreTokens = this.rateLimits.lastTokenUsage?.last?.totalTokens;
          this.ctx.emitEvent({ type: "agent_compaction_started", trigger });
        } else {
          const post = this.rateLimits.lastTokenUsage?.last?.totalTokens;
          const event: AgentEvent = { type: "agent_compacted", trigger };
          if (typeof this.compactionPreTokens === "number") event.preTokens = this.compactionPreTokens;
          if (typeof post === "number") event.postTokens = post;
          this.ctx.emitEvent(event);
          // In compact-spawn mode there is no `turn/start`, so nothing else will
          // end the run. Close it here: emit a synthetic success result and tear
          // down. Guard so a stray `turn/completed` can't double-emit.
          if (this.compactSpawnMode && !this.compactionTerminated) {
            this.compactionTerminated = true;
            this.ctx.emitEvent({
              type: "agent_result",
              status: "success",
              sessionId: this.threadId ?? "unknown",
              durationMs: Date.now() - this.turnStartTime,
            });
            this.ctx.kill();
          }
        }
        return;
      }

      case "commandExecution": {
        if (phase === "started") {
          this.emitToolUseOnce(id, "shell", { command: unwrapShellCommand(item.command ?? ""), cwd: item.cwd });
        } else {
          this.emitToolUseOnce(id, "shell", { command: unwrapShellCommand(item.command ?? ""), cwd: item.cwd });
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
        // completed item; surface it as a tool call so the edit renders as a
        // diff (one block per file), matching how Claude's Edit/Write render.
        if (phase !== "completed") return;
        const changes = (item.changes ?? []).map((c) => {
          const kind = fileChangeKindLabel(c.kind);
          return {
            path: c.path,
            kind,
            diff: normalizeFileChangeDiff(c, kind) ?? this.synthesizeAddedFileDiff(c.path, kind),
          };
        });
        this.emitAssistant([
          {
            type: "tool_use",
            id,
            name: "apply_patch",
            // `files` kept for back-compat; `changes` carries per-file diffs.
            input: { files: changes.map((c) => c.path), changes },
          },
        ]);
        this.emittedToolUseIds.add(id);
        const summary = changes.map((c) => `${c.kind} ${c.path}`).join("\n");
        this.emitToolResult(id, summary || "applied");
        return;
      }

      case "mcpToolCall":
      case "dynamicToolCall": {
        // docs/147 — the ShipIt-managed `shipit` bridge's ask tool surfaces its
        // AskUserQuestion card directly through the worker (the bridge POSTs to
        // `/agent-ops/ask/submit`, which injects a synthetic `AskUserQuestion`
        // tool_use), NOT through this event stream. The Codex app-server emits
        // an `mcpToolCall` item only on `item/completed` — after the tool
        // returns — but a well-formed question blocks and never returns, so
        // relying on this path would never render the card (it would only time
        // out). Ignore the ask tool entirely in both phases: emitting a
        // tool_use here would duplicate the bridge's card, and emitting a
        // tool_result would flip it to "answered" and disable the options.
        if (isAskUserQuestionTool(item.tool)) return;
        let input: Record<string, unknown> = {};
        if (item.arguments) {
          try {
            input = JSON.parse(item.arguments) as Record<string, unknown>;
          } catch {
            input = { raw: item.arguments };
          }
        }
        if (phase === "started") {
          this.emitToolUseOnce(id, item.tool ?? "tool", input);
        } else {
          this.emitToolUseOnce(id, item.tool ?? "tool", input);
          const payload = item.result ?? item.error ?? "";
          this.emitToolResult(id, typeof payload === "string" ? payload : JSON.stringify(payload));
        }
        break;
      }

      case "webSearch": {
        const normalized = normalizeWebSearchItem(item);
        if (phase === "started") {
          this.emitToolUseOnce(id, normalized.name, normalized.input);
        } else {
          this.emitToolUseOnce(id, normalized.name, normalized.input);
          const payload = item.result ?? item.error;
          this.emitToolResult(
            id,
            typeof payload === "string" && payload.length > 0
              ? payload
              : normalized.summary,
          );
        }
        break;
      }

      case "collabToolCall": {
        // docs/125 — subagent orchestration (`spawn_agent`, `send_input`,
        // `wait`, `close_agent`, …). Surface it as a tool call so the review
        // subagent's lifecycle is visible in chat, mirroring how Claude's
        // `Task` tool renders. The actual review write-back still arrives via
        // the `submit_review` MCP tool, mapped above.
        if (phase === "started") {
          if (item.tool === "spawn_agent") {
            this.emitToolUseOnce(id, "Agent", {
              agent: item.receiverThreadId ?? item.newThreadId,
              subagent_type: "Codex",
              description: summarizeCodexSubagentPrompt(item.prompt),
              prompt: item.prompt,
            });
            return;
          }
          this.emitToolUseOnce(id, item.tool ?? "collab", { agent: item.receiverThreadId ?? item.newThreadId, prompt: item.prompt });
        } else {
          if (item.tool === "spawn_agent") {
            this.emitToolUseOnce(id, "Agent", {
              agent: item.receiverThreadId ?? item.newThreadId,
              subagent_type: "Codex",
              description: summarizeCodexSubagentPrompt(item.prompt),
              prompt: item.prompt,
            });
          } else {
            this.emitToolUseOnce(id, item.tool ?? "collab", { agent: item.receiverThreadId ?? item.newThreadId, prompt: item.prompt });
          }
          this.emitToolResult(id, item.agentStatus ?? item.status ?? "done");
        }
        break;
      }

      // userMessage (echo of our own prompt), reasoning, plan, imageView, etc.
      // have no ShipIt mapping — ignore them.
      default:
        break;
    }
  }

  /**
   * Some Codex app-server builds omit the top-level `diff` for add/write
   * changes. The file is already on disk when `item/completed` arrives, so for
   * adds we can reconstruct the same all-`+` diff shape Claude-style write
   * blocks need for line counts and the clickable diff affordance.
   */
  private synthesizeAddedFileDiff(filePath: string, kind: string): string | undefined {
    if (kind !== "add") return undefined;
    try {
      const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(this.cwd, filePath);
      const stat = statSync(absolutePath);
      if (!stat.isFile()) return undefined;
      const content = readFileSync(absolutePath, "utf8");
      const diff = contentToAddedDiff(content);
      return diff || undefined;
    } catch {
      return undefined;
    }
  }

  /** Emit an assistant event with the given content blocks. */
  private emitAssistant(content: AgentContentBlock[]): void {
    this.ctx.emitEvent({ type: "agent_assistant", content });
  }

  /** Emit one tool_use block for a Codex item id, synthesizing starts as needed. */
  private emitToolUseOnce(id: string, name: string, input: Record<string, unknown>): void {
    if (this.emittedToolUseIds.has(id)) return;
    this.emittedToolUseIds.add(id);
    this.emitAssistant([{ type: "tool_use", id, name, input }]);
  }

  /** Emit a tool-result event for the given tool_use id. */
  private emitToolResult(toolUseId: string, content: string): void {
    this.ctx.emitEvent({
      type: "agent_tool_result",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
    });
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
    // docs/178 — a compact-spawn run already ended the turn from the
    // `contextCompaction` `item/completed` (there was no `turn/start`, so this
    // would be a spurious/duplicate completion). Skip to avoid a double
    // `agent_result`.
    if (this.compactionTerminated) return;
    // v2 nests status under `turn`; older shape had a top-level `status`.
    const turn = params.turn as { status?: string } | undefined;
    const status = turn?.status ?? (params.status as string) ?? "completed";
    const usage = this.rateLimits.lastTokenUsage;
    const durationMs = Date.now() - this.turnStartTime;

    this.ctx.emitEvent({
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
    });

    // Turn is over — no active turn to steer until the next one starts.
    this.currentTurnId = null;

    // Kill the app-server process after the turn completes
    // (matching the one-shot-per-turn pattern of ClaudeAdapter)
    this.ctx.kill();
  }

  // ---- Initialization and turn lifecycle ----

  /**
   * Perform the JSON-RPC initialization handshake, create/resume a thread,
   * and start a turn with the user's prompt.
   */
  async initializeAndRun(params: AgentRunParams): Promise<void> {
    // Step 1: Initialize handshake
    await this.ctx.sendRequest("initialize", {
      clientInfo: {
        name: "shipit",
        title: "ShipIt IDE",
        version: "1.0.0",
      },
    });
    this.ctx.sendNotification("initialized");
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
    // Claude (which gets the same text via `--append-system-prompt`).
    const threadBase: Record<string, unknown> = {};
    if (params.systemPrompt) {
      threadBase.developerInstructions = params.systemPrompt;
    }

    let threadResult: unknown;
    if (params.sessionId) {
      // Resume existing thread
      try {
        threadResult = await this.ctx.sendRequest("thread/resume", {
          ...threadBase,
          threadId: params.sessionId,
        });
      } catch {
        // If resume fails, start a new thread
        threadResult = await this.ctx.sendRequest("thread/start", { ...threadBase });
      }
    } else {
      threadResult = await this.ctx.sendRequest("thread/start", { ...threadBase });
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
    this.ctx.emitEvent({
      type: "agent_init",
      agentId: "codex",
      sessionId: this.threadId ?? `codex-${Date.now()}`,
      model: params.model ?? "gpt-5.5",
      tools: this.toolNames,
    });

    // docs/178 — compact-spawn run: the orchestrator intercepted `/compact`
    // with no live app-server to call `compact()` on, so we spawned this
    // process purely to compact. Issue `thread/compact/start` on the resumed
    // thread instead of a normal `turn/start`; the `contextCompaction` items
    // drive the normalized signals, and the `item/completed` ends the run (see
    // handleItem). No `turn/start` means no `turn/completed`, which is why the
    // compaction-completed path synthesizes the `agent_result`.
    if (params.compact) {
      this.compactionRequested = true;
      this.compactSpawnMode = true;
      // The app-server replies with `contextCompaction` `item/started` /
      // `item/completed`, which handleItem maps to the normalized signals — so
      // we don't emit the started event here (that would double it).
      await this.ctx.sendRequest("thread/compact/start", { threadId: this.threadId });
      return;
    }

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

    // Step 4: Start the turn (this triggers streaming notifications).
    // TurnStartResponse carries the turn id — capture it as a fallback in
    // case the `turn/started` event is missed, so live steering always has
    // an `expectedTurnId` to send.
    const turnResult = await this.ctx.sendRequest("turn/start", turnParams);
    const turnData = turnResult as { turnId?: string; turn?: { id?: string } } | undefined;
    this.currentTurnId = turnData?.turn?.id ?? turnData?.turnId ?? this.currentTurnId;
  }
}
