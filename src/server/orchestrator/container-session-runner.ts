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
import type { AgentProcess, AgentId, AgentEvent, AgentRunParams, TerminalProcess } from "../shared/types.js";
import type { WsServerMessage, ClaudeContentBlockToolUse } from "../shared/types.js";
import type { SessionRunnerInterface, SessionRunnerEvents, QueuedMessage, SystemTurnDeps, ChatMessageGroup } from "./session-runner.js";
import { runSystemTurn } from "./session-runner.js";
import { connectSSE } from "./sse-client.js";
import type { SSEEvent } from "./sse-client.js";
import { workerPost, workerGet, workerInstall } from "./worker-http.js";
import { truncateTerminalBuffer } from "./terminal-buffer.js";
import { ProxyAgentProcess } from "./proxy-agent-process.js";
import type { ProxyAgentRunner } from "./proxy-agent-process.js";
import type { ServiceManager, ManagedService } from "./service-manager.js";

// ---------------------------------------------------------------------------
// Barrel re-exports for backwards compatibility
// ---------------------------------------------------------------------------
export { connectSSE } from "./sse-client.js";
export type { SSEEvent } from "./sse-client.js";
export { workerPost, workerGet, workerInstall } from "./worker-http.js";
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

  // Worker connection (session container)
  private workerUrl: string;
  private _workerReady: Promise<void>;
  private _resolveWorkerReady!: () => void;
  private sseConnection: { close: () => void } | null = null;
  private sseReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sseReconnectAttempts = 0;
  private static readonly MAX_RECONNECT_DELAY_MS = 10_000;
  private _sseConnected: Promise<void> | null = null;
  private _resolveSseConnected: (() => void) | null = null;

  /** Optional callback to load secrets for this session's repo. */
  private _secretsLoader: (() => Promise<Record<string, string>>) | null = null;

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

  // Auto-push timer
  private _pushTimer: ReturnType<typeof setTimeout> | null = null;

  // Turn event buffer
  private _turnEventBuffer: WsServerMessage[] = [];
  private static readonly MAX_TURN_BUFFER = 1000;
  lastPersistedBufferIndex = 0;

  // Viewer tracking
  private _viewerCount = 0;
  private _lastViewerDetachAt = 0;

  // Per-session detected ports
  private _detectedPorts: number[] = [];

  /**
   * Timestamp (Date.now()) of the most recent SSE event from the worker.
   * Used by the container health endpoint to surface "last event 47s ago"
   * so the user can tell when the SSE stream has stalled even if the
   * container itself is still running.
   */
  private _lastSseEventAt = 0;

  // Compose service management
  private _serviceManager: ServiceManager | null = null;
  private _serviceManagerListeners: (() => void)[] = [];
  /** Called when config files change and no ServiceManager exists (e.g. after migration). */
  onComposeConfigChanged?: () => void;

  /** Config files that trigger a compose reconcile when changed. */
  private static readonly CONFIG_FILES = new Set([
    "shipit.yaml",
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml",
  ]);

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

  /** Set the secrets loader callback (called before preview start). */
  setSecretsLoader(loader: () => Promise<Record<string, string>>): void {
    this._secretsLoader = loader;
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

  /** Timestamp of the most recent SSE event from the worker, or 0 if none yet. */
  get lastSseEventAt(): number { return this._lastSseEventAt; }

  /** Worker URL (read-only — used by the container health endpoint). */
  getWorkerUrl(): string { return this.workerUrl; }

  /** Collect ports from all running auto-preview services. */
  private buildDetectedPortsFromServices(mgr: ServiceManager): number[] {
    return mgr.getServices()
      .filter(s => s.preview === "auto" && s.status === "running" && s.port)
      .map(s => s.port!);
  }

  // --- Service Manager ---

  get serviceManager(): ServiceManager | null { return this._serviceManager; }

  /**
   * Attach a ServiceManager and wire its events to WS messages.
   * The ServiceManager's service_status and service_log events are relayed
   * to all connected viewers via emitMessage().
   */
  setServiceManager(mgr: ServiceManager): void {
    this.clearServiceManager();
    this._serviceManager = mgr;

    const onStatus = (svc: ManagedService) => {
      this.emitMessage({
        type: "service_status",
        sessionId: this.sessionId,
        name: svc.name,
        status: svc.status,
        port: svc.port,
        preview: svc.preview,
        error: svc.error,
      } as WsServerMessage);

      // When an auto-preview service changes status, recalculate detected
      // ports and emit preview_status so the client reflects the real state
      // (e.g. green dot → error when a container crashes).
      if (svc.preview === "auto") {
        this._detectedPorts = this.buildDetectedPortsFromServices(mgr);
        this.emitMessage(this.buildPreviewStatus());
      }
    };

    const onLog = (name: string, text: string) => {
      this.emitMessage({
        type: "service_log",
        sessionId: this.sessionId,
        name,
        text,
      } as WsServerMessage);
    };

    const onReady = () => {
      // Send full service list on stack ready
      const services = mgr.getServices();
      this.emitMessage({
        type: "service_list",
        sessionId: this.sessionId,
        services: services.map(s => ({
          name: s.name,
          status: s.status,
          port: s.port,
          preview: s.preview,
          error: s.error,
        })),
      } as WsServerMessage);

      // Emit preview_status AFTER service_list so it's the last message in the
      // stack-ready burst.  React 18 automatic batching can swallow intermediate
      // WS messages (setLastMessage is overwritten before a re-render), so the
      // preview_status emitted per-service in onStatus may be lost.  Sending it
      // here as the final message guarantees the client sees it.
      this._detectedPorts = this.buildDetectedPortsFromServices(mgr);
      this.emitMessage(this.buildPreviewStatus());
    };

    mgr.on("service_status", onStatus);
    mgr.on("service_log", onLog);
    mgr.on("stack_ready", onReady);

    this._serviceManagerListeners = [
      () => mgr.off("service_status", onStatus),
      () => mgr.off("service_log", onLog),
      () => mgr.off("stack_ready", onReady),
    ];
  }

  /** Detach and clean up the current ServiceManager. */
  private clearServiceManager(): void {
    for (const unsub of this._serviceManagerListeners) unsub();
    this._serviceManagerListeners = [];
    this._serviceManager = null;
  }

  // --- Viewer management ---

  get viewerCount(): number { return this._viewerCount; }
  get lastViewerDetachAt(): number { return this._lastViewerDetachAt; }

  private _workerResourcesStarted = false;

  attachViewer(): void {
    this._viewerCount++;
    console.log(`[container-runner:${this.sessionId}] attachViewer (count=${this._viewerCount}, disposed=${this._disposed})`);
    if (!this._workerResourcesStarted && !this._disposed) {
      this._workerResourcesStarted = true;
      // Connect session SSE first, then start resources so we don't miss events.
      // startWorkerResources() also connects preview SSE and starts preview.
      // eslint-disable-next-line no-restricted-syntax -- sync method chains async operations
      void this.connectEventStream().then(() => {
        if (!this._disposed) void this.startWorkerResources();
      });
    }
  }

  detachViewer(): void {
    this._viewerCount = Math.max(0, this._viewerCount - 1);
    this._lastViewerDetachAt = Date.now();
    // Don't stop worker resources or SSE — the container keeps running and
    // the viewer may reattach quickly (session switching). Cleanup happens
    // in dispose() when the runner is actually torn down.
  }

  readonly previewStatusKnown: boolean = true;

  async waitForPreviewStatus(): Promise<void> { /* Preview is managed via compose — always known */ }

  buildPreviewStatus(): WsServerMessage {
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
    return {
      type: "preview_status" as const,
      running: false,
      port: 5173,
      url: `/preview/${this.sessionId}/5173/`,
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
  async killAgentOnWorker(opts?: { timeoutMs?: number }): Promise<void> {
    await workerPost(this.workerUrl, "/agent/kill", undefined, opts);
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

  /** Get the file tree from the container's workspace. */
  async getFileTreeFromWorker(): Promise<unknown> {
    return workerGet(this.workerUrl, "/files/tree");
  }

  // --- Worker resource lifecycle ---

  /** Start file watcher on session worker. */
  private async startWorkerResources(): Promise<void> {
    console.log(`[container-runner:${this.sessionId}] Waiting for worker to be ready...`);
    await this._workerReady;
    if (this._disposed) { console.log(`[container-runner:${this.sessionId}] Disposed before worker ready`); return; }
    console.log(`[container-runner:${this.sessionId}] Starting worker resources at ${this.workerUrl}`);

    // Start file watcher on session worker
    try {
      await workerPost(this.workerUrl, "/files/watch");
      console.log(`[container-runner:${this.sessionId}] File watcher started on worker`);
    } catch (err) {
      console.error(`[container-runner:${this.sessionId}] Failed to start file watcher:`, err);
    }
  }

  /** Stop file watcher on session worker. */
  private async stopWorkerResources(): Promise<void> {
    try { await workerPost(this.workerUrl, "/files/unwatch"); } catch { /* container may be gone */ }
  }

  /**
   * Run agent.install commands on the session worker. Fire-and-forget —
   * progress streams via SSE events. Skips if .shipit/.install-done marker exists.
   */
  async runInstall(commands: string[]): Promise<void> {
    if (commands.length === 0) return;

    await this._workerReady;
    if (this._disposed) return;

    this.emitMessage({
      type: "install_status",
      sessionId: this.sessionId,
      status: "running",
      command: commands[0],
    });

    try {
      const result = await workerInstall(this.workerUrl, commands) as { skipped?: boolean; started?: boolean };
      if (result.skipped) {
        this.emitMessage({
          type: "install_status",
          sessionId: this.sessionId,
          status: "skipped",
        });
      }
      // If started, progress comes via SSE events (install_log, install_done, install_error)
    } catch (err) {
      this.emitMessage({
        type: "install_status",
        sessionId: this.sessionId,
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
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
      this._lastSseEventAt = Date.now();

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

        // --- Service control requests (from agent via worker) ---

        case "service_request": {
          const requestId = data.requestId as string;
          const action = data.action as string;
          const name = data.name as string | undefined;
          // Handle asynchronously — don't block SSE processing
          void this.handleServiceRequest(requestId, action, name);
          break;
        }

        // --- Install events ---

        case "install_log":
          this.emitMessage({
            type: "install_log",
            sessionId: this.sessionId,
            text: (data.text as string) ?? "",
            stream: (data.stream as "stdout" | "stderr") ?? "stdout",
          });
          break;

        case "install_done":
          this.emitMessage({
            type: "install_status",
            sessionId: this.sessionId,
            status: "complete",
          });
          break;

        case "install_error":
          this.emitMessage({
            type: "install_status",
            sessionId: this.sessionId,
            status: "error",
            command: data.command as string | undefined,
            message: (data.message as string) ?? "Install failed",
          });
          break;

        // --- File watcher events ---

        case "file_changes": {
          const paths = (data.paths as string[]) ?? [];
          this.emitMessage({ type: "files_changed", paths } as WsServerMessage);

          // Detect config file changes and trigger compose reconciliation
          const hasConfigChange = paths.some(p =>
            ContainerSessionRunner.CONFIG_FILES.has(p) ||
            ContainerSessionRunner.CONFIG_FILES.has(p.replace(/^\.\//, "")),
          );
          if (hasConfigChange) {
            if (this._serviceManager?.started) {
              console.log(`[container-runner:${this.sessionId}] Config file changed, reconciling compose stack`);
              this._serviceManager.reconcile().catch((err: unknown) => {
                console.error(`[container-runner:${this.sessionId}] Compose reconcile failed:`, err);
              });
            } else if (this._serviceManager && !this._serviceManager.started) {
              // ServiceManager exists but start() failed (e.g. compose file
              // was missing when shipit.yaml was written first) — retry
              console.log(`[container-runner:${this.sessionId}] Config file changed, retrying compose start`);
              this._serviceManager.reconcile().catch((err: unknown) => {
                console.error(`[container-runner:${this.sessionId}] Compose retry failed:`, err);
              });
            } else if (!this._serviceManager && this.onComposeConfigChanged) {
              // No ServiceManager yet (e.g. old-format config was just migrated)
              // — re-evaluate the config and set up compose if now available
              console.log(`[container-runner:${this.sessionId}] Config file changed, attempting compose setup`);
              this.onComposeConfigChanged();
            }
          }
          break;
        }
      }
    } catch (err) {
      console.error(`[container-runner:${this.sessionId}] Failed to parse SSE event:`, err);
    }
  }

  // --- Service control request handling ---

  /**
   * Handle a service control request from the agent (received via SSE from the worker).
   * Performs the action via ServiceManager and POSTs the result back to the worker.
   */
  private async handleServiceRequest(requestId: string, action: string, name?: string): Promise<void> {
    let result: unknown;
    let error: string | undefined;

    try {
      const mgr = this._serviceManager;
      if (!mgr) {
        throw new Error("No compose stack configured for this session");
      }

      switch (action) {
        case "list":
          result = {
            services: mgr.getServices().map(s => ({
              name: s.name,
              status: s.status,
              port: s.port,
              preview: s.preview,
              error: s.error,
            })),
          };
          break;
        case "start":
          if (!name) throw new Error("Service name is required");
          await mgr.startService(name);
          result = { ok: true, name, status: "running" };
          break;
        case "stop":
          if (!name) throw new Error("Service name is required");
          await mgr.stopService(name);
          result = { ok: true, name, status: "stopped" };
          break;
        case "restart":
          if (!name) throw new Error("Service name is required");
          await mgr.restartService(name);
          result = { ok: true, name, status: "running" };
          break;
        default:
          throw new Error(`Unknown service action: ${action}`);
      }
    } catch (err) {
      error = (err as Error).message;
    }

    // POST result back to the worker's callback endpoint
    try {
      await workerPost(this.workerUrl, "/services/_callback", { requestId, result, error });
    } catch (err) {
      console.error(`[container-runner:${this.sessionId}] Failed to send service callback:`, (err as Error).message);
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
  }

  /**
   * Reconcile the local `_isRunning` flag with the worker's actual agent
   * state. Returns `true` if the agent is genuinely running, `false`
   * otherwise.
   *
   * Without this safety net, a missed `agent_done` SSE event (e.g. due to
   * an SSE drop at the wrong moment, a container restart, or a /agent/kill
   * race that bypasses the event broadcast) leaves `_isRunning` stuck
   * `true` forever. The next `send_message` would then be queued
   * indefinitely, and the user sees the symptom: "agent starts only
   * briefly, nothing happens".
   *
   * If the worker reports no agent is running but `_isRunning` is true
   * locally, reset the flag, clear the agent reference, emit a recovery
   * `session_status` message, and signal idle so the runner is reclaimable.
   */
  async verifyRunningState(): Promise<boolean> {
    if (!this._isRunning) return false;
    let workerRunning: boolean;
    try {
      const status = await workerGet(this.workerUrl, "/agent/status") as { running?: boolean };
      workerRunning = status.running === true;
    } catch (err) {
      // Worker unreachable — keep the local flag and let the SSE reconnect
      // logic recover. We can't safely declare the agent dead from here.
      console.warn(`[container-runner:${this.sessionId}] verifyRunningState: worker unreachable, keeping running=true`, err);
      return this._isRunning;
    }
    if (workerRunning) return true;
    console.warn(`[container-runner:${this.sessionId}] Detected stuck running=true (worker reports no agent). Resetting.`);
    this._isRunning = false;
    this._agent = null;
    this.emitMessage({
      type: "session_status",
      sessionId: this.sessionId,
      running: false,
      queueLength: this.queueLength,
      error: "Agent state was out of sync with the worker — reset. You can send a new message.",
    });
    this.emit("idle");
    return false;
  }

  get disposed(): boolean { return this._disposed; }

  dispose(opts?: { force?: boolean }): void {
    if (this._disposed) return;
    // Defensive: refuse to dispose a runner whose agent is currently running
    // unless the caller explicitly forces it. This guarantees that lifecycle
    // events (idle cleanup, transient WebSocket disconnects) never kill a
    // running agent on the worker. Shutdown / full-reset paths pass
    // `{ force: true }` to override.
    if (this._isRunning && !opts?.force) {
      console.log(`[container-runner:${this.sessionId}] dispose() skipped — agent is running`);
      return;
    }
    this._disposed = true;

    // Kill agent on worker (fire and forget)
    if (this._agent) {
      workerPost(this.workerUrl, "/agent/kill").catch(() => {});
      this._agent = null;
    }

    // Don't stop worker resources (preview, file watcher) — the container
    // stays alive and a new runner may reconnect to it. Stopping the preview
    // would force a full restart on reconnect.

    this.clearServiceManager();
    this.disconnectEventStream();
    this.clearPushTimer();
    this._messageQueue.length = 0;
    this._turnEventBuffer = [];
    this._isRunning = false;
    this._remoteTerminalRunning = false;
    this.emit("disposed");
    this.removeAllListeners();
  }
}
