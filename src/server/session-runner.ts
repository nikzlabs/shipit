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
import type { WsServerMessage, WsLogEntry, ImageAttachment, FileContextRef, PermissionMode, ClaudeContentBlockToolUse } from "./types.js";
import type { TerminalProcess } from "./terminal.js";
import type { PreviewManager } from "./preview-manager.js";
import type { FileWatcher } from "./file-watcher.js";

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

  // Per-turn message groups for chat history persistence.
  // Each tool-result boundary starts a new group so messages are persisted
  // as separate entries (matching the client-side split).
  private _chatMessageGroups: Array<{ text: string; toolUse: ClaudeContentBlockToolUse[] }> = [];
  private _needsNewMessageGroup = true;

  // Message queue
  private _messageQueue: QueuedMessage[] = [];

  // Terminal (per-session — survives connection drops)
  private _terminal: TerminalProcess | null = null;
  private _terminalOutputBuffer = "";
  private static readonly MAX_TERMINAL_BUFFER = 10_000;

  // Auto-push timer
  private _pushTimer: ReturnType<typeof setTimeout> | null = null;

  // Event buffer — stores messages from the current turn so that
  // a reconnecting client can catch up without re-running the agent.
  private _turnEventBuffer: WsServerMessage[] = [];
  private static readonly MAX_TURN_BUFFER = 1000;

  // Message queue cap
  private static readonly MAX_QUEUE_SIZE = 50;

  // Viewer tracking (ref-counted for preview/file-watcher)
  private _viewerCount = 0;

  // Per-session preview and file watcher (ref-counted by viewers)
  private _preview: PreviewManager | null = null;
  private _fileWatcher: FileWatcher | null = null;
  private _createPreviewManager: (() => PreviewManager) | null;
  private _createFileWatcher: (() => FileWatcher) | null;

  // Per-session detected ports (from port scanner)
  private _detectedPorts: number[] = [];

  // Idle cleanup timer
  private _idleTimer: ReturnType<typeof setTimeout> | null = null;
  private _idleTimeoutMs: number;

  private _disposed = false;

  constructor(opts: {
    sessionId: string;
    sessionDir: string;
    defaultAgentId: AgentId;
    idleTimeoutMs?: number; // default: 10 minutes
    createPreviewManager?: () => PreviewManager;
    createFileWatcher?: () => FileWatcher;
  }) {
    super();
    this.sessionId = opts.sessionId;
    this.sessionDir = opts.sessionDir;
    this._agentId = opts.defaultAgentId;
    this._idleTimeoutMs = opts.idleTimeoutMs ?? 10 * 60 * 1000;
    this._createPreviewManager = opts.createPreviewManager ?? null;
    this._createFileWatcher = opts.createFileWatcher ?? null;
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

  get chatMessageGroups(): Array<{ text: string; toolUse: ClaudeContentBlockToolUse[] }> { return this._chatMessageGroups; }
  set chatMessageGroups(groups: Array<{ text: string; toolUse: ClaudeContentBlockToolUse[] }>) { this._chatMessageGroups = groups; }

  get needsNewMessageGroup(): boolean { return this._needsNewMessageGroup; }
  set needsNewMessageGroup(v: boolean) { this._needsNewMessageGroup = v; }

  get agentId(): AgentId { return this._agentId; }
  set agentId(id: AgentId) { this._agentId = id; }

  getAgent(): AgentProcess | null { return this.agent; }
  setAgent(a: AgentProcess | null): void { this.agent = a; }

  // --- Public API: Message queue ---

  get messageQueue(): QueuedMessage[] { return this._messageQueue; }

  get queueLength(): number { return this._messageQueue.length; }

  enqueue(msg: QueuedMessage): number {
    if (this._messageQueue.length >= SessionRunner.MAX_QUEUE_SIZE) {
      throw new Error(`Message queue is full (max ${SessionRunner.MAX_QUEUE_SIZE})`);
    }
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

  /** Append data to the rolling terminal output buffer. */
  appendTerminalOutput(data: string): void {
    this._terminalOutputBuffer += data;
    if (this._terminalOutputBuffer.length > SessionRunner.MAX_TERMINAL_BUFFER) {
      this._terminalOutputBuffer = this._terminalOutputBuffer.slice(
        -SessionRunner.MAX_TERMINAL_BUFFER
      );
    }
  }

  /** Get the buffered terminal output for reconnection replay. */
  getTerminalOutputBuffer(): string { return this._terminalOutputBuffer; }

  /** Clear the terminal output buffer. */
  clearTerminalOutputBuffer(): void { this._terminalOutputBuffer = ""; }

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

  // --- Public API: Detected ports (per-session) ---

  get detectedPorts(): number[] { return this._detectedPorts; }
  set detectedPorts(ports: number[]) { this._detectedPorts = ports; }

  // --- Public API: Viewer management ---

  get viewerCount(): number { return this._viewerCount; }

  /** Get the per-session preview manager (only active when viewers are attached). */
  getPreview(): PreviewManager | null { return this._preview; }

  /** Get the per-session file watcher (only active when viewers are attached). */
  getFileWatcher(): FileWatcher | null { return this._fileWatcher; }

  attachViewer(): void {
    this._viewerCount++;
    if (this._viewerCount === 1 && !this._disposed) {
      this.startSessionResources();
    }
  }

  detachViewer(): void {
    this._viewerCount = Math.max(0, this._viewerCount - 1);
    if (this._viewerCount === 0) {
      this.stopSessionResources();
    }
  }

  /** Start preview server and file watcher for this session (first viewer attached). */
  private startSessionResources(): void {
    if (this._createFileWatcher) {
      this._fileWatcher = this._createFileWatcher();
      this._fileWatcher.start(this.sessionDir);
      this._fileWatcher.on("changes", (paths: string[]) => {
        this.emitMessage({ type: "files_changed", paths });
        // Detect shipit.yaml changes and restart preview with new config
        if (paths.some((p: string) => p === "shipit.yaml" || p.endsWith("/shipit.yaml"))) {
          this._preview?.restart(this.sessionDir);
        }
      });
    }

    if (this._createPreviewManager) {
      this._preview = this._createPreviewManager();
      this.wirePreviewEvents();
      this._preview.start(this.sessionDir);
    }
  }

  /** Stop preview server and file watcher (last viewer detached). */
  private stopSessionResources(): void {
    if (this._preview) {
      this._preview.stop();
      this._preview.removeAllListeners();
      this._preview = null;
    }
    if (this._fileWatcher) {
      this._fileWatcher.stop();
      this._fileWatcher.removeAllListeners();
      this._fileWatcher = null;
    }
  }

  /** Wire preview manager events to emit messages to attached viewers. */
  private wirePreviewEvents(): void {
    if (!this._preview) return;

    this._preview.on("ready", () => {
      this.emitMessage(this.buildPreviewStatus());
    });

    this._preview.on("stopped", () => {
      this.emitMessage(this.buildPreviewStatus());
    });

    this._preview.on("config_missing", (checked: string[]) => {
      this.emitMessage({
        type: "preview_config_missing",
        checked: checked as ("shipit.yaml" | "package.json")[],
      });
    });

    this._preview.on("config_error", (message: string) => {
      this.emitMessage({ type: "preview_config_error", message });
    });

    this._preview.on("install_status", (status: { status: "running" | "complete" | "error"; message?: string }) => {
      this.emitMessage({ type: "install_status", ...status });
    });

    this._preview.on("log", ({ source, text }: { source: string; text: string }) => {
      const entry: WsLogEntry = {
        type: "log_entry",
        source: source as WsLogEntry["source"],
        text,
        timestamp: new Date().toISOString(),
      };
      this.emitMessage(entry);
    });
  }

  /** Build the current preview status message for this session. */
  buildPreviewStatus(): WsServerMessage {
    if (this._preview?.running && this._preview.port) {
      const extraManagedPorts = this._preview.ports.slice(1);
      const allDetected = [...extraManagedPorts, ...this._detectedPorts];
      return {
        type: "preview_status",
        running: true,
        port: this._preview.port,
        url: `/preview/${this._preview.port}/`,
        source: this._preview.config?.mode.kind === "html" ? "vite" : "managed",
        detectedPorts: allDetected.length > 0 ? allDetected : undefined,
      };
    }
    if (this._detectedPorts.length > 0) {
      return {
        type: "preview_status",
        running: true,
        port: this._detectedPorts[0],
        url: `/preview/${this._detectedPorts[0]}/`,
        source: "detected",
        detectedPorts: this._detectedPorts,
      };
    }
    return {
      type: "preview_status",
      running: false,
      port: 5173,
      url: "/preview/5173/",
    };
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
    this.stopSessionResources();
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
  private _createPreviewManager: (() => PreviewManager) | undefined;
  private _createFileWatcher: (() => FileWatcher) | undefined;

  constructor(opts?: {
    maxConcurrentRunners?: number;
    defaultIdleTimeoutMs?: number;
    createPreviewManager?: () => PreviewManager;
    createFileWatcher?: () => FileWatcher;
  }) {
    this._maxConcurrentRunners = opts?.maxConcurrentRunners ?? 10;
    this._defaultIdleTimeoutMs = opts?.defaultIdleTimeoutMs ?? 10 * 60 * 1000;
    this._createPreviewManager = opts?.createPreviewManager;
    this._createFileWatcher = opts?.createFileWatcher;
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
      createPreviewManager: this._createPreviewManager,
      createFileWatcher: this._createFileWatcher,
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
