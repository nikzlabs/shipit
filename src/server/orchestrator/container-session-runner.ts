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
import { workerPost, workerGet, workerInstall, workerPushAgentSecrets } from "./worker-http.js";
import { truncateTerminalBuffer } from "./terminal-buffer.js";
import { ProxyAgentProcess } from "./proxy-agent-process.js";
import type { ProxyAgentRunner } from "./proxy-agent-process.js";
import type { ServiceManager, ManagedService, SecretsStatusInternalSnapshot } from "./service-manager.js";

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
  /**
   * Idle timeout for the SSE stream. The worker sends a keepalive
   * comment every 15s (`session-worker.ts`); we treat ≥3 missed
   * keepalives (45s) as a silently-dead connection and force a
   * reconnect. Without this, half-open TCP sockets (NAT idle drops,
   * frozen worker processes) appear "connected" indefinitely and the
   * agent / terminal / preview surfaces freeze with no recovery.
   */
  private static readonly SSE_IDLE_TIMEOUT_MS = 45_000;
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

  // Auto-push timer
  private _pushTimer: ReturnType<typeof setTimeout> | null = null;

  // Turn event buffer
  private _turnEventBuffer: WsServerMessage[] = [];
  private static readonly MAX_TURN_BUFFER = 1000;
  lastPersistedBufferIndex = 0;

  // Viewer tracking
  private _viewerCount = 0;
  private _lastViewerDetachAt = 0;

  /**
   * Periodic reconciler — checks `runner.running` against `/agent/status`
   * while a viewer is attached. After 2 consecutive divergences (running=true
   * locally but worker reports idle), `verifyRunningState()` resets the flag
   * and emits a `session_status` notice. Set up in `attachViewer`, cleared
   * in `dispose`.
   */
  private _reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private _reconcileDivergenceCount = 0;
  private static readonly RECONCILE_INTERVAL_MS = 30000;
  private static readonly RECONCILE_MAX_DIVERGENCES = 2;

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

  /**
   * When `true`, the runner's "disposed" lifecycle hook in
   * `app-lifecycle.ts` will NOT stop the compose stack or evict the
   * ServiceManager from the per-app `serviceManagers` map. The next
   * `setupServiceManager(newRunner)` call adopts the orphaned manager
   * via `runner.setServiceManager(existing)`.
   *
   * Set by the `restartAgent` recovery flow (see docs/127-restart-agent),
   * which destroys+recreates the agent container while leaving the
   * compose stack untouched. Default `false` — Rescue session, idle
   * eviction, shutdown, and full-reset all keep the previous behavior
   * of tearing down compose when the runner is disposed.
   */
  preserveComposeOnDispose = false;

  /**
   * When `true`, the disposed-handler in `setupServiceManager` /
   * `adoptExistingServiceManager` passes `removeVolumes: true` to the
   * compose-stop call, dropping per-session named volumes (user-declared
   * `node_modules` caches, etc.) along with the containers.
   *
   * Set by archive / full-reset paths that genuinely want to reclaim the
   * disk those volumes occupy. The default `false` keeps the stop "safe":
   * idle eviction, restartAgent recovery, and reconciles can resume
   * without losing build state. See `disk-janitor.ts` for the orthogonal
   * pass that prunes orphaned volumes at orchestrator startup (handles
   * the case where the runner was already disposed by idle eviction
   * before archive ran, so the flag never had a chance to fire).
   */
  removeVolumesOnDispose = false;

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

  /**
   * Resolves once the underlying container has a real worker URL — i.e.
   * the container has been created and its IP resolved. For runners
   * constructed without the placeholder URL, resolves immediately.
   *
   * Exposed so external lifecycle code (e.g. `adoptExistingServiceManager`
   * in app-lifecycle.ts) can defer container-dependent operations like
   * `connectToNetwork` until the container actually exists, instead of
   * firing them synchronously after `getOrCreate` returns.
   */
  whenWorkerReady(): Promise<void> {
    return this._workerReady;
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

  /**
   * Collect ports from all running preview-eligible services.
   *
   * Both `auto` and `manual` modes contribute once the service is running:
   * `auto` services are surfaced automatically when they come up, and
   * `manual` services are surfaced once the user explicitly starts them
   * (the click is the opt-in). Without including `manual` here, starting
   * a manual-only service like the dogfood `dev` stack leaves the preview
   * pane stuck on "No preview running" because no port ever enters the
   * detected-ports list.
   */
  private buildDetectedPortsFromServices(mgr: ServiceManager): number[] {
    return mgr.getServices()
      .filter(s => (s.preview === "auto" || s.preview === "manual") && s.status === "running" && s.port)
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

      // When a preview-eligible service changes status, recalculate detected
      // ports and emit preview_status so the client reflects the real state
      // (e.g. green dot → error when a container crashes, or "No preview
      // running" → live iframe when the user starts a manual service like
      // the dogfood `dev` stack).
      if (svc.preview === "auto" || svc.preview === "manual") {
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

    const onSecretsStatus = (snapshot: SecretsStatusInternalSnapshot) => {
      this.emitMessage({
        type: "secrets_status",
        sessionId: this.sessionId,
        declared: snapshot.declared,
        missingByService: snapshot.missingByService,
        missingRequired: snapshot.missingRequired,
      } as WsServerMessage);

      // Phase 3: also push the resolved `agent: true` values into the
      // session worker's process.env so the next agent turn (and any
      // bash/test/codegen commands it spawns) can read them. Fire-and-forget;
      // the worker may not be up yet on the very first compose start, in
      // which case we skip. The worker's `_workerReady` promise covers the
      // legitimate "container booting" case — past that, transient failures
      // are logged but never block the user-facing save.
      void this.tryPushAgentSecrets(snapshot.agentValues);
    };

    mgr.on("service_status", onStatus);
    mgr.on("service_log", onLog);
    mgr.on("stack_ready", onReady);
    mgr.on("secrets_status", onSecretsStatus);

    this._serviceManagerListeners = [
      () => mgr.off("service_status", onStatus),
      () => mgr.off("service_log", onLog),
      () => mgr.off("stack_ready", onReady),
      () => mgr.off("secrets_status", onSecretsStatus),
    ];

    // Replay current secrets snapshot on attach so a viewer that connects
    // after `syncSecrets()` already ran still sees the banner / panel state.
    // Also covers the bootstrap case: ServiceManager.start() emits
    // `secrets_status` synchronously inside `syncSecrets()`, which can fire
    // BEFORE the runner attached, so the snapshot is the only way to push
    // initial agent values into the worker.
    const snap = mgr.getSecretsSnapshot();
    if (
      snap.declared.length > 0
      || snap.missingRequired.length > 0
      || snap.agentNames.length > 0
    ) {
      onSecretsStatus(snap);
    }
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
    // Clear the detach timestamp on any attach — a viewer is back, and the
    // grace period only matters when no viewers are attached. If viewers
    // come and go later, the timestamp will be re-armed only when the LAST
    // one detaches (see detachViewer() below).
    this._lastViewerDetachAt = 0;
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
    this.startReconcileTimer();
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
      this.stopReconcileTimer();
    }
    // Don't stop worker resources or SSE — the container keeps running and
    // the viewer may reattach quickly (session switching). Cleanup happens
    // in dispose() when the runner is actually torn down.
  }

  /**
   * Start the periodic reconciler that catches "spinner stuck on" states
   * where the local `running=true` flag has drifted from the worker's
   * actual idle status. Idempotent — safe to call repeatedly.
   */
  private startReconcileTimer(): void {
    if (this._reconcileTimer || this._disposed) return;
    this._reconcileDivergenceCount = 0;
    this._reconcileTimer = setInterval(() => {
      void this.runReconcileCheck();
    }, ContainerSessionRunner.RECONCILE_INTERVAL_MS);
    // Don't keep the orchestrator alive for the timer alone.
    this._reconcileTimer.unref?.();
  }

  private stopReconcileTimer(): void {
    if (this._reconcileTimer) {
      clearInterval(this._reconcileTimer);
      this._reconcileTimer = null;
    }
    this._reconcileDivergenceCount = 0;
  }

  /**
   * One tick of the reconciler. Only meaningful when `running=true` and a
   * viewer is attached — otherwise the divergence is either expected
   * (idle) or undetectable (no viewer means no reconnect-driven recovery
   * to short-circuit). Two consecutive divergences are required so a
   * single in-flight `/agent/status` race can't trigger a false reset.
   */
  private async runReconcileCheck(): Promise<void> {
    if (this._disposed) {
      this.stopReconcileTimer();
      return;
    }
    if (!this._isRunning || this._viewerCount === 0) {
      this._reconcileDivergenceCount = 0;
      return;
    }
    let workerRunning: boolean | null = null;
    try {
      const status = await workerGet(this.workerUrl, "/agent/status") as { running?: boolean };
      workerRunning = status.running === true;
    } catch {
      // Worker unreachable — don't penalize on a transient failure.
      return;
    }
    if (workerRunning) {
      this._reconcileDivergenceCount = 0;
      return;
    }
    this._reconcileDivergenceCount += 1;
    if (this._reconcileDivergenceCount >= ContainerSessionRunner.RECONCILE_MAX_DIVERGENCES) {
      this._reconcileDivergenceCount = 0;
      await this.verifyRunningState();
    }
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
   *
   * The HTTP call is deliberately unbounded (`timeoutMs: 0`). The worker
   * accepts /agent/start synchronously, spawns the CLI, and returns
   * `{ started: true }` — but in practice the agent has already started
   * streaming events over SSE by the time the ack arrives. A slow ack
   * (busy worker event loop, head-of-line blocking on the keep-alive
   * connection, etc.) is NOT a failure mode worth surfacing as
   * "container unreachable" to the user, because the agent is already
   * running and the in-progress chat-history clear that the error path
   * would trigger destroys the visible turn. Worker liveness is
   * monitored separately via the SSE idle timer; if the worker is
   * genuinely dead, the SSE stream fails and the Rescue-session UI
   * surfaces it. (Refines doc 124 §1.3.)
   */
  async _startAgentViaProxy(agentId: AgentId, params: AgentRunParams): Promise<void> {
    await this._workerReady;
    await this._waitForInstallBeforeAgent();
    try {
      await workerPost(this.workerUrl, "/agent/start", { agentId, params }, { timeoutMs: 0 });
    } catch (err) {
      // Narrow race: the previous turn's `agent_done` SSE event reaches the
      // orchestrator and triggers the queue drain → new POST /agent/start —
      // but the worker hasn't yet executed `this.agent = null` in its own
      // `agent.on("done")` handler (session-worker.ts wireAgentEvents). The
      // worker rejects with 409 "Agent already running". The window is
      // microseconds wide; one short retry clears it. If the second attempt
      // also 409s, that's a genuine duplicate-start bug — re-throw so the
      // agent's error handler runs (and the drain-on-error path in
      // agent-listeners.ts keeps the queue flowing).
      if (err instanceof Error && err.message === "Agent already running") {
        await new Promise((r) => setTimeout(r, 150));
        await workerPost(this.workerUrl, "/agent/start", { agentId, params }, { timeoutMs: 0 });
      } else {
        throw err;
      }
    }
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
    await this._waitForInstallBeforeAgent();
    const proxy = new ProxyAgentProcess(agentId, this);
    this._agent = proxy;

    await workerPost(this.workerUrl, "/agent/start", { agentId, params }, { timeoutMs: 0 });

    // Ensure SSE is connected to receive events
    if (!this.sseConnection) {
      await this.connectEventStream();
    }

    return proxy;
  }

  /**
   * Block the agent CLI start on any in-flight `agent.install`. Without
   * this gate, `npm install` (or whatever the agent.install command set
   * declares) and the agent CLI compete for memory inside the agent
   * container's cgroup. In production this caused OOM kills during the
   * first turn of a fresh session for repos with heavy install
   * footprints (e.g. ShipIt itself dogfooding ShipIt): kernel OOM-killer
   * recorded `npm install` ~650 MB RSS + claude ~243 MB + 3 node main
   * threads ~330 MB combined inside a 3 GiB cgroup, with V8Worker
   * triggering the kill. See docs/124-session-rescue-and-diagnostics
   * follow-up.
   *
   * Trade-off: the first user turn is delayed by however long install
   * takes. The user already sees `install_status: running` in the UI
   * (emitted by `runInstall`), so the wait is explained — and the cost
   * of this delay is bounded, while the OOM-recreate loop's cost is
   * not. No-op when no install was scheduled.
   */
  private async _waitForInstallBeforeAgent(): Promise<void> {
    if (this._installComplete) {
      await this._installComplete;
    }
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

  /**
   * Proxy an MCP connectivity test to the session worker (docs/088). The
   * worker spawns the configured stdio server (or opens the HTTP connection),
   * calls `tools/list`, and tears the connection down. 30s timeout — matches
   * the worker-side cap. The worker resolves `$secret:` placeholders against
   * its own `process.env`, so the orchestrator never handles raw values here.
   */
  async proxyMcpTest(config: unknown): Promise<unknown> {
    await this._workerReady;
    return workerPost(this.workerUrl, "/mcp/test", { config }, { timeoutMs: 30_000 });
  }

  /** Install MCP server npm packages on the worker (docs/088). */
  async installMcpPackages(packages: string[]): Promise<unknown> {
    await this._workerReady;
    return workerPost(this.workerUrl, "/mcp/install", { packages });
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
   * Resolver for the in-flight install promise — fulfilled when the worker
   * SSE stream delivers `install_done` or `install_error`, or when the
   * worker reports the install was skipped (marker present).
   */
  private _installComplete: Promise<void> | null = null;
  private _resolveInstallComplete: (() => void) | null = null;
  /**
   * True while the orchestrator believes an install is in flight on the
   * worker. Used by the SSE reconnect path: if our SSE stream drops between
   * `install_status: running` and the worker emitting `install_done`, the
   * completion event would be silently lost. On reconnect we re-poll the
   * worker's install state via `/install/status` and synthesize a completion.
   */
  private _installInFlight = false;

  /**
   * Run agent.install commands on the session worker. Returns a promise that
   * resolves when the install is fully complete — success, error, or skipped.
   * Progress streams via SSE events to attached viewers.
   *
   * The returned promise is what the orchestrator awaits to bracket the
   * `ServiceManager.setInstallRunning(true|false)` window so dev servers
   * that race install (deps still extracting) get retried instead of
   * latching to `error`.
   *
   * Idempotent under concurrent callers: if a previous `runInstall` is still
   * awaiting completion, a second call short-circuits onto the same promise
   * instead of resetting `_resolveInstallComplete` (which would orphan the
   * first call's resolver and leak a never-resolving promise).
   */
  async runInstall(commands: string[]): Promise<void> {
    if (commands.length === 0) return;

    // Concurrent-call guard: if an install is already in flight (either we
    // armed `_installComplete` and haven't resolved yet, or the worker is
    // still running its commands), join that in-flight promise rather than
    // starting a new one. Prevents the orphaned-resolver leak that left the
    // ServiceManager's `installRunning` gate stuck open.
    //
    // The promise is set up SYNCHRONOUSLY before any `await` so a second
    // caller kicked off in the same tick takes the join branch instead of
    // also slipping past the guard while we're still awaiting `_workerReady`.
    if (this._installComplete) {
      await this._installComplete;
      return;
    }
    this._installComplete = new Promise<void>((resolve) => {
      this._resolveInstallComplete = resolve;
    });
    this._installInFlight = true;

    await this._workerReady;
    if (this._disposed) {
      this.signalInstallComplete();
      return;
    }

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
        this.signalInstallComplete();
        return;
      }
      // Started — wait for SSE-delivered install_done / install_error.
      await this._installComplete;
    } catch (err) {
      this.emitMessage({
        type: "install_status",
        sessionId: this.sessionId,
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      this.signalInstallComplete();
    }
  }

  /** Resolve the in-flight install promise (idempotent). */
  private signalInstallComplete(): void {
    this._installInFlight = false;
    if (this._resolveInstallComplete) {
      const r = this._resolveInstallComplete;
      this._resolveInstallComplete = null;
      r();
    }
    this._installComplete = null;
  }

  /**
   * After an SSE reconnect, re-poll the worker for its current install
   * state. If the worker finished install while we were disconnected, we
   * never received the `install_done`/`install_error` event — synthesize
   * the completion locally so a) the awaiting `runInstall` resolves and
   * b) the client gets the terminal `install_status` it would have seen.
   *
   * No-op when no install was in flight from our POV (avoids double-emitting
   * for the steady-state reconnect-during-idle case).
   */
  private async resyncInstallStateAfterReconnect(): Promise<void> {
    if (!this._installInFlight || this._disposed) return;
    let status: { running?: boolean; lastResult?: { ok: boolean; message?: string; command?: string } };
    try {
      status = await workerGet(this.workerUrl, "/install/status") as typeof status;
    } catch (err) {
      // Worker still wedged or endpoint missing — leave the install gate
      // open; if SSE reconnects again we'll re-try this resync.
      console.warn(
        `[container-runner:${this.sessionId}] /install/status probe failed:`,
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
    if (status.running) return; // still installing — wait for the real event
    const last = status.lastResult;
    if (!last) {
      // Install isn't running and there's no last result — likely the worker
      // restarted (lost the in-memory `_lastInstallResult`). We can't tell
      // success from failure; mark it complete so the orchestrator un-wedges
      // and let auto-retry on the next session activation re-run install.
      this.emitMessage({
        type: "install_status",
        sessionId: this.sessionId,
        status: "complete",
      });
      this.signalInstallComplete();
      return;
    }
    if (last.ok) {
      this.emitMessage({
        type: "install_status",
        sessionId: this.sessionId,
        status: "complete",
      });
    } else {
      this.emitMessage({
        type: "install_status",
        sessionId: this.sessionId,
        status: "error",
        command: last.command,
        message: last.message ?? "Install failed",
      });
    }
    this.signalInstallComplete();
  }

  /**
   * Push the full set of `agent: true` secret values to the worker's
   * `process.env`. Phase 3 (087).
   *
   * Awaits `_workerReady` so the call doesn't race container startup, then
   * fire-and-forgets — a transient HTTP failure is logged but never blocks
   * the user-facing save. The worker REPLACES (not patches) its tracked
   * set on every call, so a name removed from `agentValues` since the last
   * push is unset on the next call.
   *
   * Empty `agentValues` triggers a push with `{}` — that explicitly clears
   * any previously-injected names from process.env.
   *
   * Public so the per-turn agent-start path (docs/088) can await it for
   * compose-less sessions, which never get a `ServiceManager` and so never
   * reach the `secrets_status`-driven push above. Because the worker
   * REPLACES its tracked set, callers MUST pass the *full* account-level
   * agent env — never a partial subset — or previously-pushed keys are
   * silently unset.
   */
  async tryPushAgentSecrets(agentValues: Record<string, string>): Promise<void> {
    if (this._disposed) return;
    try {
      await this._workerReady;
    } catch {
      return; // worker never came up — nothing to push
    }
    if (this._disposed) return;
    try {
      await workerPushAgentSecrets(this.workerUrl, agentValues);
    } catch (err) {
      // Non-fatal — secrets just won't be present in this turn's env. The
      // next compose reconcile / refreshSecrets() retries.
      console.warn(
        `[runner:${this.sessionId}] pushAgentSecrets failed:`,
        err instanceof Error ? err.message : String(err),
      );
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
        // On reconnect with an in-flight install, re-poll worker for the
        // current install state — if the worker fired install_done while
        // SSE was disconnected, that event was lost and the orchestrator's
        // install promise would hang forever otherwise.
        if (isReconnect && this._installInFlight) {
          void this.resyncInstallStateAfterReconnect();
        }
      },
      {
        idleTimeoutMs: ContainerSessionRunner.SSE_IDLE_TIMEOUT_MS,
        // Advance the liveness gauge on every byte from the worker,
        // including keepalive comments. `handleSSEEvent` updates this
        // too; keeping both write paths means the gauge reflects
        // connection health (not just "agent emitted something").
        onActivity: () => { this._lastSseEventAt = Date.now(); },
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
          this.signalInstallComplete();
          break;

        case "install_error":
          this.emitMessage({
            type: "install_status",
            sessionId: this.sessionId,
            status: "error",
            command: data.command as string | undefined,
            message: (data.message as string) ?? "Install failed",
          });
          this.signalInstallComplete();
          break;

        // --- MCP server status (docs/088) ---

        case "mcp_server_status": {
          const status = data as { name?: string; state?: string; reason?: string };
          if (typeof status.name === "string" && typeof status.state === "string") {
            this.emitMessage({
              type: "mcp_server_status",
              sessionId: this.sessionId,
              name: status.name,
              state: status.state as "loaded" | "failed" | "crashed" | "disabled",
              reason: status.reason,
            } as WsServerMessage);
          }
          break;
        }

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
    // Diagnostic: log caller. Field reports show runners being disposed
    // without any of the known dispose-path log prefixes appearing.
    // Field-only; remove once docs/124 follow-up SIGTERM-loop is resolved.
    const stack = new Error("ContainerSessionRunner.dispose caller").stack;
    console.warn(`[container-runner:${this.sessionId}] dispose(force=${opts?.force ?? false}) called from:\n${stack}`);
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

    this.stopReconcileTimer();
    this.clearServiceManager();
    this.disconnectEventStream();
    this.clearPushTimer();
    // Resolve any awaiters of in-flight install so they don't leak.
    this.signalInstallComplete();
    // Resolve `_workerReady` so any `whenWorkerReady().then(...)` chain
    // pending against a placeholder-URL runner doesn't leak when the
    // container creation fails before `setWorkerUrl()` ever fires. The
    // chained `.then` will run with no meaningful worker — that's fine:
    // its callers (e.g. `adoptExistingServiceManager`'s connectToNetwork)
    // will hit "No container found" and the `.catch` handles it.
    this._resolveWorkerReady();
    // Same defense for `_sseConnected`: if dispose runs before the SSE
    // stream actually opens, any `connectEventStream()` awaiter would
    // otherwise hang forever. Resolving here is safe — awaiters that
    // proceed past it check `this._disposed` and bail.
    if (this._resolveSseConnected) {
      this._resolveSseConnected();
      this._resolveSseConnected = null;
    }
    this._messageQueue.length = 0;
    this._turnEventBuffer = [];
    this._isRunning = false;
    this._remoteTerminalRunning = false;
    this.emit("disposed");
    this.removeAllListeners();
  }
}
