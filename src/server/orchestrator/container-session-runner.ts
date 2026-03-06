/**
 * ContainerSessionRunner — SessionRunner implementation that delegates to a
 * remote session worker over HTTP + SSE.
 *
 * Implements the same SessionRunnerInterface as the direct SessionRunner.
 * From the perspective of HandlerContext, WebSocket handlers, and the registry,
 * this is indistinguishable from a direct runner.
 *
 * Phase 1: agent start/stop/interrupt + SSE event forwarding.
 * Phase 3: terminal, preview, file watcher proxy.
 */

import { EventEmitter } from "node:events";
import { getErrorMessage } from "../shared/utils.js";
import type { AgentProcess, AgentId, AgentEvent, AgentRunParams, TerminalProcess } from "../shared/types.js";
import type { WsServerMessage, ClaudeContentBlockToolUse } from "../shared/types.js";
import type { SessionRunnerInterface, SessionRunnerEvents, QueuedMessage, SystemTurnDeps, ChatMessageGroup } from "./session-runner.js";
import { runSystemTurn } from "./session-runner.js";
import { connectSSE } from "./sse-client.js";
import type { SSEEvent } from "./sse-client.js";
import { workerPost, workerGet } from "./worker-http.js";
import { truncateTerminalBuffer } from "./terminal-buffer.js";
import { ProxyAgentProcess } from "./proxy-agent-process.js";
import type { ProxyAgentRunner } from "./proxy-agent-process.js";

// ---------------------------------------------------------------------------
// Barrel re-exports for backwards compatibility
// ---------------------------------------------------------------------------
export { connectSSE } from "./sse-client.js";
export type { SSEEvent } from "./sse-client.js";
export { workerPost, workerGet } from "./worker-http.js";
export { truncateTerminalBuffer } from "./terminal-buffer.js";
export { ProxyAgentProcess } from "./proxy-agent-process.js";
export type { ProxyAgentRunner } from "./proxy-agent-process.js";

// ---------------------------------------------------------------------------
// ContainerSessionRunner
// ---------------------------------------------------------------------------

export class ContainerSessionRunner extends EventEmitter<SessionRunnerEvents> implements SessionRunnerInterface, ProxyAgentRunner {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly supportsRemoteTerminal = true;

  // Worker connection
  private workerUrl: string;
  private _workerReady: Promise<void>;
  private _resolveWorkerReady!: () => void;
  private sseConnection: { close: () => void } | null = null;
  private sseReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sseReconnectAttempts = 0;
  private static readonly MAX_RECONNECT_DELAY_MS = 10_000;
  private _sseConnected: Promise<void> | null = null;
  private _resolveSseConnected: (() => void) | null = null;

  // Agent state (mirrored locally for synchronous access by HandlerContext)
  private _agent: ProxyAgentProcess | null = null;
  private _agentId: AgentId;
  private _isRunning = false;
  private _wasInterrupted = false;
  private _accumulatedText = "";
  private _accumulatedToolUse: ClaudeContentBlockToolUse[] = [];
  private _turnSummary = "";
  private _chatMessageGroups: ChatMessageGroup[] = [];
  private _needsNewMessageGroup = true;

  // Message queue
  private _messageQueue: QueuedMessage[] = [];
  private static readonly MAX_QUEUE_SIZE = 50;

  // Terminal (remote — runs inside container)
  private _terminal: TerminalProcess | null = null;
  private _terminalOutputBuffer = "";
  /**
   * Maximum size of the server-side terminal output buffer in bytes.
   * Sized at ~80KB to approximate the client's 1000-line xterm.js scrollback
   * buffer (assuming ~80 chars/line average). This ensures that replayed
   * output on reconnect covers roughly the same window the user could scroll
   * through on the client.
   *
   * The client-side xterm.js scrollback (1000 lines) and this server-side
   * byte buffer serve different purposes: the server buffer enables replay
   * after SSE reconnection, while the client buffer provides local scroll.
   * They may drift — the server may hold data that doesn't fit in client
   * scrollback, or vice versa — which is acceptable since server-side replay
   * is "best effort" to restore visual context after a reconnect.
   */
  private static readonly MAX_TERMINAL_BUFFER = 80_000;
  private _remoteTerminalRunning = false;
  /** Maximum SSE reconnection attempts for terminal recovery. */
  private static readonly MAX_TERMINAL_RECONNECT_ATTEMPTS = 3;

  // Preview (remote — runs inside container)
  private _workerPreviewPorts: number[] = [];
  /** Set to true once we've received any preview state from the worker SSE. */
  private _previewStateReceived = false;
  /** Rolling buffer of recent preview log lines for crash diagnostics. */
  private _previewLogBuffer: string[] = [];
  private static readonly MAX_PREVIEW_LOG_LINES = 50;
  /** Exit code from the last preview process exit, or null if never exited / exited cleanly. */
  private _lastPreviewExitCode: number | null = null;

  // Auto-push timer
  private _pushTimer: ReturnType<typeof setTimeout> | null = null;

  // Turn event buffer
  private _turnEventBuffer: WsServerMessage[] = [];
  private static readonly MAX_TURN_BUFFER = 1000;
  lastPersistedBufferIndex = 0;

  // Viewer tracking
  private _viewerCount = 0;

  // Per-session detected ports
  private _detectedPorts: number[] = [];

  private _disposed = false;

  constructor(opts: {
    sessionId: string;
    sessionDir: string;
    defaultAgentId: AgentId;
    workerUrl: string;
  }) {
    super();
    this.sessionId = opts.sessionId;
    this.sessionDir = opts.sessionDir;
    this._agentId = opts.defaultAgentId;
    this.workerUrl = opts.workerUrl;
    // If workerUrl looks like a placeholder, defer readiness until setWorkerUrl() is called.
    if (opts.workerUrl === "http://0.0.0.0:0") {
      this._workerReady = new Promise<void>((resolve) => { this._resolveWorkerReady = resolve; });
    } else {
      this._workerReady = Promise.resolve();
      this._resolveWorkerReady = () => {};
    }
  }

  /** Update the worker URL once the container is ready. */
  setWorkerUrl(url: string): void {
    this.workerUrl = url;
    this._resolveWorkerReady();
  }

  // --- Agent state (same interface as SessionRunner) ---

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

  get chatMessageGroups(): ChatMessageGroup[] { return this._chatMessageGroups; }
  set chatMessageGroups(groups: ChatMessageGroup[]) { this._chatMessageGroups = groups; }

  get needsNewMessageGroup(): boolean { return this._needsNewMessageGroup; }
  set needsNewMessageGroup(v: boolean) { this._needsNewMessageGroup = v; }

  get agentId(): AgentId { return this._agentId; }
  set agentId(id: AgentId) { this._agentId = id; }

  getAgent(): AgentProcess | null { return this._agent; }

  setAgent(a: AgentProcess | null): void {
    // When the orchestrator sets the agent, it's creating a new one to run.
    // For the container runner, we create a proxy that receives events via SSE.
    this._agent = a as ProxyAgentProcess | null;
  }

  // --- Message queue ---

  get messageQueue(): QueuedMessage[] { return this._messageQueue; }
  get queueLength(): number { return this._messageQueue.length; }

  enqueue(msg: QueuedMessage): number {
    if (this._messageQueue.length >= ContainerSessionRunner.MAX_QUEUE_SIZE) {
      throw new Error(`Message queue is full (max ${ContainerSessionRunner.MAX_QUEUE_SIZE})`);
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

  getQueueSnapshot(): { text: string; position: number }[] {
    return this._messageQueue.map((item, idx) => ({ text: item.text, position: idx + 1 }));
  }

  // --- Terminal ---

  getTerminal(): TerminalProcess | null { return this._terminal; }
  setTerminal(t: TerminalProcess | null): void { this._terminal = t; }

  /** Whether the remote terminal inside the container is running. */
  get remoteTerminalRunning(): boolean { return this._remoteTerminalRunning; }

  appendTerminalOutput(data: string): void {
    this._terminalOutputBuffer += data;
    if (this._terminalOutputBuffer.length > ContainerSessionRunner.MAX_TERMINAL_BUFFER) {
      this._terminalOutputBuffer = truncateTerminalBuffer(
        this._terminalOutputBuffer,
        ContainerSessionRunner.MAX_TERMINAL_BUFFER,
      );
    }
  }

  getTerminalOutputBuffer(): string { return this._terminalOutputBuffer; }
  clearTerminalOutputBuffer(): void { this._terminalOutputBuffer = ""; }

  // --- Auto-push timer ---

  getPushTimer(): ReturnType<typeof setTimeout> | null { return this._pushTimer; }
  setPushTimer(t: ReturnType<typeof setTimeout> | null): void { this._pushTimer = t; }

  clearPushTimer(): void {
    if (this._pushTimer) {
      clearTimeout(this._pushTimer);
      this._pushTimer = null;
    }
  }

  // --- Turn event buffer ---

  getTurnEventBuffer(): WsServerMessage[] { return [...this._turnEventBuffer]; }
  clearTurnEventBuffer(): void { this._turnEventBuffer = []; this.lastPersistedBufferIndex = 0; }

  emitMessage(msg: WsServerMessage): void {
    if (this._turnEventBuffer.length < ContainerSessionRunner.MAX_TURN_BUFFER) {
      this._turnEventBuffer.push(msg);
    } else if (this._turnEventBuffer.length === ContainerSessionRunner.MAX_TURN_BUFFER) {
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

  // --- Detected ports ---

  get detectedPorts(): number[] { return this._detectedPorts; }
  set detectedPorts(ports: number[]) { this._detectedPorts = ports; }

  // --- Viewer management ---

  get viewerCount(): number { return this._viewerCount; }

  getPreview(): null { return null; }
  getFileWatcher(): null { return null; }

  private _workerResourcesStarted = false;

  attachViewer(): void {
    this._viewerCount++;
    console.log(`[container-runner:${this.sessionId}] attachViewer (count=${this._viewerCount}, disposed=${this._disposed})`);
    if (!this._workerResourcesStarted && !this._disposed) {
      this._workerResourcesStarted = true;
      // Connect SSE first, then start resources so we don't miss events.
      // The worker replays current preview state on SSE connect (preview_ready
      // if running). startWorkerResources() triggers /preview/start which always
      // produces a definitive event (preview_ready, preview_config_missing, etc.).
      // No timer needed — the event-driven flow covers all cases.
      // eslint-disable-next-line no-restricted-syntax -- sync method chains async operations
      void this.connectEventStream().then(() => {
        if (!this._disposed) void this.startWorkerResources();
      });
    }
  }

  detachViewer(): void {
    this._viewerCount = Math.max(0, this._viewerCount - 1);
    // Don't stop worker resources or SSE — the container keeps running and
    // the viewer may reattach quickly (session switching). Cleanup happens
    // in dispose() when the runner is actually torn down.
  }

  get previewStatusKnown(): boolean { return this._previewStateReceived; }

  /** Wait until preview state is known (SSE connected + worker reported status).
   *  Resolves immediately if already known. */
  async waitForPreviewStatus(): Promise<void> {
    if (this._previewStateReceived) return;
    return new Promise<void>((resolve) => {
      const listener = (msg: WsServerMessage) => {
        if (msg.type === "preview_status") {
          this.off("message", listener);
          resolve();
        }
      };
      this.on("message", listener);
      // Re-check in case it arrived between the guard and the listener
      if (this._previewStateReceived) {
        this.off("message", listener);
        resolve();
      }
    });
  }

  buildPreviewStatus(): WsServerMessage {
    if (this._workerPreviewPorts.length > 0) {
      const primaryPort = this._workerPreviewPorts[0];
      return {
        type: "preview_status",
        running: true,
        port: primaryPort,
        url: `/preview/${this.sessionId}/${primaryPort}/`,
        source: "managed",
        detectedPorts: this._workerPreviewPorts.length > 1
          ? this._workerPreviewPorts.slice(1)
          : undefined,
        sessionId: this.sessionId,
      };
    }
    if (this._detectedPorts.length > 0) {
      return {
        type: "preview_status",
        running: true,
        port: this._detectedPorts[0],
        url: `/preview/${this.sessionId}/${this._detectedPorts[0]}/`,
        source: "detected",
        detectedPorts: this._detectedPorts,
        sessionId: this.sessionId,
      };
    }
    const crashed = this._lastPreviewExitCode !== null && this._lastPreviewExitCode !== undefined && this._lastPreviewExitCode !== 0;
    return {
      type: "preview_status" as const,
      running: false,
      port: 5173,
      url: `/preview/${this.sessionId}/5173/`,
      ...(crashed && {
        exitCode: this._lastPreviewExitCode,
        errorOutput: this._previewLogBuffer.join(""),
      }),
      sessionId: this.sessionId,
    };
  }

  // --- Worker communication: agent ---

  /**
   * Create a ProxyAgentProcess for this runner. The proxy's run()/interrupt()/
   * kill()/writeStdin() methods delegate to the worker via HTTP. Called by the
   * dynamic agentFactory when this runner is attached.
   */
  createAgent(agentId: AgentId): ProxyAgentProcess {
    const proxy = new ProxyAgentProcess(agentId, this);
    this._agent = proxy;
    return proxy;
  }

  /**
   * Called by ProxyAgentProcess.run(). Waits for worker readiness, POSTs
   * /agent/start, and ensures the SSE stream is connected for events.
   */
  async _startAgentViaProxy(agentId: AgentId, params: AgentRunParams): Promise<void> {
    await this._workerReady;
    await workerPost(this.workerUrl, "/agent/start", { agentId, params });
    if (!this.sseConnection) {
      await this.connectEventStream();
    }
  }

  /**
   * Start an agent on the worker. Creates a proxy AgentProcess locally
   * that receives events via the SSE stream. Convenience method for tests.
   */
  async startAgentOnWorker(agentId: AgentId, params: AgentRunParams): Promise<ProxyAgentProcess> {
    await this._workerReady;
    const proxy = new ProxyAgentProcess(agentId, this);
    this._agent = proxy;

    await workerPost(this.workerUrl, "/agent/start", { agentId, params });

    // Ensure SSE is connected to receive events
    if (!this.sseConnection) {
      await this.connectEventStream();
    }

    return proxy;
  }

  /** Interrupt the agent running on the worker. */
  async interruptAgentOnWorker(): Promise<void> {
    await workerPost(this.workerUrl, "/agent/interrupt");
  }

  /** Kill the agent running on the worker. */
  async killAgentOnWorker(): Promise<void> {
    await workerPost(this.workerUrl, "/agent/kill");
    this._agent = null;
  }

  /** Write to the agent's stdin on the worker. */
  async writeAgentStdin(data: string): Promise<void> {
    await workerPost(this.workerUrl, "/agent/stdin", { data });
  }

  // --- Worker communication: terminal ---

  /** Start a terminal PTY inside the container. */
  async startTerminalOnWorker(cols?: number, rows?: number): Promise<void> {
    await workerPost(this.workerUrl, "/terminal/start", { cols, rows });
    this._remoteTerminalRunning = true;
  }

  /** Write data to the terminal inside the container. */
  async writeTerminalOnWorker(data: string): Promise<void> {
    await workerPost(this.workerUrl, "/terminal/input", { data });
  }

  /** Resize the terminal inside the container. */
  async resizeTerminalOnWorker(cols: number, rows: number): Promise<void> {
    await workerPost(this.workerUrl, "/terminal/resize", { cols, rows });
  }

  // --- Worker communication: preview ---

  /** Start the preview server inside the container. */
  async startPreviewOnWorker(): Promise<void> {
    await workerPost(this.workerUrl, "/preview/start");
  }

  /** Stop the preview server inside the container. */
  async stopPreviewOnWorker(): Promise<void> {
    await workerPost(this.workerUrl, "/preview/stop");
    this._workerPreviewPorts = [];
  }

  /** Restart preview with a fresh install (clears install marker). */
  async restartPreviewOnWorker(): Promise<void> {
    this._lastPreviewExitCode = null;
    this._previewLogBuffer = [];
    this._workerPreviewPorts = [];
    await workerPost(this.workerUrl, "/preview/restart");
  }

  /** Get the file tree from the container's workspace. */
  async getFileTreeFromWorker(): Promise<unknown> {
    return workerGet(this.workerUrl, "/files/tree");
  }

  // --- Worker resource lifecycle ---

  /** Start preview and file watcher on the worker (called when first viewer attaches). */
  private async startWorkerResources(): Promise<void> {
    console.log(`[container-runner:${this.sessionId}] Waiting for worker to be ready...`);
    await this._workerReady;
    if (this._disposed) { console.log(`[container-runner:${this.sessionId}] Disposed before worker ready`); return; }
    console.log(`[container-runner:${this.sessionId}] Starting worker resources at ${this.workerUrl}`);
    try {
      await workerPost(this.workerUrl, "/files/watch");
      console.log(`[container-runner:${this.sessionId}] File watcher started on worker`);
    } catch (err) {
      console.error(`[container-runner:${this.sessionId}] Failed to start file watcher:`, err);
    }
    try {
      await workerPost(this.workerUrl, "/preview/start");
      console.log(`[container-runner:${this.sessionId}] Preview started on worker`);
    } catch (err) {
      // "Preview already running" = reconnect case — SSE replay delivers current state
      const msg = getErrorMessage(err);
      if (msg.includes("already running")) {
        console.log(`[container-runner:${this.sessionId}] Preview already running on worker`);
      } else {
        console.error(`[container-runner:${this.sessionId}] Failed to start preview:`, err);
      }
    }
  }

  /** Stop preview and file watcher on the worker (called when last viewer detaches). */
  private async stopWorkerResources(): Promise<void> {
    try { await workerPost(this.workerUrl, "/preview/stop"); } catch { /* container may be gone */ }
    try { await workerPost(this.workerUrl, "/files/unwatch"); } catch { /* container may be gone */ }
  }

  // --- SSE connection management ---

  /** Connect to the worker SSE stream. Returns a promise that resolves once the connection is open. */
  private connectEventStream(): Promise<void> {
    if (this.sseConnection || this._disposed) {
      return this._sseConnected ?? Promise.resolve();
    }

    this._sseConnected = new Promise<void>((resolve) => {
      this._resolveSseConnected = resolve;
    });

    // Wait for the container to be ready before connecting
    // eslint-disable-next-line no-restricted-syntax -- waits for container readiness in sync context
    void this._workerReady.then(() => {
      if (this.sseConnection || this._disposed) return;
      this._connectEventStreamNow();
    });

    return this._sseConnected;
  }

  private _connectEventStreamNow(): void {
    const isReconnect = this.sseReconnectAttempts > 0;
    this.sseConnection = connectSSE(
      `${this.workerUrl}/events`,
      (event) => this.handleSSEEvent(event),
      (err) => {
        console.error(`[container-runner:${this.sessionId}] SSE error:`, err.message);
        this.sseConnection = null;
        this.handleSSEDisconnect();
      },
      () => {
        this.sseConnection = null;
        if (this._workerResourcesStarted && !this._disposed) {
          this.handleSSEDisconnect();
        }
      },
      () => {
        // onOpen — SSE connection established
        // Reset reconnect counter only on successful connection
        this.sseReconnectAttempts = 0;
        if (this._resolveSseConnected) {
          this._resolveSseConnected();
          this._resolveSseConnected = null;
        }
        // On reconnect with a running terminal, replay buffered output
        // prefixed with a terminal reset sequence so xterm.js starts
        // from a known-good state (avoids corrupted rendering from
        // output that was truncated mid-escape-sequence).
        if (isReconnect && this._remoteTerminalRunning) {
          const buffered = this.getTerminalOutputBuffer();
          if (buffered) {
            this.emitMessage({ type: "terminal_output", data: `\x1bc${  buffered}` });
          }
        }
      },
    );
  }

  /**
   * Handle SSE disconnection: notify client if terminal is running and
   * schedule a reconnection attempt (up to MAX_TERMINAL_RECONNECT_ATTEMPTS
   * when the terminal is active).
   */
  private handleSSEDisconnect(): void {
    if (this._remoteTerminalRunning) {
      // Notify the client that terminal connectivity was lost
      const attempt = this.sseReconnectAttempts + 1;
      this.emitMessage({
        type: "terminal_reconnecting",
        attempt,
        maxAttempts: ContainerSessionRunner.MAX_TERMINAL_RECONNECT_ATTEMPTS,
      });

      if (attempt > ContainerSessionRunner.MAX_TERMINAL_RECONNECT_ATTEMPTS) {
        // Exceeded max terminal reconnect attempts — mark terminal as dead
        console.error(
          `[container-runner:${this.sessionId}] Terminal SSE reconnect failed after ${ContainerSessionRunner.MAX_TERMINAL_RECONNECT_ATTEMPTS} attempts`,
        );
        this._remoteTerminalRunning = false;
        this.emitMessage({ type: "terminal_exit", exitCode: null });
        return;
      }
    }
    this.scheduleReconnect();
  }

  private disconnectEventStream(): void {
    if (this.sseConnection) {
      this.sseConnection.close();
      this.sseConnection = null;
    }
    if (this.sseReconnectTimer) {
      clearTimeout(this.sseReconnectTimer);
      this.sseReconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this._disposed || this.sseReconnectTimer) return;

    // Exponential backoff: 1s, 2s, 4s, 8s, 10s (capped)
    const delay = Math.min(
      1000 * Math.pow(2, this.sseReconnectAttempts),
      ContainerSessionRunner.MAX_RECONNECT_DELAY_MS,
    );
    this.sseReconnectAttempts++;

    this.sseReconnectTimer = setTimeout(() => {
      this.sseReconnectTimer = null;
      void this.connectEventStream();
    }, delay);
  }

  private handleSSEEvent(event: SSEEvent): void {
    try {
      const data = JSON.parse(event.data) as Record<string, unknown>;

      switch (event.type) {
        // --- Agent events ---

        case "agent_event":
          if (this._agent) {
            this._agent.emit("event", data as unknown as AgentEvent);
          }
          break;

        case "agent_done":
          if (this._agent) {
            this._agent.emit("done", (data.exitCode as number) ?? 0);
          }
          break;

        case "agent_error":
          if (this._agent) {
            this._agent.emit("error", new Error((data.message as string) ?? "Unknown worker error"));
          }
          break;

        case "agent_auth_required":
          if (this._agent) {
            this._agent.emit("auth_required");
          }
          break;

        case "agent_log":
          if (this._agent) {
            this._agent.emit("log", (data.source as string) ?? "worker", (data.text as string) ?? "");
          }
          break;

        // --- Terminal events ---

        case "terminal_data":
          this.appendTerminalOutput(data.data as string);
          this.emitMessage({ type: "terminal_output", data: data.data as string });
          break;

        case "terminal_exit":
          this._remoteTerminalRunning = false;
          this.emitMessage({ type: "terminal_exit", exitCode: data.exitCode as number | null });
          break;

        // --- Preview events ---

        case "preview_ready":
          this._previewStateReceived = true;
          this._workerPreviewPorts = (data.ports as number[]) ?? [];
          this._previewLogBuffer = [];
          this._lastPreviewExitCode = null;
          this.emitMessage(this.buildPreviewStatus());
          break;

        case "preview_stopped":
          this._previewStateReceived = true;
          this._workerPreviewPorts = [];
          this._lastPreviewExitCode = (data.code as number) ?? null;
          this.emitMessage(this.buildPreviewStatus());
          break;

        case "preview_config_missing":
          this._previewStateReceived = true;
          this.emitMessage({
            type: "preview_config_missing",
            checked: (data.checked as string[]) ?? [],
          } as WsServerMessage);
          break;

        case "preview_config_error":
          this._previewStateReceived = true;
          this.emitMessage({
            type: "preview_config_error",
            message: (data.message as string) ?? "",
          } as WsServerMessage);
          break;

        case "preview_install_status":
          this._previewStateReceived = true;
          this.emitMessage({
            type: "install_status",
            ...data,
          } as WsServerMessage);
          break;

        case "preview_log": {
          const text = (data.text as string) ?? "";
          this._previewLogBuffer.push(text);
          if (this._previewLogBuffer.length > ContainerSessionRunner.MAX_PREVIEW_LOG_LINES) {
            this._previewLogBuffer.shift();
          }
          this.emitMessage({
            type: "log_entry",
            source: (data.source as string) ?? "preview",
            text,
            timestamp: new Date().toISOString(),
          } as WsServerMessage);
          break;
        }

        // --- File watcher events ---

        case "file_changes":
          this.emitMessage({ type: "files_changed", paths: (data.paths as string[]) ?? [] } as WsServerMessage);
          // Detect shipit.yaml changes and restart preview on worker
          if ((data.paths as string[])?.some((p: string) => p === "shipit.yaml" || p.endsWith("/shipit.yaml"))) {
            // eslint-disable-next-line no-restricted-syntax -- fire-and-forget preview restart in sync handler
            workerPost(this.workerUrl, "/preview/stop")
              .then(() => workerPost(this.workerUrl, "/preview/start"))
              .catch((err: unknown) => console.warn(`[container-runner:${this.sessionId}] Preview restart after shipit.yaml change failed:`, err));
          }
          break;
      }
    } catch (err) {
      console.error(`[container-runner:${this.sessionId}] Failed to parse SSE event:`, err);
    }
  }

  // --- System-initiated turns ---

  private _systemTurnDeps: SystemTurnDeps | null = null;

  setSystemTurnDeps(deps: SystemTurnDeps): void {
    this._systemTurnDeps = deps;
  }

  sendSystemMessage(text: string, activity?: string): void {
    if (this._isRunning) {
      this.enqueue({ text });
      return;
    }
    if (!this._systemTurnDeps) {
      this.enqueue({ text });
      return;
    }
    this._runSystemTurn(text, activity);
  }

  private _runSystemTurn(text: string, activity?: string): void {
    runSystemTurn(this, this._systemTurnDeps!, this._agentId, text, (agentId) => {
      return this.createAgent(agentId);
    }, activity);
  }

  // --- Lifecycle ---

  onAgentFinished(): void {
    if (!this._isRunning && this._messageQueue.length === 0) {
      this.emit("idle");
    }
    // Auto-restart crashed preview after agent turn ends (agent may have fixed the issue)
    if (this._lastPreviewExitCode !== null && this._lastPreviewExitCode !== undefined && this._lastPreviewExitCode !== 0) {
      this._lastPreviewExitCode = null;
      this._previewLogBuffer = [];
      // eslint-disable-next-line no-restricted-syntax -- fire-and-forget preview restart
      workerPost(this.workerUrl, "/preview/stop")
        .then(() => workerPost(this.workerUrl, "/preview/start"))
        .catch(() => {});
    }
  }

  get disposed(): boolean { return this._disposed; }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    // Kill agent on worker (fire and forget)
    if (this._agent) {
      workerPost(this.workerUrl, "/agent/kill").catch(() => {});
      this._agent = null;
    }

    // Don't stop worker resources (preview, file watcher) — the container
    // stays alive and a new runner may reconnect to it. Stopping the preview
    // would force a full restart on reconnect.

    this.disconnectEventStream();
    this.clearPushTimer();
    this._messageQueue.length = 0;
    this._turnEventBuffer = [];
    this._isRunning = false;
    this._remoteTerminalRunning = false;
    this._workerPreviewPorts = [];
    this.emit("disposed");
    this.removeAllListeners();
  }
}
