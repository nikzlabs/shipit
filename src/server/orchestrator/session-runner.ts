/**
 * SessionRunnerInterface — shared contract for session runner implementations.
 *
 * SessionRunnerRegistry — app-level registry of active session runners.
 * One runner per session. Manages lifecycle (create, get, dispose) and
 * enforces resource limits.
 */

import { EventEmitter } from "node:events";
import type { AgentProcess, AgentId, TerminalProcess } from "../shared/types.js";
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
  private _idleTimer: ReturnType<typeof setTimeout> | null = null;
  private _idleTimeoutMs: number;
  private _disposed = false;

  constructor(opts: {
    sessionId: string;
    sessionDir: string;
    defaultAgentId: AgentId;
    idleTimeoutMs?: number;
  }) {
    super();
    this.sessionId = opts.sessionId;
    this.sessionDir = opts.sessionDir;
    this._agentId = opts.defaultAgentId;
    this._idleTimeoutMs = opts.idleTimeoutMs ?? 10 * 60 * 1000;
    this.resetIdleTimer();
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
    return { type: "preview_status", running: false, port: 5173, url: "http://localhost:5173" };
  }
  get previewStatusKnown(): boolean { return true; }

  onAgentFinished(): void {
    if (!this._isRunning && this._messageQueue.length === 0) {
      this.resetIdleTimer();
      this.emit("idle");
    }
  }

  private resetIdleTimer(): void {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => {
      if (!this._isRunning && this._messageQueue.length === 0 && this._viewerCount === 0) {
        this.dispose();
      }
    }, this._idleTimeoutMs);
  }

  get disposed(): boolean { return this._disposed; }
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    if (this.agent) { this.agent.kill(); this.agent = null; }
    if (this._terminal) { this._terminal.kill(); this._terminal = null; }
    this.clearPushTimer();
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
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
  idleTimeoutMs: number;
  /** Absolute path to the shared repo backing this worktree session (container mount). */
  sharedRepoDir?: string;
}) => SessionRunnerInterface;

export class SessionRunnerRegistry {
  private runners = new Map<string, SessionRunnerInterface>();
  private _maxConcurrentRunners: number;
  private _defaultIdleTimeoutMs: number;
  private _runnerFactory: SessionRunnerFactory;
  private _sharedRepoDirResolver?: (sessionId: string) => string | undefined;

  constructor(opts?: {
    maxConcurrentRunners?: number;
    defaultIdleTimeoutMs?: number;
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
  }) {
    this._maxConcurrentRunners = opts?.maxConcurrentRunners ?? 10;
    this._defaultIdleTimeoutMs = opts?.defaultIdleTimeoutMs ?? 10 * 60 * 1000;
    this._runnerFactory = opts?.runnerFactory ?? ((o) => new SessionRunner(o));
    this._sharedRepoDirResolver = opts?.sharedRepoDirResolver;
  }

  /** Get or create a runner for the given session. */
  getOrCreate(sessionId: string, sessionDir: string, defaultAgentId: AgentId): SessionRunnerInterface {
    let runner = this.runners.get(sessionId);
    if (runner && !runner.disposed) {
      return runner;
    }

    // Enforce concurrent runner limit — evict oldest idle runner if at capacity
    if (this.runners.size >= this._maxConcurrentRunners) {
      let evicted = false;
      for (const [id, r] of this.runners) {
        if (!r.running && r.viewerCount === 0) {
          r.dispose();
          this.runners.delete(id);
          evicted = true;
          break;
        }
      }
      if (!evicted && this.runners.size >= this._maxConcurrentRunners) {
        // All runners are active — can't create a new one
        throw new Error("Maximum concurrent session runners reached");
      }
    }

    runner = this._runnerFactory({
      sessionId,
      sessionDir,
      defaultAgentId,
      idleTimeoutMs: this._defaultIdleTimeoutMs,
      sharedRepoDir: this._sharedRepoDirResolver?.(sessionId),
    });
    runner.on("disposed", () => this.runners.delete(sessionId));
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
