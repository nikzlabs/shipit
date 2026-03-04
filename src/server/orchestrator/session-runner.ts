/**
 * SessionRunnerInterface — shared contract for session runner implementations.
 *
 * SessionRunnerRegistry — app-level registry of active session runners.
 * One runner per session. Manages lifecycle (create, get, dispose) and
 * enforces resource limits.
 */

import { EventEmitter } from "node:events";
import type { AgentProcess, AgentId, AgentEvent, TerminalProcess, AgentRunParams } from "../shared/types.js";
import type { WsServerMessage, ImageAttachment, FileContextRef, PermissionMode, ClaudeContentBlockToolUse } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueuedMessage {
  text: string;
  images?: ImageAttachment[];
  files?: FileContextRef[];
  permissionMode?: PermissionMode;
}

/**
 * Dependencies for server-initiated (system) turns. Injected once after the
 * runner is created. Without these, sendSystemMessage() falls back to enqueue.
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
  accumulatedText: string;
  accumulatedToolUse: ClaudeContentBlockToolUse[];
  turnSummary: string;
  chatMessageGroups: Array<{ text: string; toolUse: ClaudeContentBlockToolUse[] }>;
  needsNewMessageGroup: boolean;
  agentId: AgentId;

  getAgent(): AgentProcess | null;
  setAgent(a: AgentProcess | null): void;

  // Message queue
  readonly messageQueue: QueuedMessage[];
  readonly queueLength: number;
  enqueue(msg: QueuedMessage): number;
  dequeue(): QueuedMessage | undefined;
  clearQueue(): void;
  getQueueSnapshot(): Array<{ text: string; position: number }>;

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

  // Detected ports (per-session)
  detectedPorts: number[];

  // Remote terminal support (container mode)
  readonly supportsRemoteTerminal?: boolean;

  // Agent factory (container mode — returns a proxy that delegates to the worker)
  createAgent?(agentId: AgentId): AgentProcess;

  // Viewer management
  readonly viewerCount: number;
  getPreview(): null;
  getFileWatcher(): null;
  attachViewer(): void;
  detachViewer(): void;
  buildPreviewStatus(): WsServerMessage;
  /** True once the runner has definitive preview state (e.g. SSE connected to worker).
   *  When false, callers should not send buildPreviewStatus() to clients — let the
   *  runner emit the status itself when ready. */
  readonly previewStatusKnown: boolean;
  /** Wait until preview state is known (SSE connected + worker reported). Resolves
   *  immediately if already known. */
  waitForPreviewStatus(): Promise<void>;

  // System-initiated turns
  /** Inject dependencies needed for server-initiated agent turns. */
  setSystemTurnDeps(deps: SystemTurnDeps): void;
  /** Start a server-initiated agent turn (e.g., CI auto-fix).
   *  If running, enqueues. If idle and deps are set, starts a turn directly.
   *  Falls back to enqueue if deps aren't configured. */
  sendSystemMessage(text: string): void;

  // Lifecycle
  onAgentFinished(): void;
  readonly disposed: boolean;
  dispose(): void;
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
  private _accumulatedText = "";
  private _accumulatedToolUse: ClaudeContentBlockToolUse[] = [];
  private _turnSummary = "";
  private _chatMessageGroups: Array<{ text: string; toolUse: ClaudeContentBlockToolUse[] }> = [];
  private _needsNewMessageGroup = true;
  private _messageQueue: QueuedMessage[] = [];
  private _terminal: TerminalProcess | null = null;
  private _terminalOutputBuffer = "";
  private static readonly MAX_TERMINAL_BUFFER = 10_000;
  private _pushTimer: ReturnType<typeof setTimeout> | null = null;
  private _turnEventBuffer: WsServerMessage[] = [];
  private static readonly MAX_TURN_BUFFER = 1000;
  private static readonly MAX_QUEUE_SIZE = 50;
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
  get accumulatedText(): string { return this._accumulatedText; }
  set accumulatedText(s: string) { this._accumulatedText = s; }
  get accumulatedToolUse(): ClaudeContentBlockToolUse[] { return this._accumulatedToolUse; }
  set accumulatedToolUse(blocks: ClaudeContentBlockToolUse[]) { this._accumulatedToolUse = blocks; }
  get turnSummary(): string { return this._turnSummary; }
  set turnSummary(s: string) { this._turnSummary = s; }
  get chatMessageGroups(): Array<{ text: string; toolUse: ClaudeContentBlockToolUse[] }> { return this._chatMessageGroups; }
  set chatMessageGroups(groups: Array<{ text: string; toolUse: ClaudeContentBlockToolUse[] }>) { this._chatMessageGroups = groups; }
  get needsNewMessageGroup(): boolean { return this._needsNewMessageGroup; }
  set needsNewMessageGroup(v: boolean) { this._needsNewMessageGroup = v; }
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
  getQueueSnapshot(): Array<{ text: string; position: number }> {
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
  clearTurnEventBuffer(): void { this._turnEventBuffer = []; }
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
  getPreview(): null { return null; }
  getFileWatcher(): null { return null; }
  attachViewer(): void { this._viewerCount++; }
  detachViewer(): void { this._viewerCount = Math.max(0, this._viewerCount - 1); }
  buildPreviewStatus(): WsServerMessage {
    return { type: "preview_status", running: false, port: 5173, url: "http://localhost:5173", sessionId: this.sessionId };
  }
  get previewStatusKnown(): boolean { return true; }
  async waitForPreviewStatus(): Promise<void> { /* always known */ }

  private _systemTurnDeps: SystemTurnDeps | null = null;

  setSystemTurnDeps(deps: SystemTurnDeps): void {
    this._systemTurnDeps = deps;
  }

  sendSystemMessage(text: string): void {
    if (this._isRunning) {
      this.enqueue({ text });
      return;
    }
    if (!this._systemTurnDeps) {
      // No deps — fall back to enqueue (will drain on next WS-initiated turn)
      this.enqueue({ text });
      return;
    }
    this._runSystemTurn(text);
  }

  /**
   * Start an agent turn directly on the runner, without WS context.
   * Handles event forwarding, auto-commit, auto-push, and queue drain.
   */
  private _runSystemTurn(text: string): void {
    const deps = this._systemTurnDeps!;
    const agent = deps.agentFactory(this._agentId);
    this.setAgent(agent);
    this._isRunning = true;
    this._accumulatedText = "";
    this._turnSummary = "";
    this._needsNewMessageGroup = true;
    this.clearTurnEventBuffer();

    deps.sseBroadcast("session_agent_started", { sessionId: this.sessionId });

    // Forward agent events to viewers
    agent.on("event", (event: AgentEvent) => {
      this.emitMessage({ type: "agent_event", event });

      if (event.type === "agent_assistant") {
        const contentArr = (event as { content?: Array<{ type: string; text?: string }> }).content ?? [];
        const text = contentArr
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("");
        if (text) {
          this._turnSummary = text;
          this._accumulatedText += text;
        }
      }
    });

    agent.on("error", (err: Error) => {
      console.error("[system-turn] agent error:", err.message);
      this.emitMessage({ type: "error", message: `Agent process error: ${err.message}` });
      this.setAgent(null);
    });

    agent.on("done", async (code: number | null) => {
      console.log("[system-turn] agent exited with code", code);
      this.setAgent(null);

      // Auto-commit
      try {
        const summary = this._turnSummary.split("\n")[0]?.slice(0, 120) || "CI fix";
        const hash = await deps.autoCommit(this.sessionDir, summary);
        if (hash) {
          this.emitMessage({ type: "git_committed", hash, message: summary });
          deps.scheduleAutoPush(this.sessionDir);
        }
      } catch (err) {
        console.error("[system-turn] auto-commit failed:", err);
      }

      // Queue drain
      this._isRunning = false;
      if (this._messageQueue.length > 0) {
        const next = this.dequeue();
        if (next) {
          this.emitMessage({
            type: "queue_updated",
            queue: this._messageQueue.map((item, idx) => ({ text: item.text, position: idx + 1 })),
          });
          this._runSystemTurn(next.text);
          return;
        }
      }

      deps.sseBroadcast("session_agent_finished", { sessionId: this.sessionId });
      this.onAgentFinished();
    });

    // Get agent session ID from session manager if available
    agent.run({
      prompt: text,
      cwd: this.sessionDir,
    } as AgentRunParams);
  }

  onAgentFinished(): void {
    if (!this._isRunning && this._messageQueue.length === 0) {
      this.emit("idle");
    }
  }

  get disposed(): boolean { return this._disposed; }
  dispose(): void {
    if (this._disposed) return;
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
  /** Absolute path to the shared repo backing this worktree session (container mount). */
  sharedRepoDir?: string;
}) => SessionRunnerInterface;

export class SessionRunnerRegistry {
  private runners = new Map<string, SessionRunnerInterface>();
  private _runnerFactory: SessionRunnerFactory;
  private _sharedRepoDirResolver?: (sessionId: string) => string | undefined;
  private _onRunnerIdle?: (sessionId: string) => void;
  private _onRunnerCreated?: (runner: SessionRunnerInterface) => void;

  constructor(opts?: {
    /**
     * Runner factory. Defaults to creating in-process SessionRunner instances
     * (used in tests). Production overrides with ContainerSessionRunner factory.
     */
    runnerFactory?: SessionRunnerFactory;
    /**
     * Optional resolver that returns the shared repo directory for a session.
     * Used in container mode to mount the parent git repo for worktree sessions.
     */
    sharedRepoDirResolver?: (sessionId: string) => string | undefined;
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
    this._sharedRepoDirResolver = opts?.sharedRepoDirResolver;
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
      sharedRepoDir: this._sharedRepoDirResolver?.(sessionId),
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

  /** Dispose a specific runner. */
  dispose(sessionId: string): void {
    this.runners.get(sessionId)?.dispose();
  }

  /** Dispose all runners (for full_reset / shutdown). */
  disposeAll(): void {
    for (const runner of this.runners.values()) {
      runner.dispose();
    }
    this.runners.clear();
  }

  /** Number of active runners. */
  get size(): number { return this.runners.size; }
}
