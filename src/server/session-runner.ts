/**
 * SessionRunner — per-session container for runtime state.
 *
 * Owns the agent process, message queue, accumulated turn data, auto-push
 * timer, and (when viewers are attached) preview/file-watcher. Survives
 * connection drops and session switches.
 *
 * SessionRunnerRegistry — app-level registry of active SessionRunners.
 * One runner per session. Manages lifecycle (create, get, dispose) and
 * enforces resource limits.
 */

import { EventEmitter } from "node:events";
import type { AgentProcess, AgentId } from "./agents/agent-process.js";
import type { WsServerMessage, ImageAttachment, FileContextRef, PermissionMode, ClaudeContentBlockToolUse } from "./types.js";
import type { TerminalProcess } from "./terminal.js";

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
// SessionRunner
// ---------------------------------------------------------------------------

/**
 * Per-session container for runtime state. Owns the agent process,
 * terminal, message queue, and accumulated turn data. Survives
 * connection drops and session switches.
 *
 * Emits:
 * - "message" (WsServerMessage) — any message that should be forwarded to attached viewers
 * - "idle" — agent finished and no queued messages remain
 * - "disposed" — runner has been cleaned up
 */
export class SessionRunner extends EventEmitter {
  readonly sessionId: string;
  readonly sessionDir: string;

  // Agent state
  private agent: AgentProcess | null = null;
  private _agentId: AgentId;
  private _isRunning = false;
  private _wasInterrupted = false;
  private _accumulatedText = "";
  private _accumulatedToolUse: ClaudeContentBlockToolUse[] = [];
  private _turnSummary = "";

  // Message queue
  private _messageQueue: QueuedMessage[] = [];

  // Terminal (Phase 2 — stays per-connection for now)
  private _terminal: TerminalProcess | null = null;

  // Auto-push timer
  private _pushTimer: ReturnType<typeof setTimeout> | null = null;

  // Event buffer — stores messages from the current turn so that
  // a reconnecting client can catch up without re-running the agent.
  private _turnEventBuffer: WsServerMessage[] = [];
  private static readonly MAX_TURN_BUFFER = 1000;

  // Viewer tracking (ref-counted for preview/file-watcher)
  private _viewerCount = 0;

  // Idle cleanup timer
  private _idleTimer: ReturnType<typeof setTimeout> | null = null;
  private _idleTimeoutMs: number;

  private _disposed = false;

  constructor(opts: {
    sessionId: string;
    sessionDir: string;
    defaultAgentId: AgentId;
    idleTimeoutMs?: number; // default: 10 minutes
  }) {
    super();
    this.sessionId = opts.sessionId;
    this.sessionDir = opts.sessionDir;
    this._agentId = opts.defaultAgentId;
    this._idleTimeoutMs = opts.idleTimeoutMs ?? 10 * 60 * 1000;
    this.resetIdleTimer();
  }

  // --- Public API: Agent state ---

  /** Whether the agent is currently processing a message. */
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

  get agentId(): AgentId { return this._agentId; }
  set agentId(id: AgentId) { this._agentId = id; }

  getAgent(): AgentProcess | null { return this.agent; }
  setAgent(a: AgentProcess | null): void { this.agent = a; }

  // --- Public API: Message queue ---

  get messageQueue(): QueuedMessage[] { return this._messageQueue; }

  get queueLength(): number { return this._messageQueue.length; }

  enqueue(msg: QueuedMessage): number {
    this._messageQueue.push(msg);
    return this._messageQueue.length;
  }

  dequeue(): QueuedMessage | undefined {
    return this._messageQueue.shift();
  }

  clearQueue(): void {
    this._messageQueue.length = 0;
  }

  /** Get a snapshot of the queue for UI display. */
  getQueueSnapshot(): Array<{ text: string; position: number }> {
    return this._messageQueue.map((item, idx) => ({ text: item.text, position: idx + 1 }));
  }

  // --- Public API: Terminal ---

  getTerminal(): TerminalProcess | null { return this._terminal; }
  setTerminal(t: TerminalProcess | null): void { this._terminal = t; }

  // --- Public API: Auto-push timer ---

  getPushTimer(): ReturnType<typeof setTimeout> | null { return this._pushTimer; }
  setPushTimer(t: ReturnType<typeof setTimeout> | null): void { this._pushTimer = t; }

  clearPushTimer(): void {
    if (this._pushTimer) {
      clearTimeout(this._pushTimer);
      this._pushTimer = null;
    }
  }

  // --- Public API: Turn event buffer ---

  /** Get the current turn's buffered events for reconnection replay. */
  getTurnEventBuffer(): WsServerMessage[] { return [...this._turnEventBuffer]; }

  /** Clear the turn event buffer (called when a new turn starts). */
  clearTurnEventBuffer(): void { this._turnEventBuffer = []; }

  /**
   * Emit a message to all attached viewers and buffer it for reconnection.
   * This replaces the per-connection `send()` call for session-scoped messages.
   */
  emitMessage(msg: WsServerMessage): void {
    // Buffer for reconnection replay
    if (this._turnEventBuffer.length < SessionRunner.MAX_TURN_BUFFER) {
      this._turnEventBuffer.push(msg);
    } else if (this._turnEventBuffer.length === SessionRunner.MAX_TURN_BUFFER) {
      // Keep first few (init, model_info) and most recent
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

  // --- Public API: Viewer management ---

  get viewerCount(): number { return this._viewerCount; }

  attachViewer(): void {
    this._viewerCount++;
  }

  detachViewer(): void {
    this._viewerCount = Math.max(0, this._viewerCount - 1);
  }

  // --- Lifecycle ---

  /**
   * Signal that the agent finished and check for idle state.
   * Called from the "done" handler after queue processing.
   */
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
 * App-level registry of active SessionRunners. One runner per session.
 * Manages lifecycle (create, get, dispose) and enforces resource limits.
 */
export class SessionRunnerRegistry {
  private runners = new Map<string, SessionRunner>();
  private _maxConcurrentRunners: number;
  private _defaultIdleTimeoutMs: number;

  constructor(opts?: { maxConcurrentRunners?: number; defaultIdleTimeoutMs?: number }) {
    this._maxConcurrentRunners = opts?.maxConcurrentRunners ?? 10;
    this._defaultIdleTimeoutMs = opts?.defaultIdleTimeoutMs ?? 10 * 60 * 1000;
  }

  /** Get or create a runner for the given session. */
  getOrCreate(sessionId: string, sessionDir: string, defaultAgentId: AgentId): SessionRunner {
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

    runner = new SessionRunner({
      sessionId,
      sessionDir,
      defaultAgentId,
      idleTimeoutMs: this._defaultIdleTimeoutMs,
    });
    runner.on("disposed", () => this.runners.delete(sessionId));
    this.runners.set(sessionId, runner);
    return runner;
  }

  /** Get existing runner (if any). */
  get(sessionId: string): SessionRunner | undefined {
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
