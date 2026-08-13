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
import { codexTurnTokens } from "../../../shared/codex-token-usage.js";
import {
  buildCodexPermissionInput,
  contentToAddedDiff,
  fileChangeKindLabel,
  isAskUserQuestionTool,
  normalizeMcpToolName,
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
 * Native approval requests are not, by themselves, evidence that an action is
 * sensitive: Codex may emit them for routine work even with approvalPolicy
 * "never". The v1/v2 schemas reserve these fields for requests that need extra
 * filesystem, network, or execution-policy access, so only those requests need
 * a user decision inside ShipIt's already-isolated worker container.
 */
function requiresUserApproval(params: Record<string, unknown>): boolean {
  if (typeof params.reason === "string" && params.reason.trim()) return true;
  if (typeof params.grantRoot === "string" && params.grantRoot.trim()) return true;
  if (params.networkApprovalContext !== null && params.networkApprovalContext !== undefined) return true;
  if (params.additionalPermissions !== null && params.additionalPermissions !== undefined) return true;

  return [params.proposedExecpolicyAmendment, params.proposedNetworkPolicyAmendments]
    .some((value) => Array.isArray(value) && value.length > 0);
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
   * Codex app-server streams child-thread items on the same connection as the
   * parent turn. Relate each child thread to the `spawn_agent` item that made
   * it so those events use ShipIt's existing nested-subagent transcript path.
   */
  private childThreadParents = new Map<string, string>();

  /** Spawn calls for which the child has already produced its final answer. */
  private completedSubagentReports = new Set<string>();
  private openSubagentSpawns = new Set<string>();
  private latestSubagentMessages = new Map<string, string>();

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
    this.childThreadParents.clear();
    this.completedSubagentReports.clear();
    this.openSubagentSpawns.clear();
    this.latestSubagentMessages.clear();
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
   * docs/193 — approval methods are also emitted for ordinary commands and
   * workspace changes despite ShipIt's `approvalPolicy: "never"`. Auto-accept
   * those routine requests; only requests whose payload explicitly describes
   * extra access are routed through the shared `PermissionBroker`. When no requester is wired
   * (tests / the broker is unavailable) OR the broker path throws, fall back to
   * the historical auto-accept so a turn can never hang waiting on a human who
   * isn't being asked.
   *
   * Decision enums come from the generated v2 schema (`codex app-server
   * generate-json-schema`, confirmed planning#114): v2 CommandExecution/FileChange
   * ApprovalDecision allow is `"accept"`; deny is `"decline"` (deny + continue
   * the turn) — NOT `"reject"`, which the schema does not define (the only other
   * deny variant, `"cancel"`, denies AND interrupts the turn, which is not our
   * semantics). The legacy v1 ReviewDecision is `"approved"`/`"denied"`.
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
    const reject = protocol === "v2" ? "decline" : "denied";

    if (!this.requestPermission || !requiresUserApproval(req.params ?? {})) {
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
        // The response to thread/start or thread/resume already establishes
        // the parent id. Child agents also announce thread/started on this
        // connection, so never replace a known parent resume key here.
        this.threadId ??= thread?.id ?? (params.threadId as string) ?? null;
        break;
      }

      case "turn/started": {
        // Turn has begun — capture its id so live steering can pass it as
        // `expectedTurnId` on `turn/steer`. The v2 shape nests it under
        // `turn.id`; accept a top-level `turnId` defensively.
        if (!this.isParentThread(params)) break;
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
        if (!this.isParentThread(params)) break;
        // planning#367 — the `turnId` is what separates this turn's rollup from
        // the one `thread/resume` replays from the previous turn. See
        // `CodexRateLimits.recordTokenUsage`.
        this.rateLimits.recordTokenUsage(
          params.tokenUsage as CodexTokenUsage | undefined,
          params.turnId as string | undefined,
        );
        break;
      }

      case "account/rateLimits/updated": {
        const event = this.rateLimits.updateRateLimits(params);
        if (event) this.ctx.emitEvent(event);
        break;
      }

      case "item/started": {
        this.handleItem(params, "started", this.parentToolUseIdFor(params));
        break;
      }

      case "item/completed": {
        this.handleItem(params, "completed", this.parentToolUseIdFor(params));
        break;
      }

      case "item/agentMessage/delta": {
        // Incremental text delta for streaming
        this.handleMessageDelta(params, this.parentToolUseIdFor(params));
        break;
      }

      case "turn/completed": {
        // Child turns finish on the parent's app-server stream too. Their
        // terminal state belongs to the spawn card; it must not terminate the
        // parent ShipIt turn.
        const parentToolUseId = this.parentToolUseIdFor(params);
        if (parentToolUseId) {
          if (!this.completedSubagentReports.has(parentToolUseId)) {
            const turn = params.turn as { status?: string } | undefined;
            const status = turn?.status ?? (params.status as string) ?? "completed";
            const answer = this.latestSubagentMessages.get(parentToolUseId);
            this.emitSubagentReport(parentToolUseId, answer ?? (
              status === "completed"
                ? "Subagent completed without a final response."
                : `Subagent ended with status: ${status}`
            ), status !== "completed");
          }
          break;
        }
        this.finishUnclosedSubagents();
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
  private handleItem(
    params: Record<string, unknown>,
    phase: "started" | "completed",
    parentToolUseId?: string,
  ): void {
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
            if (parentToolUseId) {
              this.latestSubagentMessages.set(parentToolUseId, item.text);
            } else {
              this.ctx.emitEvent({
                type: "agent_assistant",
                content: [{ type: "text", text: item.text }],
                isStreamCompletion: true,
              });
            }
          }
          return;
        }
        if (item.text) {
          this.emitAssistant([{ type: "text", text: item.text }], parentToolUseId);
          if (parentToolUseId) this.latestSubagentMessages.set(parentToolUseId, item.text);
        }
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
            // planning#367 — a compact-only run makes a model request of its own
            // and raises the thread's rollup (measured: 1000 → 2000 against
            // codex-cli 0.146.0), and the app-server gives it a `turn/started`
            // with its own id like any other turn. Before the per-turn
            // subtraction those tokens were swept up — wrongly, along with
            // everything else — by the next turn's cumulative total; now the
            // next turn's baseline excludes them, so a result without them
            // would drop them for good.
            const compactUsage = this.rateLimits.turnTokenUsage(this.currentTurnId);
            this.ctx.emitEvent({
              type: "agent_result",
              status: "success",
              sessionId: this.threadId ?? "unknown",
              durationMs: Date.now() - this.turnStartTime,
              tokens: codexTurnTokens(compactUsage?.usage.total, compactUsage?.baselineTotal),
              // The post-compaction occupancy — the whole point of the run.
              contextTokens: compactUsage?.usage.last?.totalTokens,
              contextWindow: this.rateLimits.lastTokenUsage?.modelContextWindow,
            });
            this.ctx.kill();
          }
        }
        return;
      }

      case "commandExecution": {
        if (phase === "started") {
          this.emitToolUseOnce(id, "shell", { command: unwrapShellCommand(item.command ?? ""), cwd: item.cwd }, parentToolUseId);
        } else {
          this.emitToolUseOnce(id, "shell", { command: unwrapShellCommand(item.command ?? ""), cwd: item.cwd }, parentToolUseId);
          const out = item.aggregatedOutput ?? "";
          const exit = item.exitCode;
          const content =
            exit !== null && exit !== undefined && exit !== 0 ? `${out}\n[exit code: ${exit}]` : out;
          this.emitToolResult(id, content, parentToolUseId);
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
        ], parentToolUseId);
        this.emittedToolUseIds.add(id);
        const summary = changes.map((c) => `${c.kind} ${c.path}`).join("\n");
        this.emitToolResult(id, summary || "applied", parentToolUseId);
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
        const toolName = item.type === "mcpToolCall"
          ? normalizeMcpToolName(item.server, item.tool)
          : item.tool ?? "tool";
        if (phase === "started") {
          this.emitToolUseOnce(id, toolName, input, parentToolUseId);
        } else {
          this.emitToolUseOnce(id, toolName, input, parentToolUseId);
          const payload = item.result ?? item.error ?? "";
          this.emitToolResult(id, typeof payload === "string" ? payload : JSON.stringify(payload), parentToolUseId);
        }
        break;
      }

      case "webSearch": {
        const normalized = normalizeWebSearchItem(item);
        if (phase === "started") {
          this.emitToolUseOnce(id, normalized.name, normalized.input, parentToolUseId);
        } else {
          this.emitToolUseOnce(id, normalized.name, normalized.input, parentToolUseId);
          const payload = item.result ?? item.error;
          this.emitToolResult(
            id,
            typeof payload === "string" && payload.length > 0
              ? payload
              : normalized.summary,
            parentToolUseId,
          );
        }
        break;
      }

      case "collabAgentToolCall":
      case "collabToolCall": {
        // docs/125 — subagent orchestration (`spawn_agent`, `send_input`,
        // `wait`, `close_agent`, …). Surface it as a tool call so the review
        // subagent's lifecycle is visible in chat, mirroring how Claude's
        // `Task` tool renders. The review output is the subagent's final text,
        // which the parent surfaces in chat (docs/220) — no write-back tool.
        if (phase === "started") {
          if (item.tool === "spawnAgent" || item.tool === "spawn_agent") {
            const childThreadIds = item.receiverThreadIds ?? [item.receiverThreadId ?? item.newThreadId].filter((v): v is string => !!v);
            for (const childThreadId of childThreadIds) this.childThreadParents.set(childThreadId, id);
            this.openSubagentSpawns.add(id);
            this.emitToolUseOnce(id, "Agent", {
              agent: childThreadIds[0],
              subagent_type: "Codex",
              description: summarizeCodexSubagentPrompt(item.prompt),
              prompt: item.prompt,
            });
            return;
          }
          this.emitToolUseOnce(id, item.tool ?? "collab", { agent: item.receiverThreadId ?? item.newThreadId, prompt: item.prompt });
        } else {
          if (item.tool === "spawnAgent" || item.tool === "spawn_agent") {
            const childThreadIds = item.receiverThreadIds ?? [item.receiverThreadId ?? item.newThreadId].filter((v): v is string => !!v);
            for (const childThreadId of childThreadIds) this.childThreadParents.set(childThreadId, id);
            this.openSubagentSpawns.add(id);
            this.emitToolUseOnce(id, "Agent", {
              agent: childThreadIds[0],
              subagent_type: "Codex",
              description: summarizeCodexSubagentPrompt(item.prompt),
              prompt: item.prompt,
            });
          } else {
            this.emitToolUseOnce(id, item.tool ?? "collab", { agent: item.receiverThreadId ?? item.newThreadId, prompt: item.prompt });
          }
          // `spawn_agent` completes when the child is accepted, not when its
          // work is done. The child's terminal agentMessage/turn supplies the
          // real result later; rendering this status would mark the card done
          // while the child still runs.
          if (item.tool !== "spawnAgent" && item.tool !== "spawn_agent") {
            this.emitToolResult(id, item.agentStatus ?? item.status ?? "done");
          }
          this.captureCollabAgentResults(item);
        }
        break;
      }

      case "subAgentActivity": {
        // Verified against a live 0.146.0 app-server run: a successful
        // `spawn_agent` does NOT emit the schema's `spawnAgent` collab item.
        // Its observable parent-side invocation is `subAgentActivity/started`,
        // followed by the child thread's own item and turn notifications.
        // The activity id is therefore the stable tool-use id for ShipIt's
        // card, and agentThreadId is the correlation key for child progress.
        if (phase !== "started" || !item.agentThreadId || item.kind !== "started") return;
        this.childThreadParents.set(item.agentThreadId, id);
        this.openSubagentSpawns.add(id);
        const agentName = item.agentPath?.split("/").filter(Boolean).at(-1);
        this.emitToolUseOnce(id, "Agent", {
          agent: item.agentThreadId,
          subagent_type: "Codex",
          description: agentName ? `Run ${agentName} subagent` : "Run Codex subagent",
        });
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
  private emitAssistant(content: AgentContentBlock[], parentToolUseId?: string): void {
    this.ctx.emitEvent({ type: "agent_assistant", content, parentToolUseId });
  }

  /** Emit one tool_use block for a Codex item id, synthesizing starts as needed. */
  private emitToolUseOnce(
    id: string,
    name: string,
    input: Record<string, unknown>,
    parentToolUseId?: string,
  ): void {
    if (this.emittedToolUseIds.has(id)) return;
    this.emittedToolUseIds.add(id);
    this.emitAssistant([{ type: "tool_use", id, name, input }], parentToolUseId);
  }

  /** Emit a tool-result event for the given tool_use id. */
  private emitToolResult(toolUseId: string, content: string, parentToolUseId?: string, isError = false): void {
    const block: Record<string, unknown> = { type: "tool_result", tool_use_id: toolUseId, content };
    if (isError) block.is_error = true;
    this.ctx.emitEvent({
      type: "agent_tool_result",
      content: [block],
      ...(parentToolUseId ? { parentToolUseId } : {}),
    });
  }

  /**
   * Handle incremental message deltas (streaming text). The v2 protocol
   * delivers `delta` as a plain string with the item's `itemId`; we record the
   * id so the matching `item/completed` agentMessage isn't re-emitted.
   */
  private handleMessageDelta(params: Record<string, unknown>, parentToolUseId?: string): void {
    const delta = params.delta;
    if (typeof delta !== "string" || delta.length === 0) return;
    const itemId = params.itemId as string | undefined;
    if (itemId) this.streamedAgentItems.add(itemId);
    this.emitAssistant([{ type: "text", text: delta }], parentToolUseId);
  }

  /** Resolve the child thread carried by a v2 notification to its spawn call. */
  private parentToolUseIdFor(params: Record<string, unknown>): string | undefined {
    const thread = params.thread as { id?: string } | undefined;
    const threadId = (params.threadId as string | undefined) ?? thread?.id;
    return threadId ? this.childThreadParents.get(threadId) : undefined;
  }

  private isParentThread(params: Record<string, unknown>): boolean {
    const notificationThreadId = params.threadId as string | undefined;
    return !notificationThreadId || !this.threadId || notificationThreadId === this.threadId;
  }

  /** Put a child's terminal assistant message in the spawn card's report slot. */
  private emitSubagentReport(parentToolUseId: string, text: string, isError = false): void {
    if (this.completedSubagentReports.has(parentToolUseId)) return;
    this.completedSubagentReports.add(parentToolUseId);
    this.openSubagentSpawns.delete(parentToolUseId);
    this.emitToolResult(parentToolUseId, text, undefined, isError);
  }

  private captureCollabAgentResults(item: CodexItem): void {
    for (const [threadId, state] of Object.entries(item.agentsStates ?? {})) {
      const parentId = this.childThreadParents.get(threadId);
      if (!parentId || !state.message || !["completed", "errored", "interrupted", "shutdown"].includes(state.status ?? "")) continue;
      this.emitSubagentReport(parentId, state.message, state.status === "errored");
    }
  }

  private finishUnclosedSubagents(): void {
    for (const parentId of this.openSubagentSpawns) {
      const answer = this.latestSubagentMessages.get(parentId);
      this.emitSubagentReport(parentId, answer ?? "Subagent ended without a final response.");
    }
  }

  /** Handle turn completion — emit agent_result. */
  private handleTurnCompleted(params: Record<string, unknown>): void {
    // docs/178 — a compact-spawn run already ended the turn from the
    // `contextCompaction` `item/completed` (there was no `turn/start`, so this
    // would be a spurious/duplicate completion). Skip to avoid a double
    // `agent_result`.
    if (this.compactionTerminated) return;
    // v2 nests status under `turn`; older shape had a top-level `status`.
    const turn = params.turn as { id?: string; status?: string } | undefined;
    const status = turn?.status ?? (params.status as string) ?? "completed";
    const completedTurnId = turn?.id ?? (params.turnId as string | undefined) ?? this.currentTurnId;
    // planning#367 — the rollup THIS turn produced, or null when the only one
    // held is the previous turn's, replayed by `thread/resume`.
    const turnUsage = this.rateLimits.turnTokenUsage(completedTurnId);
    const durationMs = Date.now() - this.turnStartTime;

    this.ctx.emitEvent({
      type: "agent_result",
      status: status === "completed" ? "success" : "error",
      sessionId: this.threadId ?? "unknown",
      // `total` is the cumulative rollup for the whole THREAD (billing);
      // `last.totalTokens` is the real context-window occupancy (input + cache
      // from the final call), which is per-call and needs no conversion.
      // docs/252 phase 3 — normalized to the DISJOINT convention at the adapter
      // boundary, because Codex's `inputTokens` INCLUDES `cachedInputTokens`
      // and ShipIt's pricing code assumes the classes never overlap. The rule
      // and the measurement behind it are in `shared/codex-token-usage.ts`;
      // planning#341 moved them there once the orchestrator's own `codex exec
      // --json` shell-out became a second reader of the same overlapping
      // figures under different key names, and planning#367 added the
      // cumulative→per-turn subtraction that the "rollup" in the first line
      // has always needed.
      tokens: codexTurnTokens(turnUsage?.usage.total, turnUsage?.baselineTotal),
      contextTokens: turnUsage?.usage.last?.totalTokens,
      // Not turn-scoped — it is the model's window, so the latest snapshot
      // answers for it even on a turn that reported no usage of its own.
      contextWindow: this.rateLimits.lastTokenUsage?.modelContextWindow,
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
      // Resume the existing thread. This MUST fail closed: the persisted
      // `sessionId` is the only link between ShipIt's visible chat history and
      // the context Codex sends to the model. The old fallback caught every
      // resume error and silently called `thread/start`; the follow-up then ran
      // successfully in an empty thread and produced a plausible but
      // contextless answer (most visible when the user referred to "the issue
      // you just fixed"). A missing/corrupt rollout and a transient/protocol
      // rejection are not permission to discard the conversation.
      try {
        threadResult = await this.ctx.sendRequest("thread/resume", {
          ...threadBase,
          threadId: params.sessionId,
        });
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        this.ctx.emitLog("codex", `thread/resume failed for ${params.sessionId}: ${reason}`);
        throw new Error(
          `Couldn't resume the previous Codex conversation (${reason}). ` +
            "The follow-up was not sent in a new, contextless thread.",
          { cause: err },
        );
      }
    } else {
      // ShipIt tears down the app-server after each turn and starts a fresh
      // process for the next message, so the returned thread id is useful only
      // when Codex also materializes its rollout on disk. Do not inherit the
      // app-server's default here: that default has varied across CLI releases
      // and an ephemeral thread still returns a perfectly valid id, which
      // ShipIt then persists before the next `thread/resume` fails with
      // "no rollout found". Pinning this false makes the thread-id persistence
      // contract explicit at the boundary where the thread is created.
      threadResult = await this.ctx.sendRequest("thread/start", {
        ...threadBase,
        ephemeral: false,
      });
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

    // docs/252 phase 8 — this used to re-map a retired model id
    // (`normalizeCodexModelId`). It no longer does, and must not: retirement is
    // declared per `(service, billing mode)` and two services may offer the same
    // model id (req 5), so a boundary holding only an id cannot tell whose
    // retirement applies — it would rewrite a model the session's own service
    // still serves. The orchestrator resolves and persists the successor before
    // the turn is built (`applyModelRetirement`), so what arrives here is
    // already the model the session should run. Forward it verbatim.
    const model = params.model ?? "gpt-5.6-sol";

    // Emit agent_init so the server can track the session
    this.ctx.emitEvent({
      type: "agent_init",
      agentId: "codex",
      sessionId: this.threadId ?? `codex-${Date.now()}`,
      model,
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

    turnParams.model = model;

    // Step 4: Start the turn (this triggers streaming notifications).
    // TurnStartResponse carries the turn id — capture it as a fallback in
    // case the `turn/started` event is missed, so live steering always has
    // an `expectedTurnId` to send.
    const turnResult = await this.ctx.sendRequest("turn/start", turnParams);
    const turnData = turnResult as { turnId?: string; turn?: { id?: string } } | undefined;
    this.currentTurnId = turnData?.turn?.id ?? turnData?.turnId ?? this.currentTurnId;
  }
}
