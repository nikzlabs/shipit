import type { ProviderRouteKind } from "../shared/types/domain-types/provider.js";
import { EventEmitter } from "node:events";
import type { AgentProcess, AgentId, AgentEvent, AgentRunParams, TerminalProcess, WorkerAgentStatus } from "../shared/types.js";
import type { WsServerMessage, ClaudeContentBlockToolUse, SkillInfo, PermissionMode, PermissionDecision } from "../shared/types.js";
import type { PresentStateEntry } from "../shared/types/ws-server-messages.js";
import type { PresentStore } from "./present-store.js";
import { emitChatCard, type InProgressPersister } from "./chat-card-persistence.js";
import type { SessionRunnerInterface, SessionRunnerEvents, QueuedMessage, SystemTurnDeps, ChatMessageGroup, SteeredMessage, RecordedChatCard } from "./session-runner.js";
import type { SubAgentSpawnRequest, SubAgentRunResult } from "../shared/sub-agent-run.js";
import { SUB_AGENT_TRANSPORT_TIMEOUT_MS } from "../shared/sub-agent-run.js";
import { AgentTurnAdmissionError, runDispatchedTurn, dispatchOnRunner } from "./session-runner.js";
import { releaseQueuedTurn } from "./queue-drain.js";
import type { PreparedDispatch } from "./prepared-dispatch.js";
import type { TurnHandle } from "./turn-settlement.js";
import type { SSEEvent } from "./sse-client.js";
import { workerPost, workerGet, workerInstall, workerPushAgentSecrets, workerPostMessage, PLACEHOLDER_WORKER_URL, WorkerUnavailableError } from "./worker-http.js";
import { ProxyAgentProcess } from "./proxy-agent-process.js";
import type { ProxyAgentRunner } from "./proxy-agent-process.js";
import { adoptInFlightTurn } from "./turn-adoption.js";
import { originView, type ServiceManager, type ManagedService, type SecretsStatusInternalSnapshot } from "./service-manager.js";
import { stripAnsi } from "../shared/strip-ansi.js";
import { SseConnectionManager } from "./sse-connection-manager.js";
import { BackgroundTaskTracker, type BackgroundTaskInfo } from "./background-task-tracker.js";
import { PostTurnHold } from "./post-turn-hold.js";
import { getAgentDisplayName } from "../shared/agent-registry.js";
import { TurnAccumulator } from "./turn-accumulator.js";
import type { CommittedBodyIds } from "./transcript-projection.js";
import { TerminalBufferManager } from "./terminal-buffer-manager.js";
import { stopTokenWriteBackWatch } from "./session-token-publisher.js";
import { beginContainerPrepare, readPrepareFailures } from "./services/plugin-activation.js";
import {
  dependencyGapNotice,
  dependencyGapSummary,
  type DependencyGap,
} from "./dependency-staleness.js";

export { connectSSE } from "./sse-client.js";
export type { SSEEvent } from "./sse-client.js";
export { workerPost, workerGet, workerInstall, PLACEHOLDER_WORKER_URL, WorkerUnavailableError } from "./worker-http.js";
export { truncateTerminalBuffer } from "./terminal-buffer.js";
export { ProxyAgentProcess } from "./proxy-agent-process.js";
export type { ProxyAgentRunner } from "./proxy-agent-process.js";

// Bounds POST acceptance; install completion arrives separately over SSE.
const INSTALL_POST_TIMEOUT_MS = 180_000;

const PLUGIN_PREPARE_TIMEOUT_MS = 30_000;

// Recovers lost completion events. The install itself has no deadline.
const INSTALL_STATUS_PROBE_INTERVAL_MS = 30_000;

export interface InstallCompletion {
  ok: boolean;
  /** True when `ok` was synthesized rather than observed. Never proof. */
  unverified?: boolean;
}

export class ContainerSessionRunner extends EventEmitter<SessionRunnerEvents> implements SessionRunnerInterface, ProxyAgentRunner {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly supportsRemoteTerminal = true;

  private workerUrl: string;
  private _workerReady: Promise<void>;
  private _resolveWorkerReady!: () => void;

  // Set before disposal resolves the ready gate, so awaiters receive the real failure.
  private _workerUnavailableReason: string | null = null;

  private sse: SseConnectionManager;
  private turn = new TurnAccumulator();
  private termBuf = new TerminalBufferManager();

  private _agent: ProxyAgentProcess | null = null;
  private _agentId: AgentId;
  private _isRunning = false;
  private _systemTurnInProgress = false;
  private _mergeHold = false;
  private _wasInterrupted = false;
  turnEpoch = 0;
  private _lastTurnErrored = false;
  private _guardedUnavailable = false;
  readonly awaitingPermissionIds = new Set<string>();
  private _isStreamingActive = false;
  private _backgroundTasks = new BackgroundTaskTracker();
  // Retain the resident proxy when a one-shot process displaces `_agent`.
  private _streamingProxy: ProxyAgentProcess | null = null;
  private _appliedPermissionMode: PermissionMode | undefined = undefined;
  private _appliedSpawnIdentity: string | undefined = undefined;
  private _residentRoute: { kind: ProviderRouteKind; id: string } | undefined = undefined;

  // Serialize starts with kill/restart recovery.
  private _startInFlight: Promise<void> = Promise.resolve();

  private _terminal: TerminalProcess | null = null;

  private _viewerCount = 0;
  private _lastViewerDetachAt = 0;

  private _reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private _reconcileDivergenceCount = 0;
  // Count divergences only while running/turnEpoch remain unchanged.
  private _reconcileShape = "";
  private static readonly RECONCILE_INTERVAL_MS = 30000;
  private static readonly RECONCILE_MAX_DIVERGENCES = 2;

  private _detectedPorts: number[] = [];

  private _presentations: PresentStateEntry[] = [];

  private readonly _presentStore: PresentStore | undefined;

  // Without persistence, skip inline cards rather than emit cards that disappear on reload.
  private readonly _chatHistoryManager: InProgressPersister | undefined;

  private _serviceManager: ServiceManager | null = null;
  private _serviceManagerListeners: (() => void)[] = [];
  /** Called when config files change and no ServiceManager exists (e.g. after migration). */
  onComposeConfigChanged?: () => void;
  rerunServiceSetup?: () => void;

  onDependenciesUnverified?: (message: string) => void;

  // Agent restart leaves the stack for the replacement runner to adopt.
  preserveComposeOnDispose = false;

  // Archive/full reset removes volumes; routine disposal preserves build state.
  removeVolumesOnDispose = false;

  // Needed before a ServiceManager exists; isConfigFileChange also checks its configured path.
  private static readonly CONFIG_FILES = new Set([
    "shipit.yaml",
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml",
  ]);

  // Coalesce lockfile changes, including install's own writes, into one trailing reinstall.
  private static readonly DEP_REINSTALL_COOLDOWN_MS = 30_000;

  private _disposed = false;
  pendingCommitLink: { commitHash: string; parentCommitHash: string } | null = null;
  private _subAgentSpawnsThisTurn = 0;
  private readonly _subAgentAborts = new Map<string, { controller: AbortController; agentId: AgentId }>();
  private _lastAnnouncedWork = "[]";
  private readonly _postTurnHold = new PostTurnHold();
  private _workerResourcesStarted = false;
  // All callers await adoption before opening SSE.
  private _workerStartInFlight: Promise<void> | null = null;

  constructor(opts: {
    sessionId: string;
    sessionDir: string;
    defaultAgentId: AgentId;
    workerUrl: string;
    presentStore?: PresentStore;
    chatHistoryManager?: InProgressPersister;
  }) {
    super();
    this.sessionId = opts.sessionId;
    this.sessionDir = opts.sessionDir;
    this._agentId = opts.defaultAgentId;
    this.workerUrl = opts.workerUrl;
    this._presentStore = opts.presentStore;
    this._chatHistoryManager = opts.chatHistoryManager;
    if (this._presentStore) {
      this._presentations = this._presentStore.listForClient(this.sessionId);
    }
    if (opts.workerUrl === PLACEHOLDER_WORKER_URL) {
      this._workerReady = new Promise<void>((resolve) => { this._resolveWorkerReady = resolve; });
    } else {
      this._workerReady = Promise.resolve();
      this._resolveWorkerReady = () => {};
    }

    this.sse = new SseConnectionManager({
      logLabel: `container-runner:${this.sessionId}`,
      getWorkerUrl: () => this.workerUrl,
      workerReady: () => this._workerReady,
      onEvent: (event) => this.handleSSEEvent(event),
      onOpen: (isReconnect) => this.onSseOpen(isReconnect),
      onDisconnect: (attempt) => this.onSseDisconnect(attempt),
      isDisposed: () => this._disposed,
      resourcesStarted: () => this._workerResourcesStarted,
    });
  }

  setWorkerUrl(url: string): void {
    this.workerUrl = url;
    this._workerUnavailableReason = null;
    this._resolveWorkerReady();
    // Restart clears tmpfs plugin links even when persistent generations are unchanged.
    void this.preparePlugins();
  }

  // Registration precedes container creation; the reconciler must not reclaim this gap.
  get awaitingContainer(): boolean {
    return (
      !this._disposed
      && this._workerUnavailableReason === null
      && this.workerUrl === PLACEHOLDER_WORKER_URL
    );
  }

  markWorkerUnavailable(reason: string): void {
    this._workerUnavailableReason = reason;
  }

  private assertWorkerReachable(path: string): void {
    if (this._workerUnavailableReason !== null) {
      throw new WorkerUnavailableError(path, this._workerUnavailableReason);
    }
    if (this.workerUrl === PLACEHOLDER_WORKER_URL) {
      throw new WorkerUnavailableError(path);
    }
  }

  // Disposal also resolves this gate; callers must still check worker availability.
  whenWorkerReady(): Promise<void> {
    return this._workerReady;
  }

  get running(): boolean { return this._isRunning; }
  set running(v: boolean) { this._isRunning = v; }
  get systemTurnInProgress(): boolean { return this._systemTurnInProgress; }
  set systemTurnInProgress(v: boolean) { this._systemTurnInProgress = v; }
  get mergeHold(): boolean { return this._mergeHold; }
  set mergeHold(v: boolean) { this._mergeHold = v; }

  get wasInterrupted(): boolean { return this._wasInterrupted; }
  set wasInterrupted(v: boolean) { this._wasInterrupted = v; }
  get lastTurnErrored(): boolean { return this._lastTurnErrored; }
  set lastTurnErrored(v: boolean) { this._lastTurnErrored = v; }
  get guardedUnavailable(): boolean { return this._guardedUnavailable; }
  set guardedUnavailable(v: boolean) { this._guardedUnavailable = v; }
  get isStreamingActive(): boolean { return this._isStreamingActive; }
  set isStreamingActive(v: boolean) {
    const wasActive = this._isStreamingActive;
    this._isStreamingActive = v;
    if (wasActive && !v) stopTokenWriteBackWatch(this.sessionId);
    this._streamingProxy = v ? this._agent : null;
    this.announceBackgroundWork();
  }
  get backgroundTaskCount(): number { return this._backgroundTasks.count(this._isStreamingActive); }
  get backgroundTaskDescriptions(): string[] { return this._backgroundTasks.descriptions(this._isStreamingActive); }
  // Consults can outlive the resident CLI, so do not gate them on isStreamingActive.
  get subAgentSpawnsInFlight(): number { return this._subAgentAborts.size; }
  get subAgentSpawnLabels(): string[] {
    return [...this._subAgentAborts.values()].map((s) => `${getAgentDisplayName(s.agentId)} consult`);
  }
  get backgroundWorkDescriptions(): string[] {
    return [...this.backgroundTaskDescriptions, ...this.subAgentSpawnLabels];
  }
  get agentBusy(): boolean {
    return this._isRunning
      || this.backgroundTaskCount > 0
      || this.subAgentSpawnsInFlight > 0
      || this._postTurnHold.active
      // dispose() does not check installs; this filter alone cannot prevent a reclaim race.
      || this._installInFlight;
  }
  get postTurnWorkInFlight(): boolean { return this._postTurnHold.active; }
  beginPostTurnWork(): void { this._postTurnHold.begin(); }
  endPostTurnWork(): void { this._postTurnHold.end(); }
  setBackgroundTasks(tasks: BackgroundTaskInfo[]): void {
    this._backgroundTasks.set(tasks);
    this.announceBackgroundWork();
  }
  clearBackgroundTasks(): void {
    this._backgroundTasks.clear();
    this.announceBackgroundWork();
  }
  private announceBackgroundWork(): void {
    const next = JSON.stringify(this.backgroundWorkDescriptions);
    if (next === this._lastAnnouncedWork) return;
    this._lastAnnouncedWork = next;
    this.emit("background_work");
  }
  get appliedPermissionMode(): PermissionMode | undefined { return this._appliedPermissionMode; }
  set appliedPermissionMode(v: PermissionMode | undefined) { this._appliedPermissionMode = v; }
  get appliedSpawnIdentity(): string | undefined { return this._appliedSpawnIdentity; }
  set appliedSpawnIdentity(v: string | undefined) { this._appliedSpawnIdentity = v; }
  get residentRoute(): { kind: ProviderRouteKind; id: string } | undefined { return this._residentRoute; }
  set residentRoute(v: { kind: ProviderRouteKind; id: string } | undefined) { this._residentRoute = v; }

  get accumulatedText(): string { return this.turn.accumulatedText; }
  set accumulatedText(s: string) { this.turn.accumulatedText = s; }

  get accumulatedToolUse(): ClaudeContentBlockToolUse[] { return this.turn.accumulatedToolUse; }
  set accumulatedToolUse(blocks: ClaudeContentBlockToolUse[]) { this.turn.accumulatedToolUse = blocks; }

  get turnSummary(): string { return this.turn.turnSummary; }
  set turnSummary(s: string) { this.turn.turnSummary = s; }

  get chatMessageGroups(): ChatMessageGroup[] { return this.turn.chatMessageGroups; }
  set chatMessageGroups(groups: ChatMessageGroup[]) { this.turn.chatMessageGroups = groups; }

  get needsNewMessageGroup(): boolean { return this.turn.needsNewMessageGroup; }
  set needsNewMessageGroup(v: boolean) { this.turn.needsNewMessageGroup = v; }

  get steeredMessages(): SteeredMessage[] { return this.turn.steeredMessages; }
  set steeredMessages(m: SteeredMessage[]) { this.turn.steeredMessages = m; }

  get recordedCards(): RecordedChatCard[] { return this.turn.recordedCards; }
  set recordedCards(m: RecordedChatCard[]) { this.turn.recordedCards = m; }

  /** Stable reference, mutable contents. */
  get committedBodyIds(): CommittedBodyIds { return this.turn.committedBodyIds; }

  get agentId(): AgentId { return this._agentId; }
  set agentId(id: AgentId) { this._agentId = id; }
  get subAgentSpawnsThisTurn(): number { return this._subAgentSpawnsThisTurn; }
  set subAgentSpawnsThisTurn(n: number) { this._subAgentSpawnsThisTurn = n; }

  // Independent of the primary turn; disposal aborts the request, and transport has its own cap.
  async spawnSubAgent(req: SubAgentSpawnRequest): Promise<SubAgentRunResult> {
    const controller = new AbortController();
    this._subAgentAborts.set(req.spawnId, { controller, agentId: req.agentId });
    this.announceBackgroundWork();
    const startedAt = Date.now();
    console.log(
      `[sub-agent] worker-post session=${this.sessionId} spawn=${req.spawnId} agent=${req.agentId} `
      + `promptBytes=${Buffer.byteLength(req.prompt)} transportTimeoutMs=${SUB_AGENT_TRANSPORT_TIMEOUT_MS}`,
    );
    try {
      const result = await workerPost(
        this.workerUrl,
        "/agent/spawn",
        {
          agentId: req.agentId,
          prompt: req.prompt,
          spawnId: req.spawnId,
          depth: req.depth,
          model: req.model,
          ...(req.serviceRouting !== undefined ? { serviceRouting: req.serviceRouting } : {}),
          ...(req.homeDir !== undefined ? { homeDir: req.homeDir } : {}),
          ...(req.reasoningEffort !== undefined ? { reasoningEffort: req.reasoningEffort } : {}),
          ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
          ...(req.maxOutputChars !== undefined ? { maxOutputChars: req.maxOutputChars } : {}),
        },
        { timeoutMs: SUB_AGENT_TRANSPORT_TIMEOUT_MS, signal: controller.signal },
      );
      const r = result as SubAgentRunResult;
      console.log(
        `[sub-agent] worker-returned session=${this.sessionId} spawn=${req.spawnId} `
        + `status=${r.status} transportMs=${Date.now() - startedAt}`,
      );
      return r;
    } catch (err) {
      console.warn(
        `[sub-agent] worker-failed session=${this.sessionId} spawn=${req.spawnId} `
        + `transportMs=${Date.now() - startedAt}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    } finally {
      this._subAgentAborts.delete(req.spawnId);
      this.announceBackgroundWork();
    }
  }

  private cancelInFlightSubAgents(reason: string): void {
    for (const [spawnId, spawn] of this._subAgentAborts) {
      console.warn(`[sub-agent] cancelled session=${this.sessionId} spawn=${spawnId} by=${reason}`);
      try { spawn.controller.abort(reason); } catch { /* best-effort */ }
    }
    this._subAgentAborts.clear();
    this.announceBackgroundWork();
  }

  getAgent(): AgentProcess | null { return this._agent; }

  // Settle replacements here: the stale-event guard will ignore their later exits.
  // Clearing the slot has separate completion/abandonment signals.
  private supersedeDisplacedAgent(next: ProxyAgentProcess | null): void {
    const previous = this._agent;
    if (!next || !previous || previous === next) return;
    console.warn(
      `[container-runner:${this.sessionId}] agent slot taken by runToken=${next.runToken} `
      + `while runToken=${previous.runToken} was still installed — settling the superseded turn`,
    );
    previous.emit("superseded");
  }

  setAgent(a: AgentProcess | null): void {
    this.supersedeDisplacedAgent(a as ProxyAgentProcess | null);
    this._agent = a as ProxyAgentProcess | null;
    // The resident CLI keeps its spawn settings and token watch across proxy replacement.
    if (a === null && !this._isStreamingActive) {
      this._appliedPermissionMode = undefined;
      this._appliedSpawnIdentity = undefined;
      this._residentRoute = undefined;
      stopTokenWriteBackWatch(this.sessionId);
    }
  }

  get messageQueue(): QueuedMessage[] { return this.turn.messageQueue; }
  get queueLength(): number { return this.turn.queueLength; }
  enqueue(msg: QueuedMessage): number { return this.turn.enqueue(msg); }
  dequeue(): QueuedMessage | undefined { return this.turn.dequeue(); }
  clearQueue(): void { this.turn.clearQueue(); }
  getQueueSnapshot(): { text: string; position: number }[] { return this.turn.getQueueSnapshot(); }

  activeDeliveryId: string | undefined;
  hasDelivery(deliveryId: string): boolean {
    if (this.activeDeliveryId === deliveryId) return true;
    return this.turn.messageQueue.some((m) => m.deliveryId === deliveryId);
  }

  // A resident process reports running between turns; legacy workers lack turnActive.
  async hasTurnInFlight(): Promise<boolean> {
    if (this._isRunning) return true;
    const status = await workerGet(this.workerUrl, "/agent/status", { timeoutMs: 3000 }) as WorkerAgentStatus;
    return status.turnActive ?? status.running;
  }

  getTerminal(): TerminalProcess | null { return this._terminal; }
  setTerminal(t: TerminalProcess | null): void { this._terminal = t; }

  get remoteTerminalRunning(): boolean { return this.termBuf.running; }

  appendTerminalOutput(data: string): void { this.termBuf.append(data); }
  getTerminalOutputBuffer(): string { return this.termBuf.buffer; }
  clearTerminalOutputBuffer(): void { this.termBuf.clear(); }

  getTurnEventBuffer(): WsServerMessage[] { return this.turn.getTurnEventBuffer(); }
  clearTurnEventBuffer(): void { this.turn.clearTurnEventBuffer(); }

  get lastPersistedBufferIndex(): number { return this.turn.lastPersistedBufferIndex; }
  set lastPersistedBufferIndex(v: number) { this.turn.lastPersistedBufferIndex = v; }

  emitMessage(msg: WsServerMessage): void {
    this.turn.pushTurnEvent(msg);
    this.emit("message", msg);
  }

  get detectedPorts(): number[] { return this._detectedPorts; }
  set detectedPorts(ports: number[]) { this._detectedPorts = ports; }

  get presentations(): PresentStateEntry[] { return this._presentations; }

  private cachePresentation(entry: PresentStateEntry): void {
    const existing = this._presentations.findIndex((p) => p.presentId === entry.presentId);
    if (existing >= 0) {
      this._presentations[existing] = entry;
      return;
    }
    this._presentations.push(entry);
  }

  get lastSseEventAt(): number { return this.sse.lastActivityAt; }

  get workerStreamDownSince(): number { return this.sse.streamDownSince; }

  getWorkerUrl(): string { return this.workerUrl; }

  private buildDetectedPortsFromServices(mgr: ServiceManager): number[] {
    return mgr.getServices()
      .filter(s => (s.preview === "auto" || s.preview === "manual") && s.status === "running" && s.port)
      .map(s => s.port!);
  }

  get serviceManager(): ServiceManager | null { return this._serviceManager; }

  setServiceManager(mgr: ServiceManager | null): void {
    this.clearServiceManager();
    if (!mgr) return;
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
        ...(svc.origin ? { origin: originView(svc.origin) } : {}),
      });

      if (svc.preview === "auto" || svc.preview === "manual") {
        this._detectedPorts = this.buildDetectedPortsFromServices(mgr);
        this.emitMessage(this.buildPreviewStatus());
      }
    };

    const onLog = (name: string, text: string) => {
      this.emitMessage({
        type: "log_append",
        channel: `service:${name}`,
        records: [{ ts: new Date().toISOString(), text }],
      });
    };

    const onReady = () => {
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
          ...(s.origin ? { origin: originView(s.origin) } : {}),
        })),
      });

      this._detectedPorts = this.buildDetectedPortsFromServices(mgr);
      this.emitMessage(this.buildPreviewStatus());
    };

    // Failed starts can also rebuild the service map.
    const onStackError = (err: Error) => {
      onReady();
      // The list clears the client's error. Use this event; mgr.startError is written later.
      this.emitMessage({
        type: "compose_error",
        sessionId: this.sessionId,
        message: err instanceof Error ? err.message : String(err),
      });
    };

    const onSecretsStatus = (snapshot: SecretsStatusInternalSnapshot) => {
      this.emitMessage({
        type: "secrets_status",
        sessionId: this.sessionId,
        declared: snapshot.declared,
        missingByService: snapshot.missingByService,
        missingRequired: snapshot.missingRequired,
        plugins: snapshot.plugins,
      });

      void this.tryPushAgentSecrets(snapshot.agentValues);
    };

    mgr.on("service_status", onStatus);
    mgr.on("service_log", onLog);
    mgr.on("stack_ready", onReady);
    mgr.on("stack_error", onStackError);
    mgr.on("secrets_status", onSecretsStatus);

    this._serviceManagerListeners = [
      () => mgr.off("service_status", onStatus),
      () => mgr.off("service_log", onLog),
      () => mgr.off("stack_ready", onReady),
      () => mgr.off("stack_error", onStackError),
      () => mgr.off("secrets_status", onSecretsStatus),
    ];

    // syncSecrets can emit before this runner attaches.
    const snap = mgr.getSecretsSnapshot();
    if (
      snap.declared.length > 0
      || snap.missingRequired.length > 0
      || snap.agentNames.length > 0
    ) {
      onSecretsStatus(snap);
    }
  }

  private clearServiceManager(): void {
    for (const unsub of this._serviceManagerListeners) unsub();
    this._serviceManagerListeners = [];
    this._serviceManager = null;
  }

  private logReconcileError(prefix: string, err: unknown): void {
    const name = err instanceof Error ? err.name : "";
    const message = err instanceof Error ? err.message : String(err);
    if (name === "ComposeValidationError" || name === "YAMLParseError") {
      console.warn(`[container-runner:${this.sessionId}] ${prefix}: ${message}`);
      return;
    }
    console.error(`[container-runner:${this.sessionId}] ${prefix}:`, err);
  }

  get viewerCount(): number { return this._viewerCount; }
  get lastViewerDetachAt(): number { return this._lastViewerDetachAt; }

  attachViewer(): void {
    this._viewerCount++;
    this._lastViewerDetachAt = 0;
    console.log(`[container-runner:${this.sessionId}] attachViewer (count=${this._viewerCount}, disposed=${this._disposed})`);
    void this.ensureWorkerResourcesStarted();
    this.startReconcileTimer();
  }

  detachViewer(): void {
    this._viewerCount = Math.max(0, this._viewerCount - 1);
    if (this._viewerCount === 0 && this._lastViewerDetachAt === 0) {
      this._lastViewerDetachAt = Date.now();
      this.stopReconcileTimer();
    }
    // Viewer loss must not stop worker resources or SSE.
  }

  private startReconcileTimer(): void {
    if (this._reconcileTimer || this._disposed) return;
    this._reconcileDivergenceCount = 0;
    this._reconcileTimer = setInterval(() => {
      void this.runReconcileCheck();
    }, ContainerSessionRunner.RECONCILE_INTERVAL_MS);
    this._reconcileTimer.unref?.();
  }

  private stopReconcileTimer(): void {
    if (this._reconcileTimer) {
      clearInterval(this._reconcileTimer);
      this._reconcileTimer = null;
    }
    this._reconcileDivergenceCount = 0;
  }

  // Reconcile resident processes too: a failed turn can leave stale streaming state.
  private async runReconcileCheck(): Promise<void> {
    if (this._disposed) {
      this.stopReconcileTimer();
      return;
    }
    if ((!this._isRunning && !this._isStreamingActive) || this._viewerCount === 0) {
      this._reconcileDivergenceCount = 0;
      return;
    }
    let workerRunning: boolean;
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
    // An idle-state divergence must not count against a newly starting turn.
    const shape = `${this._isRunning}:${this.turnEpoch}`;
    this._reconcileDivergenceCount = shape === this._reconcileShape
      ? this._reconcileDivergenceCount + 1
      : 1;
    this._reconcileShape = shape;
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

  createAgent(agentId: AgentId, opts?: { runToken?: string; deliveryId?: string }): ProxyAgentProcess {
    const proxy = new ProxyAgentProcess(agentId, this, opts);
    this.supersedeDisplacedAgent(proxy);
    this._agent = proxy;
    return proxy;
  }

  async _startAgentViaProxy(agentId: AgentId, params: AgentRunParams, runToken?: string, deliveryId?: string): Promise<void> {
    const prev = this._startInFlight;
    let release: () => void = () => {};
    this._startInFlight = new Promise<void>((r) => { release = r; });
    try {
      await prev.catch(() => {});
      await this._doStartAgentViaProxy(agentId, params, runToken, deliveryId);
    } finally {
      release();
    }
  }

  private async _doStartAgentViaProxy(agentId: AgentId, params: AgentRunParams, runToken?: string, deliveryId?: string): Promise<void> {
    await this._workerReady;
    this.assertWorkerReachable("/agent/start");

    await this.fastForwardStaleWorkerEventsBeforeFreshStart();

    // Start SSE before waiting for its install-completion event, including without a viewer.
    void this.ensureWorkerResourcesStarted();

    await this._waitForInstallBeforeAgent();

    try {
      await workerPost(this.workerUrl, "/agent/start", { agentId, params, runToken, deliveryId }, { timeoutMs: 0 });
    } catch (err) {
      // Completion can arrive before the worker clears its slot. Retry before clearing it.
      if (err instanceof Error && err.message === "Agent already running") {
        await new Promise((r) => setTimeout(r, 150));
        try {
          await workerPost(this.workerUrl, "/agent/start", { agentId, params, runToken, deliveryId }, { timeoutMs: 0 });
        } catch (retryErr) {
          if (retryErr instanceof Error && retryErr.message === "Agent already running") {
            // Target the resident so a delayed kill cannot hit its replacement.
            let staleResidentToken: string | undefined;
            try {
              const status = await workerGet(this.workerUrl, "/agent/status", { timeoutMs: 3000 }) as WorkerAgentStatus;
              staleResidentToken = status.runToken;
            } catch { /* fall back to the untargeted clear */ }
            await workerPost(
              this.workerUrl,
              "/agent/kill",
              staleResidentToken !== undefined ? { runToken: staleResidentToken } : undefined,
            ).catch(() => { /* may already be gone */ });
            await workerPost(this.workerUrl, "/agent/start", { agentId, params, runToken, deliveryId }, { timeoutMs: 0 });
          } else {
            throw retryErr;
          }
        }
      } else {
        throw err;
      }
    }
  }

  private async fastForwardStaleWorkerEventsBeforeFreshStart(): Promise<void> {
    if (this._workerResourcesStarted || this.sse.isConnected) return;
    try {
      const status = await workerGet(this.workerUrl, "/agent/status", { timeoutMs: 3000 }) as WorkerAgentStatus;
      if (status.turnActive === true) return;
      this.sse.fastForwardLastSeenSeq(status.latestSseSeq ?? 0);
    } catch {
      // Preserve replay on probe failure.
    }
  }

  // Adopt live turns before replay; skip completed turns to avoid persisting them twice.
  private async reconcileWorkerTurnBeforeFirstConnect(): Promise<void> {
    if (this.sse.isConnected) return;
    let status: WorkerAgentStatus;
    try {
      status = await workerGet(this.workerUrl, "/agent/status", { timeoutMs: 3000 }) as WorkerAgentStatus;
    } catch {
      return;
    }

    if (status.turnActive === true && !this._agent && !this._isRunning) {
      if (await this.adoptWorkerTurn(status)) return;
      return;
    }

    if (status.turnActive === true) return;
    // Legacy workers cannot distinguish an active turn from an idle resident process.
    if (status.turnActive === undefined && status.running) return;

    this.sse.fastForwardLastSeenSeq(status.latestSseSeq ?? 0);
  }

  private async adoptWorkerTurn(status: WorkerAgentStatus): Promise<boolean> {
    const deps = this._systemTurnDeps;
    if (!deps) {
      console.warn(
        `[container-runner:${this.sessionId}] worker reports a live turn but no system-turn deps are wired — not adopting`,
      );
      return false;
    }
    const agentId = status.agentId ?? this._agentId;
    const turnStartSeq = status.turnStartSseSeq ?? 0;
    const oldest = status.oldestSseSeq ?? 0;
    const truncated = oldest > turnStartSeq + 1;
    const delivery = status.deliveryId !== undefined ? `, delivery=${status.deliveryId}` : "";
    console.log(
      `[container-runner:${this.sessionId}] adopting in-flight worker turn ` +
        `(agent=${agentId}, streaming=${status.streaming === true}, sinceSeq=${turnStartSeq}${delivery}` +
        `${truncated ? `, PARTIAL replay — buffer starts at ${oldest}` : ""})`,
    );
    this.sse.fastForwardLastSeenSeq(turnStartSeq);
    this._agentId = agentId;
    const proxy = this.createAgent(agentId, {
      ...(status.runToken !== undefined ? { runToken: status.runToken } : {}),
      ...(status.deliveryId !== undefined ? { deliveryId: status.deliveryId } : {}),
    });
    await adoptInFlightTurn(this, deps, proxy, {
      agentId,
      ...(status.runToken !== undefined ? { runToken: status.runToken } : {}),
      ...(status.deliveryId !== undefined ? { deliveryId: status.deliveryId } : {}),
      streaming: status.streaming === true,
    });
    this.emitMessage({
      type: "session_status",
      sessionId: this.sessionId,
      running: true,
      queueLength: this.queueLength,
    });
    return true;
  }

  async resumeInFlightTurn(): Promise<boolean> {
    if (this._disposed) return false;
    await this.ensureWorkerResourcesStarted();
    return this._isRunning;
  }

  private async ensureWorkerResourcesStarted(): Promise<void> {
    if (this._disposed) return;
    if (this._workerResourcesStarted) {
      if (this._workerStartInFlight) {
        await this._workerStartInFlight;
        return;
      }
      if (!this.sse.isConnected) {
        await this.connectEventStream();
      }
      return;
    }
    this._workerResourcesStarted = true;
    const start = this._doStartWorkerResources();
    this._workerStartInFlight = start;
    try {
      await start;
    } finally {
      this._workerStartInFlight = null;
    }
  }

  private async _doStartWorkerResources(): Promise<void> {
    await this.reconcileWorkerTurnBeforeFirstConnect();
    await this.connectEventStream();
    if (!this._disposed) void this.startWorkerResources();
  }

  async startAgentOnWorker(agentId: AgentId, params: AgentRunParams): Promise<ProxyAgentProcess> {
    await this._workerReady;

    void this.ensureWorkerResourcesStarted();

    await this._waitForInstallBeforeAgent();
    const proxy = new ProxyAgentProcess(agentId, this);
    this.supersedeDisplacedAgent(proxy);
    this._agent = proxy;

    await workerPost(this.workerUrl, "/agent/start", { agentId, params, runToken: proxy.runToken }, { timeoutMs: 0 });

    return proxy;
  }

  // Keep install and CLI memory peaks from overlapping in the container.
  private async _waitForInstallBeforeAgent(): Promise<void> {
    if (this._installComplete) {
      await this._installComplete;
    }
  }

  async interruptAgentOnWorker(): Promise<void> {
    await workerPost(this.workerUrl, "/agent/interrupt");
  }

  // Guard both the worker kill and the local slot clear against a replacement process.
  async killAgentOnWorker(opts?: { timeoutMs?: number; victimRunToken?: string }): Promise<void> {
    const victim = this._agent;
    await workerPost(
      this.workerUrl,
      "/agent/kill",
      opts?.victimRunToken !== undefined ? { runToken: opts.victimRunToken } : undefined,
      opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : undefined,
    );
    if (this._agent !== victim) {
      console.warn(
        `[container-runner:${this.sessionId}] /agent/kill resolved after the slot moved on — not clearing the incoming agent`,
      );
      return;
    }
    // The slot may already have changed before this call began.
    if (opts?.victimRunToken !== undefined && this._agent?.runToken !== opts.victimRunToken) {
      console.warn(
        `[container-runner:${this.sessionId}] /agent/kill victim ${opts.victimRunToken} is not the slot occupant — nothing was killed, not clearing the slot`,
      );
      return;
    }
    this._agent = null;
  }

  async writeAgentStdin(data: string): Promise<void> {
    await workerPost(this.workerUrl, "/agent/stdin", { data });
  }

  async sendAgentMessage(text: string): Promise<void> {
    await workerPostMessage(this.workerUrl, text);
  }

  // null means ShipIt auto; the adapter maps it to CLI default.
  async setAgentPermissionModeOnWorker(mode: PermissionMode | undefined): Promise<void> {
    await workerPost(this.workerUrl, "/agent/permission-mode", { mode: mode ?? null });
  }

  async compactAgentOnWorker(instructions?: string): Promise<void> {
    await workerPost(this.workerUrl, "/agent/compact", instructions ? { instructions } : undefined);
  }

  async resolvePermissionOnWorker(requestId: string, decision: PermissionDecision): Promise<void> {
    await workerPost(this.workerUrl, "/agent/permission/resolve", {
      requestId,
      behavior: decision.behavior,
      ...(decision.remember ? { remember: true } : {}),
      ...(decision.message ? { message: decision.message } : {}),
    });
  }

  async startTerminalOnWorker(cols?: number, rows?: number): Promise<void> {
    await workerPost(this.workerUrl, "/terminal/start", { cols, rows });
    this.termBuf.running = true;
  }

  async writeTerminalOnWorker(data: string): Promise<void> {
    await workerPost(this.workerUrl, "/terminal/input", { data });
  }

  async resizeTerminalOnWorker(cols: number, rows: number): Promise<void> {
    await workerPost(this.workerUrl, "/terminal/resize", { cols, rows });
  }

  async getFileTreeFromWorker(): Promise<unknown> {
    return workerGet(this.workerUrl, "/files/tree");
  }

  async getCodexBuiltinSkills(): Promise<SkillInfo[]> {
    await this._workerReady;
    const res = await workerGet(this.workerUrl, "/codex/skills", { timeoutMs: 3000 }) as { skills?: SkillInfo[] };
    return res.skills ?? [];
  }

  async proxyMcpTest(config: unknown): Promise<unknown> {
    await this._workerReady;
    return workerPost(this.workerUrl, "/mcp/test", { config }, { timeoutMs: 30_000 });
  }

  async installMcpPackages(packages: string[]): Promise<unknown> {
    await this._workerReady;
    return workerPost(this.workerUrl, "/mcp/install", { packages });
  }

  async proxyPresentRaw(
    presentId: string,
  ): Promise<{ content: string; mimeType: string }> {
    await this._workerReady;
    const read = () =>
      workerGet(
        this.workerUrl,
        `/present/${encodeURIComponent(presentId)}/raw`,
      ) as Promise<{ content: string; mimeType: string }>;
    try {
      return await read();
    } catch (err) {
      const record = this._presentStore?.get(presentId);
      if (!record) throw err;
      // A restarted worker has an empty registry; restore durable metadata and retry.
      await workerPost(this.workerUrl, "/present/register", {
        presentId: record.presentId,
        resolvedPath: record.resolvedPath,
        filePath: record.filePath,
        mimeType: record.mimeType,
        createdAt: record.createdAt,
        ...(record.title !== undefined ? { title: record.title } : {}),
      });
      return await read();
    }
  }

  private async startWorkerResources(): Promise<void> {
    await this._workerReady;
    if (this._disposed) { console.log(`[container-runner:${this.sessionId}] Disposed before worker ready`); return; }

    try {
      const res = await workerPost(this.workerUrl, "/files/watch") as { existing?: boolean };
      if (!res?.existing) {
        console.log(`[container-runner:${this.sessionId}] File watcher started on worker`);
      }
    } catch (err) {
      console.error(`[container-runner:${this.sessionId}] Failed to start file watcher:`, err);
    }
  }

  private async stopWorkerResources(): Promise<void> {
    try { await workerPost(this.workerUrl, "/files/unwatch"); } catch { /* container may be gone */ }
  }

  private _installComplete: Promise<InstallCompletion> | null = null;
  private _resolveInstallComplete: ((result: InstallCompletion) => void) | null = null;
  private _installInFlight = false;
  // Set after POST returns: an earlier resync could falsely complete an install not yet started.
  private _installPostIssued = false;
  private _installProbeIntervalMs = INSTALL_STATUS_PROBE_INTERVAL_MS;

  private _depReinstallCommands: string[] = [];
  private _depReinstallInputs: string[] = [];
  private _lastDepReinstallAt = 0;
  private _depReinstallPending = false;
  private _depReinstallTimer: ReturnType<typeof setTimeout> | null = null;

  // Sessions without a compose stack can also have unverified dependencies.
  private _dependencyGap: DependencyGap | null = null;

  get dependencyGap(): DependencyGap | null {
    return this._dependencyGap;
  }

  async preparePlugins(): Promise<void> {
    await this._workerReady;
    if (this._disposed) return;
    // Capture before awaiting so late results cannot update a replacement session.
    const record = beginContainerPrepare(this.sessionId);
    let result: unknown;
    try {
      this.assertWorkerReachable("/plugins/prepare");
      result = await workerPost(this.workerUrl, "/plugins/prepare", undefined, {
        timeoutMs: PLUGIN_PREPARE_TIMEOUT_MS,
      });
    } catch (err) {
      // Transport failure provides no new evidence; keep the previous preparation result.
      console.warn(
        `[plugins:${this.sessionId}] container prepare failed:`,
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
    const failures = readPrepareFailures(result, this.sessionId);
    for (const failure of failures) {
      console.warn(`[plugins:${this.sessionId}] ${failure.skill ?? "link"}: ${failure.reason}`);
    }
    if (record(failures)) this.emitMessage({ type: "plugin_repos_updated", sessionId: this.sessionId });
  }

  // onWorkerDecision reports POST acceptance, not completion; joins/disposal/failures skip it.
  async runInstall(
    commands: string[],
    opts: { onWorkerDecision?: (decision: "skipped" | "started") => void } = {},
  ): Promise<InstallCompletion> {
    if (commands.length === 0) return { ok: true };

    // Arm before any await so concurrent callers share one resolver.
    if (this._installComplete) {
      return this._installComplete;
    }
    const completion = this._installComplete = new Promise<InstallCompletion>((resolve) => {
      this._resolveInstallComplete = resolve;
    });
    this._installInFlight = true;
    this._installPostIssued = false;

    await this._workerReady;
    if (this._disposed) {
      this.signalInstallComplete(true, { unverified: true });
      return { ok: true, unverified: true };
    }
    try {
      this.assertWorkerReachable("/install");
    } catch (err) {
      this.emitMessage({
        type: "install_status",
        sessionId: this.sessionId,
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      this.signalInstallComplete(false);
      return { ok: false };
    }

    void this.ensureWorkerResourcesStarted();

    this.emitMessage({
      type: "install_status",
      sessionId: this.sessionId,
      status: "running",
      command: commands[0],
    });

    try {
      const result = await workerInstall(this.workerUrl, commands, {
        timeoutMs: INSTALL_POST_TIMEOUT_MS,
      }) as { skipped?: boolean; started?: boolean; ok?: boolean };
      this._installPostIssued = true;
      // Listener failures must not become install failures while the worker is still running.
      try {
        opts.onWorkerDecision?.(result.skipped ? "skipped" : "started");
      } catch (err) {
        console.error(
          `[install:${this.sessionId}] install-decision listener threw:`,
          err instanceof Error ? err.message : String(err),
        );
      }
      if (result.skipped) {
        this.clearDependencyGap();
        this.emitMessage({
          type: "install_status",
          sessionId: this.sessionId,
          status: "skipped",
        });
        this.signalInstallComplete();
        return { ok: true };
      }
      // The SSE-open probe may have preceded POST acceptance; probe again now.
      void this.resyncInstallStateAfterReconnect();
      const outcome = await this.awaitInstallCompletion(completion);
      // Known gap: worker joins may run different commands, yet clear this gap and stamp our list.
      if (outcome.ok && !outcome.unverified) {
        this.clearDependencyGap();
      }
      return outcome;
    } catch (err) {
      this.emitMessage({
        type: "install_status",
        sessionId: this.sessionId,
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      this.signalInstallComplete(false);
      return { ok: false };
    }
  }

  setDepReinstallInputs(commands: string[], inputs: string[]): void {
    this._depReinstallCommands = commands;
    this._depReinstallInputs = inputs;
  }

  get appliedInstallCommands(): readonly string[] {
    return this._depReinstallCommands;
  }

  requestDepReinstall(): void {
    this.maybeReinstallForDepChange();
  }

  reevaluateWorkspaceConfig(): void {
    if (this._disposed) return;
    if (this.onComposeConfigChanged) {
      this.onComposeConfigChanged();
      return;
    }
    this._serviceManager?.reconcile().catch((err: unknown) => {
      this.logReconcileError("Compose reconcile failed", err);
    });
  }

  // Cross-mount rewrites can miss watcher events. Let the worker's marker check content.
  notifyWorkspaceRewritten(rewrite?: string): void {
    if (this._disposed) return;
    if (this._depReinstallCommands.length === 0) return;
    if (this._depReinstallInputs.length === 0) {
      this.recordDependencyGap({
        reason: "not-content-keyed",
        commands: [...this._depReinstallCommands],
        ...(rewrite ? { rewrite } : {}),
      });
      return;
    }
    this._lastRewriteLabel = rewrite;
    this.maybeReinstallForDepChange();
  }

  private _lastRewriteLabel: string | undefined;

  // Record before notification so transport or persistence failure cannot erase the gap.
  private recordDependencyGap(gap: DependencyGap): void {
    const prev = this._dependencyGap;
    this._dependencyGap = gap;
    if (prev?.reason === gap.reason && prev?.rewrite === gap.rewrite) return;
    console.warn(
      `[container-runner:${this.sessionId}] dependencies unverified after ${gap.rewrite ?? "a dependency change"} (${gap.reason})`,
    );
    try {
      this.onDependenciesUnverified?.(dependencyGapNotice(gap));
    } catch (err) {
      console.error(
        `[container-runner:${this.sessionId}] could not report unverified dependencies:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private clearDependencyGap(): void {
    this._dependencyGap = null;
  }

  private isConfigFileChange(rawPath: string): boolean {
    const p = rawPath.replace(/^\.\//, "");
    if (ContainerSessionRunner.CONFIG_FILES.has(p)) return true;
    return p === this._serviceManager?.composeFilePath.replace(/^\.\//, "");
  }

  private isDepInputChange(paths: string[]): boolean {
    if (this._depReinstallInputs.length === 0) return false;
    return paths.some((p) => this._depReinstallInputs.includes(p.replace(/^\.\//, "")));
  }

  private maybeReinstallForDepChange(): void {
    if (this._disposed) return;
    if (this._depReinstallCommands.length === 0) return;

    const now = Date.now();
    const elapsed = now - this._lastDepReinstallAt;
    const inFlight = this._installComplete !== null;
    if (inFlight || (this._lastDepReinstallAt !== 0 && elapsed < ContainerSessionRunner.DEP_REINSTALL_COOLDOWN_MS)) {
      this._depReinstallPending = true;
      if (!this._depReinstallTimer) {
        const wait = inFlight
          ? ContainerSessionRunner.DEP_REINSTALL_COOLDOWN_MS
          : ContainerSessionRunner.DEP_REINSTALL_COOLDOWN_MS - elapsed;
        this._depReinstallTimer = setTimeout(() => {
          this._depReinstallTimer = null;
          if (this._depReinstallPending) this.maybeReinstallForDepChange();
        }, Math.max(0, wait));
        this._depReinstallTimer.unref?.();
      }
      return;
    }

    this._depReinstallPending = false;
    this._lastDepReinstallAt = now;
    void this.reinstallForDepChange();
  }

  // Stop services only after POST says install started; marker skips must not cause outages.
  private async reinstallForDepChange(): Promise<void> {
    const mgr = this._serviceManager;
    console.log(`[container-runner:${this.sessionId}] dependency input changed — reinstalling`);
    const rewrite = this._lastRewriteLabel;
    this._lastRewriteLabel = undefined;

    // Only the caller that transitions the gate owns its closure.
    let opened = false;
    const openGate = (): void => {
      if (opened || !mgr) return;
      opened = mgr.setInstallRunning(true);
    };
    // Read BEFORE anything can open the gate, which clears the latch it reports.
    const wasLatchedFailed = mgr?.installGateFailed ?? false;

    let res: InstallCompletion = { ok: true };
    try {
      res = await this.runInstall(this._depReinstallCommands, {
        onWorkerDecision: (decision) => {
          if (decision === "started") openGate();
        },
      });
    } catch {
      res = { ok: false };
    } finally {
      try {
        // Failures need the gate; a previous failure needs a transition backed by proven success.
        const provenGood = res.ok && !res.unverified;
        if (!res.ok || (wasLatchedFailed && provenGood)) openGate();
        if (opened) mgr?.setInstallRunning(false, { failed: !res.ok });
      } catch (err) {
        console.error(
          `[container-runner:${this.sessionId}] reinstall gate transition failed:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    if (!res.ok) {
      this.recordDependencyGap({
        reason: "install-failed",
        commands: [...this._depReinstallCommands],
        ...(rewrite ? { rewrite } : {}),
      });
    }
  }

  private signalInstallComplete(ok = true, opts: { unverified?: boolean } = {}): void {
    this._installInFlight = false;
    if (this._resolveInstallComplete) {
      const r = this._resolveInstallComplete;
      this._resolveInstallComplete = null;
      r({ ok, ...(opts.unverified ? { unverified: true } : {}) });
    }
    this._installComplete = null;
  }

  // Rearm after each probe settles to prevent overlapping requests.
  private async awaitInstallCompletion(completion: Promise<InstallCompletion>): Promise<InstallCompletion> {
    let waiting = true;
    let timer: NodeJS.Timeout | null = null;
    const arm = (): void => {
      timer = setTimeout(() => {
        void (async () => {
          await this.resyncInstallStateAfterReconnect();
          if (waiting && !this._disposed) arm();
        })();
      }, this._installProbeIntervalMs);
      timer.unref?.();
    };
    arm();
    try {
      return await completion;
    } finally {
      waiting = false;
      if (timer) clearTimeout(timer);
    }
  }

  private async resyncInstallStateAfterReconnect(): Promise<void> {
    if (!this._installInFlight || this._disposed) return;
    if (!this._installPostIssued) return;
    // Bind this probe to its install cycle; a later install may start during the await.
    const cycle = this._installComplete;
    let status: { running?: boolean; lastResult?: { ok: boolean; message?: string; command?: string } };
    try {
      status = await workerGet(this.workerUrl, "/install/status") as typeof status;
    } catch (err) {
      console.warn(
        `[container-runner:${this.sessionId}] /install/status probe failed:`,
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
    if (this._disposed || this._installComplete !== cycle) return;
    if (status.running) return;
    const last = status.lastResult;
    if (!last) {
      this.emitMessage({
        type: "install_status",
        sessionId: this.sessionId,
        status: "complete",
      });
      this.signalInstallComplete(true, { unverified: true });
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
    this.signalInstallComplete(last.ok);
  }

  // Replaces the full injected set; omitted keys are unset, and {} clears all keys.
  async tryPushAgentSecrets(agentValues: Record<string, string>): Promise<void> {
    if (this._disposed) return;
    try {
      await this._workerReady;
    } catch {
      return;
    }
    if (this._disposed) return;
    try {
      await workerPushAgentSecrets(this.workerUrl, agentValues);
    } catch (err) {
      console.warn(
        `[runner:${this.sessionId}] pushAgentSecrets failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private connectEventStream(): Promise<void> {
    return this.sse.connect();
  }

  private onSseOpen(isReconnect: boolean): void {
    if (isReconnect && this.termBuf.running) {
      const buffered = this.termBuf.buffer;
      if (buffered) {
        this.emitMessage({ type: "terminal_output", data: `\x1bc${  buffered}` });
      }
    }
    if (this._installInFlight) {
      void this.resyncInstallStateAfterReconnect();
    }
    // Retry the idempotent watcher start after failed POSTs or worker restarts.
    void this.startWorkerResources();
  }

  private onSseDisconnect(attempt: number): boolean | undefined {
    if (this.termBuf.running) {
      this.emitMessage({
        type: "terminal_reconnecting",
        attempt,
        maxAttempts: TerminalBufferManager.MAX_RECONNECT_ATTEMPTS,
      });
      if (attempt > TerminalBufferManager.MAX_RECONNECT_ATTEMPTS) {
        console.error(
          `[container-runner:${this.sessionId}] Terminal SSE reconnect failed after ${TerminalBufferManager.MAX_RECONNECT_ATTEMPTS} attempts`,
        );
        this.termBuf.running = false;
        this.emitMessage({ type: "terminal_exit", exitCode: null });
        return false;
      }
    }
    return true;
  }

  private isStaleSpawnEvent(
    eventType: string,
    data: Record<string, unknown>,
    target: ProxyAgentProcess | null = this._agent,
  ): boolean {
    const incoming = data.runToken;
    const current = target?.runToken;
    if (typeof incoming !== "string" || typeof current !== "string") return false;
    if (incoming === current) return false;
    console.warn(
      `[sse-drop:${this.sessionId}] ${eventType} runToken=${incoming} != current ${current} — stale spawn ignored (slot reused)`,
    );
    return true;
  }

  private resolveEventTarget(): ProxyAgentProcess | null {
    return this._agent ?? (this._isStreamingActive ? this._streamingProxy : null);
  }

  private handleSSEEvent(event: SSEEvent): void {
    try {
      const data = JSON.parse(event.data) as Record<string, unknown>;
      this.sse.markActivity();

      switch (event.type) {
        case "agent_event": {
          const target = this.resolveEventTarget();
          if (!target) {
            const eventType = (data as { type?: string }).type ?? "unknown";
            console.warn(`[sse-drop:${this.sessionId}] agent_event type=${eventType} dropped (no _agent)`);
            break;
          }
          if (this.isStaleSpawnEvent("agent_event", data, target)) break;
          this._agent = target;
          const { runToken: _staleGuardToken, ...payload } = data;
          target.emit("event", payload as unknown as AgentEvent);
          break;
        }

        // Restore the slot before terminal events: teardown checks identity and commits the turn.
        case "agent_done": {
          const target = this.resolveEventTarget();
          if (!target) {
            console.warn(`[sse-drop:${this.sessionId}] agent_done dropped (no _agent)`);
            break;
          }
          if (this.isStaleSpawnEvent("agent_done", data, target)) break;
          this._agent = target;
          target.emit("done", (data.exitCode as number) ?? 0);
          break;
        }

        case "agent_error": {
          const target = this.resolveEventTarget();
          if (!target) {
            console.warn(`[sse-drop:${this.sessionId}] agent_error dropped (no _agent)`);
            break;
          }
          if (this.isStaleSpawnEvent("agent_error", data, target)) break;
          this._agent = target;
          target.emit("error", new Error((data.message as string) ?? "Unknown worker error"));
          break;
        }

        case "agent_auth_required":
          if (this._agent && !this.isStaleSpawnEvent("agent_auth_required", data)) {
            this._agent.emit("auth_required");
          }
          break;

        case "agent_log":
          if (this._agent) {
            this._agent.emit("log", (data.source as string) ?? "worker", (data.text as string) ?? "");
          }
          break;

        case "terminal_data":
          this.appendTerminalOutput(data.data as string);
          this.emitMessage({ type: "terminal_output", data: data.data as string });
          break;

        case "terminal_exit":
          this.termBuf.running = false;
          this.emitMessage({ type: "terminal_exit", exitCode: data.exitCode as number | null });
          break;

        case "service_request": {
          const requestId = data.requestId as string;
          const action = data.action as string;
          const name = data.name as string | undefined;
          const lines = data.lines as number | undefined;
          void this.handleServiceRequest(requestId, action, name, lines);
          break;
        }

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

        case "install_error": {
          const message = (data.message as string) ?? "Install failed";
          // Installs can fail without a viewer; retain an orchestrator log entry.
          console.error(
            `[install:${this.sessionId}] failed: ${message}`,
          );
          this.emitMessage({
            type: "install_status",
            sessionId: this.sessionId,
            status: "error",
            command: data.command as string | undefined,
            message,
          });
          this.signalInstallComplete(false);
          break;
        }

        case "mcp_server_status": {
          const status = data as { name?: string; state?: string; reason?: string };
          if (typeof status.name === "string" && typeof status.state === "string") {
            this.emitMessage({
              type: "mcp_server_status",
              sessionId: this.sessionId,
              name: status.name,
              state: status.state as "loaded" | "failed" | "crashed" | "disabled",
              reason: status.reason,
            });
          }
          break;
        }

        case "present_content": {
          const evt = data as {
            presentId?: string;
            mimeType?: string;
            title?: string;
            filePath?: string;
            createdAt?: string;
            resolvedPath?: string;
            inline?: boolean;
          };
          if (
            typeof evt.presentId === "string"
            && typeof evt.mimeType === "string"
            && typeof evt.filePath === "string"
          ) {
            const entry: PresentStateEntry = {
              presentId: evt.presentId,
              mimeType: evt.mimeType,
              ...(evt.title !== undefined ? { title: evt.title } : {}),
              filePath: evt.filePath,
              createdAt: evt.createdAt ?? new Date().toISOString(),
              ...(evt.inline === true ? { inline: true } : {}),
            };
            this.cachePresentation(entry);
            let inlineCardIsNew = false;
            if (this._presentStore && typeof evt.resolvedPath === "string") {
              ({ inlineCardIsNew } = this._presentStore.record({
                presentId: entry.presentId,
                sessionId: this.sessionId,
                filePath: entry.filePath,
                resolvedPath: evt.resolvedPath,
                mimeType: entry.mimeType,
                createdAt: entry.createdAt,
                ...(entry.title !== undefined ? { title: entry.title } : {}),
                ...(entry.inline ? { inline: true } : {}),
              }));
            }
            this.emitMessage({
              type: "present_content",
              sessionId: this.sessionId,
              presentId: entry.presentId,
              mimeType: entry.mimeType,
              ...(entry.title !== undefined ? { title: entry.title } : {}),
              filePath: entry.filePath,
              createdAt: entry.createdAt,
              ...(entry.inline ? { inline: true } : {}),
            });
            // Re-presenting updates the artifact; emit its transcript card only once.
            if (inlineCardIsNew && this._chatHistoryManager) {
              const card = {
                presentId: entry.presentId,
                filePath: entry.filePath,
                mimeType: entry.mimeType,
                ...(entry.title !== undefined ? { title: entry.title } : {}),
                createdAt: entry.createdAt,
              };
              emitChatCard(
                this,
                { type: "present_inline_card", sessionId: this.sessionId, card },
                { role: "assistant", text: "", presentInline: card },
                { chatHistoryManager: this._chatHistoryManager, sessionId: this.sessionId },
              );
            }
          }
          break;
        }

        case "present_cleared": {
          const evt = data as { presentId?: string };
          if (typeof evt.presentId === "string") {
            this._presentations = this._presentations.filter(
              (p) => p.presentId !== evt.presentId,
            );
          } else {
            this._presentations = [];
          }
          this._presentStore?.clear(this.sessionId, evt.presentId);
          this.emitMessage({
            type: "present_cleared",
            sessionId: this.sessionId,
            ...(typeof evt.presentId === "string" ? { presentId: evt.presentId } : {}),
          });
          break;
        }

        case "file_changes": {
          const paths = (data.paths as string[]) ?? [];
          this.emitMessage({ type: "files_changed", paths });

          const hasConfigChange = paths.some(p => this.isConfigFileChange(p));
          if (hasConfigChange) {
            console.log(`[container-runner:${this.sessionId}] Config file changed, re-evaluating session config`);
            this.reevaluateWorkspaceConfig();
          }

          if (this.isDepInputChange(paths)) {
            this.maybeReinstallForDepChange();
          }
          break;
        }
      }
    } catch (err) {
      console.error(`[container-runner:${this.sessionId}] Failed to parse SSE event:`, err);
    }
  }

  private async handleServiceRequest(
    requestId: string,
    action: string,
    name?: string,
    lines?: number,
  ): Promise<void> {
    let result: unknown;
    let error: string | undefined;

    try {
      const mgr = this._serviceManager;
      if (!mgr) {
        throw new Error("No compose stack configured for this session");
      }

      const describe = (svcName: string) => {
        const svc = mgr.getServices().find(s => s.name === svcName);
        return {
          ok: svc?.status !== "error",
          name: svcName,
          status: svc?.status ?? "stopped",
          port: svc?.port,
          preview: svc?.preview,
          url: svc?.url,
          error: svc?.error,
        };
      };

      switch (action) {
        case "list": {
          const failure = mgr.projectComposeFailure;
          const gap = this._dependencyGap;
          result = {
            services: mgr.getServices().map(s => ({
              name: s.name,
              status: s.status,
              port: s.port,
              preview: s.preview,
              url: s.url,
              error: s.error,
            })),
            ...(failure ? { failure } : {}),
            ...(gap ? { dependencies: { reason: gap.reason, message: dependencyGapSummary(gap) } } : {}),
          };
          break;
        }
        case "start": {
          if (!name) throw new Error("Service name is required");
          const before = mgr.getServices().find(s => s.name === name);
          if (before?.status === "running") {
            result = { ...describe(name), alreadyRunning: true };
            break;
          }
          await mgr.startService(name);
          result = describe(name);
          break;
        }
        case "stop":
          if (!name) throw new Error("Service name is required");
          await mgr.stopService(name);
          result = describe(name);
          break;
        case "restart":
          if (!name) throw new Error("Service name is required");
          await mgr.restartService(name);
          result = describe(name);
          break;
        case "logs": {
          if (!name) throw new Error("Service name is required");
          if (!mgr.getService(name)) throw new Error(`Unknown service: ${name}`);
          const logs = stripAnsi(await mgr.snapshotLogs(name, lines ?? 2000));
          result = { name, logs };
          break;
        }
        default:
          throw new Error(`Unknown service action: ${action}`);
      }
    } catch (err) {
      error = (err as Error).message;
    }

    try {
      await workerPost(this.workerUrl, "/services/_callback", { requestId, result, error });
    } catch (err) {
      console.error(`[container-runner:${this.sessionId}] Failed to send service callback:`, (err as Error).message);
    }
  }

  private _systemTurnDeps: SystemTurnDeps | null = null;

  setSystemTurnDeps(deps: SystemTurnDeps): void {
    this._systemTurnDeps = deps;
  }

  assertCanDispatch(): void {
    const authorize = this._systemTurnDeps?.authorizeDispatch;
    if (!authorize) {
      if (process.env.NODE_ENV === "test") return;
      throw new AgentTurnAdmissionError(this.sessionId);
    }
    authorize(this.sessionId);
  }

  dispatch(opts: PreparedDispatch): TurnHandle {
    return dispatchOnRunner(this, this._systemTurnDeps, opts);
  }

  get canRunDispatchedTurn(): boolean { return this._systemTurnDeps !== null; }

  schedulePostTurnPush(): void {
    this._systemTurnDeps?.scheduleAutoPush(this.sessionDir);
  }

  async runDispatchedTurn(opts: PreparedDispatch): Promise<void> {
    await runDispatchedTurn(this, this._systemTurnDeps!, this._agentId, opts, (agentId) => {
      return this.createAgent(agentId);
    });
  }

  onAgentFinished(): void {
    if (!this._isRunning && this.turn.queueLength === 0) {
      this.emit("idle");
    }
  }

  private clearResidentProcessState(): void {
    this._isStreamingActive = false;
    this._streamingProxy = null;
    stopTokenWriteBackWatch(this.sessionId);
    this._backgroundTasks.clear();
    this._appliedPermissionMode = undefined;
    this._appliedSpawnIdentity = undefined;
    this._residentRoute = undefined;
    this._agent = null;
    // Update the open chat as well as the sidebar; independent consults may still be running.
    if (this.backgroundWorkDescriptions.length === 0) {
      this.emitMessage({
        type: "background_tasks",
        sessionId: this.sessionId,
        count: 0,
        descriptions: [],
      });
    }
    // Announce last: listeners can synchronously start a new turn and install its agent.
    this.announceBackgroundWork();
  }

  async verifyRunningState(): Promise<boolean> {
    const staleResidentOnly = !this._isRunning && this._isStreamingActive;
    if (!this._isRunning && !staleResidentOnly) return false;
    const wasRunning = this._isRunning;
    const turnEpochAtCheck = this.turnEpoch;
    let workerRunning: boolean;
    try {
      const status = await workerGet(this.workerUrl, "/agent/status") as { running?: boolean };
      workerRunning = status.running === true;
    } catch (err) {
      // An unreachable worker is not proof that its agent died.
      console.warn(`[container-runner:${this.sessionId}] verifyRunningState: worker unreachable, keeping running=true`, err);
      return this._isRunning;
    }
    if (workerRunning) return this._isRunning;
    // A new turn can start during the probe, before reaching the worker.
    if (this._isRunning !== wasRunning || this.turnEpoch !== turnEpochAtCheck) {
      console.warn(
        `[container-runner:${this.sessionId}] verifyRunningState: turn state changed under the `
        + `worker probe (running ${wasRunning}→${this._isRunning}) — standing down`,
      );
      return this._isRunning;
    }
    if (staleResidentOnly) {
      console.warn(
        `[container-runner:${this.sessionId}] Detected a stale resident streaming process `
        + `(worker reports no agent). Clearing the resident-process state.`,
      );
      this.clearResidentProcessState();
      return false;
    }
    console.warn(`[container-runner:${this.sessionId}] Detected stuck running=true (worker reports no agent). Resetting.`);
    this._isRunning = false;
    this.clearResidentProcessState();
    this.emitMessage({
      type: "session_status",
      sessionId: this.sessionId,
      running: false,
      queueLength: this.queueLength,
      error: "Agent state was out of sync with the worker — reset. You can send a new message.",
    });
    // Clear delivery identity before notifying consumers that may immediately retry.
    this.activeDeliveryId = undefined;
    this.emit("turn_abandoned");
    // Drain before announcing idle; a queued turn may start immediately.
    if (releaseQueuedTurn(this)) return false;
    this.emit("idle");
    return false;
  }

  get disposed(): boolean { return this._disposed; }

  dispose(opts?: { force?: boolean; preserveAgent?: boolean }): void {
    if (this._disposed) return;
    const stack = new Error("ContainerSessionRunner.dispose caller").stack;
    console.warn(`[container-runner:${this.sessionId}] dispose(force=${opts?.force ?? false}) called from:\n${stack}`);
    if (this._isRunning && !opts?.force) {
      console.log(`[container-runner:${this.sessionId}] dispose() skipped — agent is running`);
      return;
    }
    if (this._subAgentAborts.size > 0 && !opts?.force) {
      console.log(
        `[container-runner:${this.sessionId}] dispose() skipped — ${this._subAgentAborts.size} sub-agent spawn(s) in flight`,
      );
      return;
    }
    if (this._postTurnHold.active && !opts?.force) {
      console.log(
        `[container-runner:${this.sessionId}] dispose() skipped — a turn's post-turn sequence is still running`,
      );
      return;
    }
    this._disposed = true;
    this._postTurnHold.reset();

    // Orchestrator shutdown must leave the CLI alive so the next process can adopt its turn.
    if (!opts?.preserveAgent) {
      this.cancelInFlightSubAgents("runner disposed");

      if (this._agent) {
        workerPost(this.workerUrl, "/agent/kill", { runToken: this._agent.runToken }).catch(() => {});
      }
    }
    this._agent = null;

    this.stopReconcileTimer();
    if (this._depReinstallTimer) {
      clearTimeout(this._depReinstallTimer);
      this._depReinstallTimer = null;
    }
    this._depReinstallPending = false;
    this.clearServiceManager();
    this.sse.disconnect();
    this.signalInstallComplete(true, { unverified: true });
    this._resolveWorkerReady();
    this.sse.resolvePendingConnect();
    this.turn.reset();
    this._isRunning = false;
    this._isStreamingActive = false;
    this._streamingProxy = null;
    this._backgroundTasks.clear();
    this._appliedPermissionMode = undefined;
    this._appliedSpawnIdentity = undefined;
      this._residentRoute = undefined;
    this.announceBackgroundWork();
    this.termBuf.reset();
    this.emit("disposed");
    this.removeAllListeners();
  }
}
