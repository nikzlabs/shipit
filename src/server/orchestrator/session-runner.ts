/**
 * SessionRunnerInterface — shared contract for session runner implementations.
 *
 * SessionRunnerRegistry — app-level registry of active session runners.
 * One runner per session. Manages lifecycle (create, get, dispose) and
 * enforces resource limits.
 */

import { EventEmitter } from "node:events";
import type { AgentProcess, AgentId, AgentEvent, TerminalProcess, AgentRunParams } from "../shared/types.js";
import type { WsServerMessage, ImageAttachment, FileContextRef, UploadRef, PermissionMode, ClaudeContentBlockToolUse, SkillInfo } from "../shared/types.js";
import type { ServiceManager } from "./service-manager.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolResultEntry {
  toolUseId: string;
  content: string;
  isError?: boolean;
}

/**
 * A single event emitted by a subagent (Claude's Task tool). Preserves the
 * parent-child link so the client can render subagent activity as a nested
 * tree under the parent Task call rather than flattening it into the main
 * conversation. (109 — subagent transparency)
 */
export type SubagentEvent =
  | {
      kind: "assistant";
      parentToolUseId: string;
      text: string;
      toolUse: ClaudeContentBlockToolUse[];
    }
  | {
      kind: "tool_result";
      parentToolUseId: string;
      toolResults: ToolResultEntry[];
    };

export interface ChatMessageGroup {
  text: string;
  toolUse: ClaudeContentBlockToolUse[];
  toolResults?: ToolResultEntry[];
  /**
   * Events emitted by subagents whose parent Task tool lives in this group's
   * `toolUse`. Stored as a flat ordered list; the client groups them by
   * parentToolUseId for rendering.
   */
  subagentEvents?: SubagentEvent[];
}

/**
 * A user message injected mid-turn via live steering (docs/140). Unlike the
 * turn-opening user message (persisted once via `append`), a steered message
 * lands *between* assistant message groups. `afterGroupIndex` records how many
 * persistable assistant groups existed when the steer arrived, so the message
 * can be re-interleaved at its true position every time `replaceInProgress`
 * rebuilds the in-progress set. Without this anchor the steered row keeps its
 * early id while assistant rows are deleted+reinserted at higher ids, and on
 * reload the steer collapses up next to the turn's first user message.
 */
export interface SteeredMessage {
  afterGroupIndex: number;
  text: string;
}

export interface QueuedMessage {
  text: string;
  /** Spinner label shown in the chat bubble (e.g. "Creating PR…"). Carried through queue drain. */
  activity?: string;
  images?: ImageAttachment[];
  files?: FileContextRef[];
  uploads?: UploadRef[];
  permissionMode?: PermissionMode;
  /** docs/125 — set when a chat-native review message is queued behind a running turn. */
  reviewFilePath?: string;
}

/**
 * Options accepted by `runner.dispatch(...)` and `runDispatchedTurn(...)`. The
 * runner's send-or-queue entry point for a *new turn*: enqueued behind a
 * running turn or started directly when idle. Carries every field a queued
 * message can carry so the drain doesn't lose attachments, permission mode,
 * or the review allow-list (docs/150).
 */
export interface AgentDispatchOptions {
  text: string;
  /** Spinner label shown in the chat bubble (e.g. "Creating PR…", "Auto-fixing CI…"). */
  activity?: string;
  /** Optional inline image attachments (already validated by the caller). */
  images?: ImageAttachment[];
  /** File context references resolved against the session workspace. */
  files?: FileContextRef[];
  /** Upload refs (resolved to ImageAttachment[] / FileAttachment[] before the agent runs). */
  uploads?: UploadRef[];
  /** Per-turn permission mode override. */
  permissionMode?: PermissionMode;
  /** docs/125 — chat-native review turn marker. */
  reviewFilePath?: string;
}

/**
 * Convert an AgentDispatchOptions payload into a QueuedMessage. Both shapes
 * carry the same per-turn fields; this helper exists so `dispatch`'s enqueue
 * branch doesn't open-code the field-by-field copy (and silently miss new
 * fields the next time the shape grows).
 */
export function toQueuedMessage(opts: AgentDispatchOptions): QueuedMessage {
  const queued: QueuedMessage = { text: opts.text };
  if (opts.activity !== undefined) queued.activity = opts.activity;
  if (opts.images !== undefined) queued.images = opts.images;
  if (opts.files !== undefined) queued.files = opts.files;
  if (opts.uploads !== undefined) queued.uploads = opts.uploads;
  if (opts.permissionMode !== undefined) queued.permissionMode = opts.permissionMode;
  if (opts.reviewFilePath !== undefined) queued.reviewFilePath = opts.reviewFilePath;
  return queued;
}

/**
 * Dependencies for server-initiated (system) turns. Injected once after the
 * runner is created. Without these, dispatch() falls back to enqueue.
 */
export interface SystemTurnDeps {
  /** Create an AgentProcess for the given agent ID. */
  agentFactory: (agentId: AgentId) => AgentProcess;
  /** Auto-commit working tree changes. Returns commit hash or null. */
  autoCommit: (sessionDir: string, summary: string) => Promise<string | null>;
  /** Schedule a debounced auto-push after a commit. */
  scheduleAutoPush: (sessionDir: string) => void;
  /** Broadcast to SSE clients. */
  sseBroadcast: (event: string, data: unknown) => void;
  /** Persist a chat message to history. */
  persistMessage: (sessionId: string, msg: { role: "user" | "assistant"; text: string }) => void;
  /** Replace in-progress messages in chat history (incremental persistence). */
  replaceInProgress?: (sessionId: string, messages: { role: "assistant"; text: string; inProgress: true }[]) => void;
  /** Finalize in-progress messages (remove the flag) after turn completion. */
  finalizeInProgress?: (sessionId: string) => void;
  /** Clear in-progress messages on error/abort. */
  clearInProgress?: (sessionId: string) => void;
  /**
   * docs/149 — build the full `AgentRunParams` for this turn (system prompt,
   * model, settings, MCP, autoCreatePr, permissionMode, resume id). Without
   * this, system turns used to run with only `{ prompt, sessionId, cwd }` and
   * inherited none of the user-path agent configuration.
   */
  buildRunParams: (sessionId: string, agentId: AgentId, prompt: string) => Promise<AgentRunParams>;
  /**
   * docs/149 — emit the PR lifecycle card after a system-turn commit lands.
   * Mirrors the WS handler's post-turn flow. Optional so tests can omit it.
   */
  postTurnPrFlow?: (
    sessionId: string,
    sessionDir: string,
    commitHash: string,
    emit: (msg: WsServerMessage) => void,
  ) => Promise<void>;
  /**
   * docs/149 — write a CLI-rotated OAuth token back to the orchestrator source
   * after a system turn. Optional; production wires it to
   * `finalizeSessionAgentEnvironment` so the agent-spawned and CI-auto-fix
   * paths participate in the same rotating-token discipline as the WS path.
   */
  finalizeAgentEnv?: (sessionId: string, agentId: AgentId) => void;
}

/**
 * Minimal host interface for the shared runDispatchedTurn() free function.
 * Both SessionRunner and ContainerSessionRunner satisfy this contract.
 */
export interface SystemTurnHost {
  readonly sessionId: string;
  readonly sessionDir: string;
  running: boolean;
  accumulatedText: string;
  turnSummary: string;
  needsNewMessageGroup: boolean;
  clearTurnEventBuffer(): void;
  emitMessage(msg: WsServerMessage): void;
  setAgent(a: AgentProcess | null): void;
  dequeue(): QueuedMessage | undefined;
  readonly queueLength: number;
  getQueueSnapshot(): { text: string; position: number }[];
  onAgentFinished(): void;
}

/**
 * Shared implementation for dispatched agent turns (docs/150). Used by both
 * SessionRunner and ContainerSessionRunner to avoid code duplication.
 *
 * docs/149 — async because run-params assembly is async (reads system prompt,
 * MCP config, etc). Callers fire-and-forget via `void this._runDispatchedTurn(...)`
 * — `dispatch` still returns `void`.
 */
export async function runDispatchedTurn(
  host: SystemTurnHost,
  deps: SystemTurnDeps,
  agentId: AgentId,
  opts: AgentDispatchOptions,
  createAgent: (agentId: AgentId) => AgentProcess,
): Promise<void> {
  const { text, activity } = opts;
  const agent = createAgent(agentId);
  host.running = true;
  host.accumulatedText = "";
  host.turnSummary = "";
  host.needsNewMessageGroup = true;
  host.clearTurnEventBuffer();

  host.emitMessage({ type: "system_user_message", text, activity });
  deps.persistMessage(host.sessionId, { role: "user", text });
  deps.sseBroadcast("session_agent_started", { sessionId: host.sessionId, activity });

  agent.on("event", (event: AgentEvent) => {
    host.emitMessage({ type: "agent_event", event });

    if (event.type === "agent_assistant") {
      const contentArr = (event as { content?: { type: string; text?: string }[] }).content ?? [];
      const agentText = contentArr
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("\n\n");
      if (agentText) {
        host.turnSummary = agentText;
        host.accumulatedText += agentText;
      }
    }

    if (event.type === "agent_tool_result" && host.accumulatedText) {
      deps.replaceInProgress?.(host.sessionId, [
        { role: "assistant", text: host.accumulatedText, inProgress: true },
      ]);
    }

    if (event.type === "agent_result" && host.accumulatedText) {
      deps.replaceInProgress?.(host.sessionId, [
        { role: "assistant", text: host.accumulatedText, inProgress: true },
      ]);
      deps.finalizeInProgress?.(host.sessionId);
    }
  });

  agent.on("error", (err: Error) => {
    console.error("[system-turn] agent error:", err.message);
    host.emitMessage({ type: "error", message: `Agent process error: ${err.message}` });
    deps.clearInProgress?.(host.sessionId);
    host.setAgent(null);
  });

  agent.on("done", async (code: number | null) => {
    console.log("[system-turn] agent exited with code", code);
    host.setAgent(null);

    // docs/149 — write back any CLI-rotated OAuth token before doing further
    // post-turn work. Matches the WS-path `syncTokenBackAfterTurn` behavior.
    deps.finalizeAgentEnv?.(host.sessionId, agentId);

    let commitHash: string | null = null;
    try {
      // docs/150 — fallback chain: prefer the assistant-derived summary (the
      // first line of the agent's text output), then the dispatch's activity
      // label, then a generic "agent turn" so the commit message is always
      // meaningful instead of the legacy literal "CI fix".
      const summary =
        host.turnSummary.split("\n")[0]?.slice(0, 120) || activity || "agent turn";
      commitHash = await deps.autoCommit(host.sessionDir, summary);
      if (commitHash) {
        host.emitMessage({ type: "git_committed", hash: commitHash, message: summary });
        deps.scheduleAutoPush(host.sessionDir);
      }
    } catch (err) {
      console.error("[system-turn] auto-commit failed:", err);
    }

    // docs/149 — emit PR lifecycle card after the commit lands, same as the
    // WS path. Optional dep; tests can leave it unwired.
    if (commitHash) {
      try {
        await deps.postTurnPrFlow?.(host.sessionId, host.sessionDir, commitHash, (m) => host.emitMessage(m));
      } catch (err) {
        console.error("[system-turn] pr-lifecycle flow failed:", err);
      }
    }

    host.running = false;
    if (host.queueLength > 0) {
      const next = host.dequeue();
      if (next) {
        host.emitMessage({ type: "queue_updated", queue: host.getQueueSnapshot() });
        // docs/150 — thread every QueuedMessage field through, not just `text`.
        // The previous implementation silently dropped images / files / uploads /
        // permissionMode / reviewFilePath / activity from a queued message at drain time.
        const nextOpts: AgentDispatchOptions = { text: next.text };
        if (next.activity !== undefined) nextOpts.activity = next.activity;
        if (next.images !== undefined) nextOpts.images = next.images;
        if (next.files !== undefined) nextOpts.files = next.files;
        if (next.uploads !== undefined) nextOpts.uploads = next.uploads;
        if (next.permissionMode !== undefined) nextOpts.permissionMode = next.permissionMode;
        if (next.reviewFilePath !== undefined) nextOpts.reviewFilePath = next.reviewFilePath;
        void runDispatchedTurn(host, deps, agentId, nextOpts, createAgent);
        return;
      }
    }

    deps.sseBroadcast("session_agent_finished", { sessionId: host.sessionId });
    host.onAgentFinished();
  });

  const runParams = await deps.buildRunParams(host.sessionId, agentId, text);
  agent.run(runParams);
}

// ---------------------------------------------------------------------------
// SessionRunnerInterface — shared contract for direct and container runners
// ---------------------------------------------------------------------------

/**
 * Event map for SessionRunner implementations. Used with typed EventEmitter.
 */
export interface SessionRunnerEvents {
  message: [WsServerMessage];
  idle: [];
  disposed: [];
}

/**
 * Shared interface that both SessionRunner (direct process spawning) and
 * ContainerSessionRunner (Docker-proxied) implement. All external consumers
 * (HandlerContext, SessionRunnerRegistry, WebSocket handlers) program against
 * this interface rather than a concrete class.
 */
export interface SessionRunnerInterface extends EventEmitter<SessionRunnerEvents> {
  readonly sessionId: string;
  readonly sessionDir: string;

  // Agent state
  running: boolean;
  wasInterrupted: boolean;
  /**
   * Volatile per-runner flag (docs/138): set true once a turn requested guarded
   * mode but the CLI reported it unavailable (plan/admin/model constraint).
   * Subsequent turns read this and silently downgrade `guarded` → `auto` so the
   * user isn't repeatedly told it's unavailable. NOT persisted to SessionManager
   * and NOT in the warm-pool snapshot — it clears on session/container restart
   * and on page reload (the client re-reads static capability), so an admin
   * later enabling auto mode is rediscovered on the next fresh attempt.
   */
  guardedUnavailable: boolean;
  /**
   * docs/125 — per-turn allow-list for the chat-native review tool. Set to the
   * authorized file path when a `send_review_message` turn starts; the
   * `submit_review_comments` tool handler rejects any call whose `file_path`
   * doesn't match. Cleared when the turn ends (and overwritten by the next
   * turn — a normal `send_message` sets it back to null). Lives on the runner
   * (not the WS connection) and is mutated via the registry-resolved runner so
   * a reconnect mid-review doesn't clear it.
   */
  activeReviewFilePath: string | null;
  accumulatedText: string;
  accumulatedToolUse: ClaudeContentBlockToolUse[];
  turnSummary: string;
  chatMessageGroups: ChatMessageGroup[];
  needsNewMessageGroup: boolean;
  steeredMessages: SteeredMessage[];
  agentId: AgentId;

  getAgent(): AgentProcess | null;
  setAgent(a: AgentProcess | null): void;

  // Message queue
  readonly messageQueue: QueuedMessage[];
  readonly queueLength: number;
  enqueue(msg: QueuedMessage): number;
  dequeue(): QueuedMessage | undefined;
  clearQueue(): void;
  getQueueSnapshot(): { text: string; position: number }[];

  // Terminal
  getTerminal(): TerminalProcess | null;
  setTerminal(t: TerminalProcess | null): void;
  appendTerminalOutput(data: string): void;
  getTerminalOutputBuffer(): string;
  clearTerminalOutputBuffer(): void;

  // Auto-push timer
  getPushTimer(): ReturnType<typeof setTimeout> | null;
  setPushTimer(t: ReturnType<typeof setTimeout> | null): void;
  clearPushTimer(): void;

  // Turn event buffer
  getTurnEventBuffer(): WsServerMessage[];
  clearTurnEventBuffer(): void;
  emitMessage(msg: WsServerMessage): void;
  /** Index into the turn event buffer up to which events have been persisted to chat history.
   *  On viewer attach, only events after this index need to be replayed. */
  lastPersistedBufferIndex: number;

  // Detected ports (per-session)
  detectedPorts: number[];

  // Remote terminal support (container mode)
  readonly supportsRemoteTerminal?: boolean;

  /**
   * Timestamp (Date.now()) of the most recent SSE event from the worker.
   * Container-only — direct runners don't have an SSE stream and may
   * omit this property entirely. Used by the container health endpoint
   * to surface "events stale 47s" when the SSE channel is broken even
   * though the container is otherwise fine.
   */
  readonly lastSseEventAt?: number;

  // Agent factory (container mode — returns a proxy that delegates to the worker)
  createAgent?(agentId: AgentId): AgentProcess;

  /**
   * Fetch Codex's built-in system skills (`~/.codex/skills/**`) from inside the
   * container. Container-only — in-process runners (tests, local mode) omit
   * this, and the skills route falls back to project skills alone. See
   * docs/138-skill-invocation (change #5b).
   */
  getCodexBuiltinSkills?(): Promise<SkillInfo[]>;

  // Viewer management
  readonly viewerCount: number;
  attachViewer(): void;
  detachViewer(): void;
  /**
   * Timestamp (Date.now()) of the most recent viewer detach. Used by the idle
   * enforcer to skip recently-disconnected runners during a grace period —
   * this prevents transient WebSocket disconnects (network blips, page
   * reloads) from triggering container disposal.
   *
   * Returns 0 when no viewer has ever detached. The value is irrelevant when
   * `viewerCount > 0` (an active viewer is attached).
   */
  readonly lastViewerDetachAt: number;
  buildPreviewStatus(): WsServerMessage;
  /** True once the runner has definitive preview state (e.g. SSE connected to worker).
   *  When false, callers should not send buildPreviewStatus() to clients — let the
   *  runner emit the status itself when ready. */
  readonly previewStatusKnown: boolean;
  /** Wait until preview state is known (SSE connected + worker reported). Resolves
   *  immediately if already known. */
  waitForPreviewStatus(): Promise<void>;

  // Compose service management
  /** Attach a ServiceManager for compose lifecycle events. Optional — not all runners have compose. */
  setServiceManager?(mgr: ServiceManager): void;

  // Dispatched turns (docs/150)
  /** Inject dependencies needed for server-initiated agent turns. */
  setSystemTurnDeps(deps: SystemTurnDeps): void;
  /**
   * Dispatch a new agent turn. The runner's send-or-queue entry point —
   * serves both server-internal callers (Fix CI, child-session spawn) and
   * user-clicked buttons routed through the HTTP dispatch endpoint.
   *
   * Behavior:
   *   - If running: enqueues the message (carrying every field, not just text).
   *   - If idle and SystemTurnDeps are set: starts a turn directly.
   *   - If idle and deps are not configured: falls back to enqueue; the next
   *     WS-initiated turn drains it.
   *
   * docs/150 — `dispatch` is the only writer to `runner.running` /
   * `runner.messageQueue` from a turn-start path; WS handlers delegate here
   * rather than reimplementing the queueing rule inline.
   */
  dispatch(opts: AgentDispatchOptions): void;

  // Lifecycle
  onAgentFinished(): void;
  readonly disposed: boolean;
  /**
   * Dispose the runner. By default, this is refused if the agent is currently
   * running — lifecycle events (idle cleanup, transient WebSocket disconnects)
   * must never kill a running agent. Pass `{ force: true }` from a shutdown /
   * full-reset path that explicitly wants to tear down everything.
   */
  dispose(opts?: { force?: boolean }): void;

  /**
   * Reconcile the local `running` flag with the actual agent state.
   *
   * Returns `true` if the agent is genuinely running, `false` otherwise. If
   * `running` is true locally but the agent has actually finished (e.g., the
   * orchestrator missed an `agent_done` SSE event because the connection
   * dropped, or the container was restarted), this method resets the flag and
   * emits a `session_status` recovery message.
   *
   * This is the safety net that prevents users from getting stuck in a state
   * where every new message gets queued but the queue never drains. Call it
   * before consulting `running` in `send_message` / `answer_question` paths.
   */
  verifyRunningState(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// SessionRunner — in-process runner (used by integration tests)
// ---------------------------------------------------------------------------

/**
 * In-process session runner. Used by integration tests where spawning
 * Docker containers is not practical. Production uses ContainerSessionRunner.
 */
export class SessionRunner extends EventEmitter<SessionRunnerEvents> implements SessionRunnerInterface {
  readonly sessionId: string;
  readonly sessionDir: string;

  private agent: AgentProcess | null = null;
  private _agentId: AgentId;
  private _isRunning = false;
  private _wasInterrupted = false;
  private _guardedUnavailable = false;
  private _activeReviewFilePath: string | null = null;
  private _accumulatedText = "";
  private _accumulatedToolUse: ClaudeContentBlockToolUse[] = [];
  private _turnSummary = "";
  private _chatMessageGroups: ChatMessageGroup[] = [];
  private _needsNewMessageGroup = true;
  private _steeredMessages: SteeredMessage[] = [];
  private _messageQueue: QueuedMessage[] = [];
  private _terminal: TerminalProcess | null = null;
  private _terminalOutputBuffer = "";
  private static readonly MAX_TERMINAL_BUFFER = 10_000;
  private _pushTimer: ReturnType<typeof setTimeout> | null = null;
  private _turnEventBuffer: WsServerMessage[] = [];
  private static readonly MAX_TURN_BUFFER = 1000;
  private static readonly MAX_QUEUE_SIZE = 50;
  lastPersistedBufferIndex = 0;
  private _viewerCount = 0;
  private _detectedPorts: number[] = [];
  private _disposed = false;

  constructor(opts: {
    sessionId: string;
    sessionDir: string;
    defaultAgentId: AgentId;
  }) {
    super();
    this.sessionId = opts.sessionId;
    this.sessionDir = opts.sessionDir;
    this._agentId = opts.defaultAgentId;
  }

  get running(): boolean { return this._isRunning; }
  set running(v: boolean) { this._isRunning = v; }
  get wasInterrupted(): boolean { return this._wasInterrupted; }
  set wasInterrupted(v: boolean) { this._wasInterrupted = v; }
  get guardedUnavailable(): boolean { return this._guardedUnavailable; }
  set guardedUnavailable(v: boolean) { this._guardedUnavailable = v; }
  get activeReviewFilePath(): string | null { return this._activeReviewFilePath; }
  set activeReviewFilePath(v: string | null) { this._activeReviewFilePath = v; }
  get accumulatedText(): string { return this._accumulatedText; }
  set accumulatedText(s: string) { this._accumulatedText = s; }
  get accumulatedToolUse(): ClaudeContentBlockToolUse[] { return this._accumulatedToolUse; }
  set accumulatedToolUse(blocks: ClaudeContentBlockToolUse[]) { this._accumulatedToolUse = blocks; }
  get turnSummary(): string { return this._turnSummary; }
  set turnSummary(s: string) { this._turnSummary = s; }
  get chatMessageGroups(): ChatMessageGroup[] { return this._chatMessageGroups; }
  set chatMessageGroups(groups: ChatMessageGroup[]) { this._chatMessageGroups = groups; }
  get needsNewMessageGroup(): boolean { return this._needsNewMessageGroup; }
  set needsNewMessageGroup(v: boolean) { this._needsNewMessageGroup = v; }
  get steeredMessages(): SteeredMessage[] { return this._steeredMessages; }
  set steeredMessages(m: SteeredMessage[]) { this._steeredMessages = m; }
  get agentId(): AgentId { return this._agentId; }
  set agentId(id: AgentId) { this._agentId = id; }
  getAgent(): AgentProcess | null { return this.agent; }
  setAgent(a: AgentProcess | null): void { this.agent = a; }

  get messageQueue(): QueuedMessage[] { return this._messageQueue; }
  get queueLength(): number { return this._messageQueue.length; }
  enqueue(msg: QueuedMessage): number {
    if (this._messageQueue.length >= SessionRunner.MAX_QUEUE_SIZE) {
      throw new Error(`Message queue is full (max ${SessionRunner.MAX_QUEUE_SIZE})`);
    }
    this._messageQueue.push(msg);
    return this._messageQueue.length;
  }
  dequeue(): QueuedMessage | undefined { return this._messageQueue.shift(); }
  clearQueue(): void { this._messageQueue.length = 0; }
  getQueueSnapshot(): { text: string; position: number }[] {
    return this._messageQueue.map((item, idx) => ({ text: item.text, position: idx + 1 }));
  }

  getTerminal(): TerminalProcess | null { return this._terminal; }
  setTerminal(t: TerminalProcess | null): void { this._terminal = t; }
  appendTerminalOutput(data: string): void {
    this._terminalOutputBuffer += data;
    if (this._terminalOutputBuffer.length > SessionRunner.MAX_TERMINAL_BUFFER) {
      this._terminalOutputBuffer = this._terminalOutputBuffer.slice(-SessionRunner.MAX_TERMINAL_BUFFER);
    }
  }
  getTerminalOutputBuffer(): string { return this._terminalOutputBuffer; }
  clearTerminalOutputBuffer(): void { this._terminalOutputBuffer = ""; }

  getPushTimer(): ReturnType<typeof setTimeout> | null { return this._pushTimer; }
  setPushTimer(t: ReturnType<typeof setTimeout> | null): void { this._pushTimer = t; }
  clearPushTimer(): void {
    if (this._pushTimer) { clearTimeout(this._pushTimer); this._pushTimer = null; }
  }

  getTurnEventBuffer(): WsServerMessage[] { return [...this._turnEventBuffer]; }
  clearTurnEventBuffer(): void { this._turnEventBuffer = []; this.lastPersistedBufferIndex = 0; }
  emitMessage(msg: WsServerMessage): void {
    if (this._turnEventBuffer.length < SessionRunner.MAX_TURN_BUFFER) {
      this._turnEventBuffer.push(msg);
    } else if (this._turnEventBuffer.length === SessionRunner.MAX_TURN_BUFFER) {
      // Evict: keep first 10 (init/model_info) + most recent, then append
      const keep = 10;
      const recent = this._turnEventBuffer.length - keep;
      this._turnEventBuffer = [
        ...this._turnEventBuffer.slice(0, keep),
        ...this._turnEventBuffer.slice(recent),
        msg,
      ];
    }
    this.emit("message", msg);
  }

  get detectedPorts(): number[] { return this._detectedPorts; }
  set detectedPorts(ports: number[]) { this._detectedPorts = ports; }
  get viewerCount(): number { return this._viewerCount; }
  private _lastViewerDetachAt = 0;
  get lastViewerDetachAt(): number { return this._lastViewerDetachAt; }
  attachViewer(): void {
    this._viewerCount++;
    // Clear the detach timestamp on any attach — a viewer is back, and the
    // grace period only matters when no viewers are attached. If viewers
    // come and go later, the timestamp will be re-armed only when the LAST
    // one detaches (see detachViewer() below).
    this._lastViewerDetachAt = 0;
  }
  detachViewer(): void {
    this._viewerCount = Math.max(0, this._viewerCount - 1);
    // Arm the grace-period timer ONLY when the last viewer detaches AND it's
    // not already armed. Two safety properties:
    //   1. Multi-viewer: detaching one of several viewers does not start the
    //      grace period — the runner is still actively viewed.
    //   2. Defensive: a stray double-detach (e.g. test or buggy caller) when
    //      count is already 0 doesn't reset an existing timer, so the grace
    //      period can't be extended by repeated detach calls.
    if (this._viewerCount === 0 && this._lastViewerDetachAt === 0) {
      this._lastViewerDetachAt = Date.now();
    }
  }
  buildPreviewStatus(): WsServerMessage {
    return { type: "preview_status", running: false, port: 5173, url: "http://localhost:5173", sessionId: this.sessionId };
  }
  readonly previewStatusKnown: boolean = true;
  async waitForPreviewStatus(): Promise<void> { /* always known */ }

  private _systemTurnDeps: SystemTurnDeps | null = null;

  setSystemTurnDeps(deps: SystemTurnDeps): void {
    this._systemTurnDeps = deps;
  }

  dispatch(opts: AgentDispatchOptions): void {
    if (this._isRunning) {
      // docs/150 — enqueue branch broadcasts message_queued via emitMessage
      // so every attached viewer (and any other HTTP-originated caller in
      // this session) sees the update. Previously the WS handler did this
      // emit on a single socket.
      const position = this.enqueue(toQueuedMessage(opts));
      this.emitMessage({ type: "message_queued", text: opts.text, position });
      return;
    }
    if (!this._systemTurnDeps) {
      // No deps — fall back to enqueue (will drain on next WS-initiated turn).
      const position = this.enqueue(toQueuedMessage(opts));
      this.emitMessage({ type: "message_queued", text: opts.text, position });
      return;
    }
    void this._runDispatchedTurn(opts);
  }

  private async _runDispatchedTurn(opts: AgentDispatchOptions): Promise<void> {
    const deps = this._systemTurnDeps!;
    await runDispatchedTurn(this, deps, this._agentId, opts, (agentId) => {
      const agent = deps.agentFactory(agentId);
      this.setAgent(agent);
      return agent;
    });
  }

  onAgentFinished(): void {
    if (!this._isRunning && this._messageQueue.length === 0) {
      this.emit("idle");
    }
  }

  /**
   * In-process: events from the agent are delivered synchronously by the
   * EventEmitter, so the local `_isRunning` flag is always in sync with the
   * agent's true state. There is no out-of-band channel that could miss
   * events. Just return the local flag.
   */
  async verifyRunningState(): Promise<boolean> {
    return this._isRunning;
  }

  get disposed(): boolean { return this._disposed; }
  dispose(opts?: { force?: boolean }): void {
    if (this._disposed) return;
    // Defensive: refuse to dispose a runner whose agent is currently running
    // unless the caller explicitly opts in (e.g., shutdown). This guarantees
    // that lifecycle events (idle cleanup, transient disconnects) never kill
    // a running agent. Callers that need unconditional teardown (shutdown)
    // pass `{ force: true }`.
    if (this._isRunning && !opts?.force) {
      console.log(`[session-runner:${this.sessionId}] dispose() skipped — agent is running`);
      return;
    }
    this._disposed = true;
    if (this.agent) { this.agent.kill(); this.agent = null; }
    if (this._terminal) { this._terminal.kill(); this._terminal = null; }
    this.clearPushTimer();
    this._messageQueue.length = 0;
    this._turnEventBuffer = [];
    this._isRunning = false;
    this.emit("disposed");
    this.removeAllListeners();
  }
}

// ---------------------------------------------------------------------------
// SessionRunnerRegistry
// ---------------------------------------------------------------------------

/**
 * App-level registry of active session runners. One runner per session.
 * Manages lifecycle (create, get, dispose) and enforces resource limits.
 */
export type SessionRunnerFactory = (opts: {
  sessionId: string;
  sessionDir: string;
  defaultAgentId: AgentId;
  /** Absolute path to the per-repo dependency cache directory (container mount). */
  depCacheDir?: string;
}) => SessionRunnerInterface;

export class SessionRunnerRegistry {
  private runners = new Map<string, SessionRunnerInterface>();
  private _runnerFactory: SessionRunnerFactory;
  private _depCacheDirResolver?: (sessionId: string) => string | undefined;
  private _onRunnerIdle?: (sessionId: string) => void;
  private _onRunnerCreated?: (runner: SessionRunnerInterface) => void;

  constructor(opts?: {
    /**
     * Runner factory. Defaults to creating in-process SessionRunner instances
     * (used in tests). Production overrides with ContainerSessionRunner factory.
     */
    runnerFactory?: SessionRunnerFactory;
    /**
     * Optional resolver that returns the per-repo dependency cache directory.
     * Mounted into containers so npm/yarn/pnpm share cached downloads.
     */
    depCacheDirResolver?: (sessionId: string) => string | undefined;
    /**
     * Called when a runner transitions to idle (agent finished, queue empty).
     * Used by the orchestrator to enforce idle container limits.
     */
    onRunnerIdle?: (sessionId: string) => void;
    /**
     * Called after a runner is created. Used to inject SystemTurnDeps so
     * server-initiated turns (e.g., CI auto-fix) work without WS context.
     */
    onRunnerCreated?: (runner: SessionRunnerInterface) => void;
  }) {
    this._runnerFactory = opts?.runnerFactory ?? ((o) => new SessionRunner(o));
    this._depCacheDirResolver = opts?.depCacheDirResolver;
    this._onRunnerIdle = opts?.onRunnerIdle;
    this._onRunnerCreated = opts?.onRunnerCreated;
  }

  /** Get or create a runner for the given session. */
  getOrCreate(sessionId: string, sessionDir: string, defaultAgentId: AgentId): SessionRunnerInterface {
    let runner = this.runners.get(sessionId);
    if (runner && !runner.disposed) {
      return runner;
    }

    runner = this._runnerFactory({
      sessionId,
      sessionDir,
      defaultAgentId,
      depCacheDir: this._depCacheDirResolver?.(sessionId),
    });
    runner.on("disposed", () => this.runners.delete(sessionId));
    if (this._onRunnerIdle) {
      const cb = this._onRunnerIdle;
      runner.on("idle", () => cb(sessionId));
    }
    this._onRunnerCreated?.(runner);
    this.runners.set(sessionId, runner);
    return runner;
  }

  /** Get existing runner (if any). */
  get(sessionId: string): SessionRunnerInterface | undefined {
    const runner = this.runners.get(sessionId);
    if (runner?.disposed) {
      this.runners.delete(sessionId);
      return undefined;
    }
    return runner;
  }

  /** List all sessions with active (running) agents. */
  listActive(): string[] {
    return [...this.runners.entries()]
      .filter(([, r]) => r.running && !r.disposed)
      .map(([id]) => id);
  }

  /**
   * Dispose a specific runner. Refuses to dispose if the agent is running
   * (the underlying runner enforces this). Pass `{ force: true }` only from
   * shutdown / full-reset paths that explicitly need unconditional teardown.
   */
  dispose(sessionId: string, opts?: { force?: boolean }): void {
    this.runners.get(sessionId)?.dispose(opts);
  }

  /** Dispose all runners (for full_reset / shutdown). Forced — kills running agents. */
  disposeAll(): void {
    for (const runner of this.runners.values()) {
      runner.dispose({ force: true });
    }
    this.runners.clear();
  }

  /** Number of active runners. */
  get size(): number { return this.runners.size; }

  /**
   * Iterate over all session IDs with a registered runner. Used by the
   * missing-container reconciler to detect runners whose container has
   * vanished (Docker daemon restart, external `docker rm`, missed die
   * event during the health-monitor reconnect window).
   */
  ids(): string[] { return [...this.runners.keys()]; }
}
