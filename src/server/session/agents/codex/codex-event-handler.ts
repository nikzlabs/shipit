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

interface JsonRpcServerRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcServerNotification {
  method: string;
  params?: Record<string, unknown>;
}

// Codex can request routine approvals under "never"; prompt only for explicit extra access.
function requiresUserApproval(params: Record<string, unknown>): boolean {
  if (typeof params.reason === "string" && params.reason.trim()) return true;
  if (typeof params.grantRoot === "string" && params.grantRoot.trim()) return true;
  if (params.networkApprovalContext !== null && params.networkApprovalContext !== undefined) return true;
  if (params.additionalPermissions !== null && params.additionalPermissions !== undefined) return true;

  return [params.proposedExecpolicyAmendment, params.proposedNetworkPolicyAmendments]
    .some((value) => Array.isArray(value) && value.length > 0);
}

// Separate budgets keep a long summary from hiding the file and line in details.
const CONFIG_WARNING_SUMMARY_CHARS = 400;
const CONFIG_WARNING_DETAILS_CHARS = 200;

export function formatCodexConfigWarning(params: Record<string, unknown>): string | null {
  const flatten = (value: unknown, budget: number): string | null => {
    if (typeof value !== "string") return null;
    const text = value.replace(/\s+/g, " ").trim();
    if (text === "") return null;
    return text.length > budget ? `${text.slice(0, budget).trimEnd()}…` : text;
  };

  const parts = [
    flatten(params.summary, CONFIG_WARNING_SUMMARY_CHARS),
    flatten(params.details, CONFIG_WARNING_DETAILS_CHARS),
  ].filter((part): part is string => part !== null);

  if (parts.length === 0) return null;
  return `Codex configuration: ${parts.join(" — ")}`;
}

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

  private currentTurnId: string | null = null;

  private streamedAgentItems = new Set<string>();

  // Some tools emit only completion; synthesize starts without duplicating existing cards.
  private emittedToolUseIds = new Set<string>();

  private childThreadParents = new Map<string, string>();

  private completedSubagentReports = new Set<string>();
  private openSubagentSpawns = new Set<string>();
  private latestSubagentMessages = new Map<string, string>();

  // Codex supplies no manual/auto flag; correlate with our request.
  private compactionRequested = false;

  private compactSpawnMode = false;
  private compactionTerminated = false;

  private compactionPreTokens: number | undefined;

  private requestPermission: PermissionRequester | null = null;

  getThreadId(): string | null {
    return this.threadId;
  }

  getCurrentTurnId(): string | null {
    return this.currentTurnId;
  }

  setPermissionRequester(requester: PermissionRequester): void {
    this.requestPermission = requester;
  }

  markCompactionRequested(): void {
    this.compactionRequested = true;
  }

  beginTurn(cwd: string): void {
    this.turnStartTime = Date.now();
    this.cwd = cwd;
    this.emittedToolUseIds.clear();
    this.childThreadParents.clear();
    this.completedSubagentReports.clear();
    this.openSubagentSpawns.clear();
    this.latestSubagentMessages.clear();
  }

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
        // Unanswered server requests stall the turn; return an explicit protocol error.
        this.ctx.emitLog("codex-rpc", `unhandled server request: ${req.method}`);
        this.ctx.sendErrorResponse(req.id, -32601, `Method not handled by ShipIt: ${req.method}`);
      }
    }
  }

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

  handleNotification(notif: JsonRpcServerNotification): void {
    const params = notif.params ?? {};

    switch (notif.method) {
      case "thread/started": {
        const thread = params.thread as { id?: string } | undefined;
        // Child threads share this connection; never replace a known parent ID.
        this.threadId ??= thread?.id ?? (params.threadId as string) ?? null;
        break;
      }

      case "turn/started": {
        if (!this.isParentThread(params)) break;
        const turn = params.turn as { id?: string } | undefined;
        this.currentTurnId = turn?.id ?? (params.turnId as string) ?? this.currentTurnId;
        break;
      }

      case "thread/status/changed": {
        const status = params.status as { activeFlags?: string[] } | undefined;
        const flags = status?.activeFlags?.join(",") ?? "";
        this.ctx.emitLog("codex-rpc", `thread/status/changed: ${flags || "active"}`);
        break;
      }

      case "configWarning": {
        const text = formatCodexConfigWarning(params);
        if (text) this.ctx.emitLog("server", text);
        break;
      }

      case "thread/tokenUsage/updated": {
        if (!this.isParentThread(params)) break;
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
        this.handleMessageDelta(params, this.parentToolUseIdFor(params));
        break;
      }

      case "turn/completed": {
        // A child completion must not terminate the parent turn.
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
        this.ctx.emitLog("codex-rpc", `${notif.method}: ${JSON.stringify(params).slice(0, 200)}`);
        break;
      }
    }
  }

  private handleItem(
    params: Record<string, unknown>,
    phase: "started" | "completed",
    parentToolUseId?: string,
  ): void {
    const item = (params.item ?? params) as CodexItem;
    const id = item.id ?? `codex-${Date.now()}`;

    switch (item.type) {
      case "agentMessage": {
        if (phase !== "completed") return;
        if (item.id && this.streamedAgentItems.has(item.id)) {
          // Replace the turn summary with full text without duplicating streamed transcript text.
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
          // Compact-only runs need a synthetic result; guard against a later turn/completed.
          if (this.compactSpawnMode && !this.compactionTerminated) {
            this.compactionTerminated = true;
            const compactUsage = this.rateLimits.turnTokenUsage(this.currentTurnId);
            this.ctx.emitEvent({
              type: "agent_result",
              status: "success",
              sessionId: this.threadId ?? "unknown",
              durationMs: Date.now() - this.turnStartTime,
              tokens: codexTurnTokens(compactUsage?.usage.total, compactUsage?.baselineTotal),
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
        // The worker emits ask cards directly; these events would duplicate or disable them.
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
          // Spawn completion means accepted; wait for the child's final message to complete its card.
          if (item.tool !== "spawnAgent" && item.tool !== "spawn_agent") {
            this.emitToolResult(id, item.agentStatus ?? item.status ?? "done");
          }
          this.captureCollabAgentResults(item);
        }
        break;
      }

      case "subAgentActivity": {
        // CLI 0.146.0 reports subAgentActivity instead of the schema's spawnAgent collab item.
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

      default:
        break;
    }
  }

  // Some builds omit add diffs; the completed file is already available on disk.
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

  private emitAssistant(content: AgentContentBlock[], parentToolUseId?: string): void {
    this.ctx.emitEvent({ type: "agent_assistant", content, parentToolUseId });
  }

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

  private emitToolResult(toolUseId: string, content: string, parentToolUseId?: string, isError = false): void {
    const block: Record<string, unknown> = { type: "tool_result", tool_use_id: toolUseId, content };
    if (isError) block.is_error = true;
    this.ctx.emitEvent({
      type: "agent_tool_result",
      content: [block],
      ...(parentToolUseId ? { parentToolUseId } : {}),
    });
  }

  private handleMessageDelta(params: Record<string, unknown>, parentToolUseId?: string): void {
    const delta = params.delta;
    if (typeof delta !== "string" || delta.length === 0) return;
    const itemId = params.itemId as string | undefined;
    if (itemId) this.streamedAgentItems.add(itemId);
    this.emitAssistant([{ type: "text", text: delta }], parentToolUseId);
  }

  private parentToolUseIdFor(params: Record<string, unknown>): string | undefined {
    const thread = params.thread as { id?: string } | undefined;
    const threadId = (params.threadId as string | undefined) ?? thread?.id;
    return threadId ? this.childThreadParents.get(threadId) : undefined;
  }

  private isParentThread(params: Record<string, unknown>): boolean {
    const notificationThreadId = params.threadId as string | undefined;
    return !notificationThreadId || !this.threadId || notificationThreadId === this.threadId;
  }

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

  private handleTurnCompleted(params: Record<string, unknown>): void {
    if (this.compactionTerminated) return;
    const turn = params.turn as { id?: string; status?: string } | undefined;
    const status = turn?.status ?? (params.status as string) ?? "completed";
    const completedTurnId = turn?.id ?? (params.turnId as string | undefined) ?? this.currentTurnId;
    const turnUsage = this.rateLimits.turnTokenUsage(completedTurnId);
    const durationMs = Date.now() - this.turnStartTime;

    this.ctx.emitEvent({
      type: "agent_result",
      status: status === "completed" ? "success" : "error",
      sessionId: this.threadId ?? "unknown",
      tokens: codexTurnTokens(turnUsage?.usage.total, turnUsage?.baselineTotal),
      contextTokens: turnUsage?.usage.last?.totalTokens,
      contextWindow: this.rateLimits.lastTokenUsage?.modelContextWindow,
      durationMs,
      error: status !== "completed" ? `Turn ended with status: ${status}` : undefined,
    });

    this.currentTurnId = null;

    this.ctx.kill();
  }

  async initializeAndRun(params: AgentRunParams): Promise<void> {
    await this.ctx.sendRequest("initialize", {
      clientInfo: {
        name: "shipit",
        title: "ShipIt IDE",
        version: "1.0.0",
      },
    });
    this.ctx.sendNotification("initialized");
    this.initialized = true;

    // developerInstructions appends ShipIt's instructions without replacing Codex's base instructions.
    const threadBase: Record<string, unknown> = {};
    if (params.systemPrompt) {
      threadBase.developerInstructions = params.systemPrompt;
    }

    let threadResult: unknown;
    if (params.sessionId) {
      // Never fall back to a new thread on resume failure: that would discard the conversation.
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
      // Persist the rollout explicitly so the next process can resume this thread.
      threadResult = await this.ctx.sendRequest("thread/start", {
        ...threadBase,
        ephemeral: false,
      });
    }

    const threadData = threadResult as { thread?: { id?: string }; threadId?: string } | undefined;
    const resolvedThreadId = threadData?.thread?.id ?? threadData?.threadId;
    if (resolvedThreadId) {
      this.threadId = resolvedThreadId;
    }

    // Retirement is service-specific and resolved by the orchestrator; forward model IDs unchanged.
    const model = params.model ?? "gpt-5.6-sol";

    this.ctx.emitEvent({
      type: "agent_init",
      agentId: "codex",
      sessionId: this.threadId ?? `codex-${Date.now()}`,
      model,
      tools: this.toolNames,
    });

    if (params.compact) {
      this.compactionRequested = true;
      this.compactSpawnMode = true;
      await this.ctx.sendRequest("thread/compact/start", { threadId: this.threadId });
      return;
    }

    const turnParams: Record<string, unknown> = {
      threadId: this.threadId,
      input: [{ type: "text", text: params.prompt }],
      // The session container is the sandbox; nested bubblewrap cannot create its namespace.
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    };

    if (params.cwd) {
      turnParams.cwd = params.cwd;
    }

    turnParams.model = model;

    // Capture the response ID too, in case turn/started was missed before a steer.
    const turnResult = await this.ctx.sendRequest("turn/start", turnParams);
    const turnData = turnResult as { turnId?: string; turn?: { id?: string } } | undefined;
    this.currentTurnId = turnData?.turn?.id ?? turnData?.turnId ?? this.currentTurnId;
  }
}
