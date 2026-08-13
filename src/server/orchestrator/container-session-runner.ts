/**
 * ContainerSessionRunner — SessionRunner implementation that delegates to a
 * remote session worker over HTTP + SSE.
 *
 * Implements the same SessionRunnerInterface as the direct SessionRunner.
 * From the perspective of HandlerContext, WebSocket handlers, and the registry,
 * this is indistinguishable from a direct runner.
 *
 * Internally the class is composed of three collaborators that own narrow
 * slices of state:
 *  - `SseConnectionManager` — the worker `/events` stream, reconnect backoff,
 *    keepalive, and the activity gauge.
 *  - `TurnAccumulator` — message queue, accumulated assistant text/tool-use,
 *    chat-message-group log, and the turn-event replay buffer used by
 *    reconnecting viewers.
 *  - `TerminalBufferManager` — server-side terminal output buffer and the
 *    terminal-running flag.
 *
 * The runner itself owns lifecycle (viewer counts, dispose, reconcile timer),
 * agent-proxy coordination (since `ProxyAgentProcess` holds a `ProxyAgentRunner`
 * back-reference to it and tests exercise `_startAgentViaProxy` directly),
 * service-manager wiring, and the install-state machine — these are
 * inseparable from the runner's role as the session orchestrator's worker
 * facade.
 */

import type { ProviderRouteKind } from "../shared/types/domain-types/provider.js";
import { EventEmitter } from "node:events";
import type { AgentProcess, AgentId, AgentEvent, AgentRunParams, TerminalProcess, WorkerAgentStatus } from "../shared/types.js";
import type { WsServerMessage, ClaudeContentBlockToolUse, SkillInfo, PermissionMode, PermissionDecision } from "../shared/types.js";
import type { PresentStateEntry } from "../shared/types/ws-server-messages.js";
import type { PresentStore } from "./present-store.js";
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
import type { ServiceManager, ManagedService, SecretsStatusInternalSnapshot } from "./service-manager.js";
import { stripAnsi } from "../shared/strip-ansi.js";
import { SseConnectionManager } from "./sse-connection-manager.js";
import { BackgroundTaskTracker, type BackgroundTaskInfo } from "./background-task-tracker.js";
import { PostTurnHold } from "./post-turn-hold.js";
import { getAgentDisplayName } from "../shared/agent-registry.js";
import { TurnAccumulator } from "./turn-accumulator.js";
import type { CommittedBodyIds } from "./transcript-projection.js";
import { TerminalBufferManager } from "./terminal-buffer-manager.js";
import { beginContainerPrepare, readPrepareFailures } from "./services/plugin-activation.js";

// ---------------------------------------------------------------------------
// Barrel re-exports for backwards compatibility
// ---------------------------------------------------------------------------
export { connectSSE } from "./sse-client.js";
export type { SSEEvent } from "./sse-client.js";
export { workerPost, workerGet, workerInstall, PLACEHOLDER_WORKER_URL, WorkerUnavailableError } from "./worker-http.js";
export { truncateTerminalBuffer } from "./terminal-buffer.js";
export { ProxyAgentProcess } from "./proxy-agent-process.js";
export type { ProxyAgentRunner } from "./proxy-agent-process.js";

// ---------------------------------------------------------------------------
// ContainerSessionRunner
// ---------------------------------------------------------------------------

/**
 * Timeout for the POST /install request. The worker returns `{ started: true }`
 * (or `{ skipped: true }`) immediately and streams progress via SSE, so the
 * POST itself is fast. The bound is generous but finite so a genuinely wedged
 * worker resolves the install gate (as a failure) rather than blocking the
 * first turn forever.
 */
const INSTALL_POST_TIMEOUT_MS = 180_000;

/**
 * docs/262 — bound for POST /plugins/prepare, which only reads the declaration
 * and maintains symlinks. Short on purpose: there is no plugin-authored work
 * behind it (install runs in its own container), so anything slower than this
 * is a wedged worker rather than a long job.
 */
const PLUGIN_PREPARE_TIMEOUT_MS = 30_000;

export class ContainerSessionRunner extends EventEmitter<SessionRunnerEvents> implements SessionRunnerInterface, ProxyAgentRunner {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly supportsRemoteTerminal = true;

  // Worker connection (session container)
  private workerUrl: string;
  private _workerReady: Promise<void>;
  private _resolveWorkerReady!: () => void;

  /**
   * Why this runner will never get a worker, when container creation failed
   * outright. Set by `markWorkerUnavailable` (from the create path's terminal
   * failure) BEFORE `dispose()` resolves the worker-ready gate, so a turn
   * parked on that gate reports the real cause instead of the transport-level
   * `connect ECONNREFUSED 0.0.0.0` the placeholder URL used to produce.
   */
  private _workerUnavailableReason: string | null = null;

  // Collaborators (own narrow slices of state — see file header).
  private sse: SseConnectionManager;
  private turn = new TurnAccumulator();
  private termBuf = new TerminalBufferManager();

  // Agent state (mirrored locally for synchronous access by HandlerContext).
  // Kept on the runner itself because `ProxyAgentProcess` holds a back-reference
  // to the runner via the `ProxyAgentRunner` contract and tests invoke the
  // delegation methods directly.
  private _agent: ProxyAgentProcess | null = null;
  private _agentId: AgentId;
  private _isRunning = false;
  private _systemTurnInProgress = false;
  private _wasInterrupted = false;
  /** See `SessionRunnerInterface.turnEpoch`. */
  turnEpoch = 0;
  private _lastTurnErrored = false;
  private _guardedUnavailable = false;
  readonly awaitingPermissionIds = new Set<string>();
  private _isStreamingActive = false;
  private _backgroundTasks = new BackgroundTaskTracker();
  // docs/146 follow-up — the proxy of the live resident streaming process,
  // tracked SEPARATELY from `_agent` so it survives a stale/one-shot spawn
  // momentarily displacing or nulling the single `_agent` slot. The SSE relay
  // re-adopts it when an `agent_event` arrives with `_agent === null` while
  // streaming is still active, so a stale spawn's exit can't strand the live
  // streaming turn's events `(no _agent)`. Set when `isStreamingActive` flips
  // true (the slot occupant is then the streaming proxy); cleared when it flips
  // false or on dispose.
  private _streamingProxy: ProxyAgentProcess | null = null;
  private _appliedPermissionMode: PermissionMode | undefined = undefined;
  /** See `SessionRunnerInterface.appliedSpawnIdentity` — the resident CLI's whole spawn tuple. */
  private _appliedSpawnIdentity: string | undefined = undefined;
  /** See `SessionRunnerInterface.residentRoute` — the resident CLI's credential route. */
  private _residentRoute: { kind: ProviderRouteKind; id: string } | undefined = undefined;

  // Per-runner mutex for `_startAgentViaProxy`. Concurrent callers chain on
  // this promise so docs/142's B2 kill+restart cannot interleave with another
  // /agent/start — the SIGHUP/SIGTERM loop docs/124's follow-up flagged.
  private _startInFlight: Promise<void> = Promise.resolve();

  // Terminal (remote — runs inside container)
  private _terminal: TerminalProcess | null = null;

  // Auto-push timer

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

  // Authoritative cache of agent-emitted presentations (docs/093), mirrored
  // from the SSE present_content/present_cleared stream so a viewer attaching
  // after the tool fired can hydrate via the `present_state` replay. Seeded from
  // the durable `_presentStore` at construction so a runner created for a freshly
  // restarted container still carries the session's presentations.
  private _presentations: PresentStateEntry[] = [];

  /**
   * docs/093 — durable Present-tab metadata store (orchestrator-side). Optional:
   * tests construct runners without it and fall back to in-memory-only behavior.
   * When present, `present_content` / `present_cleared` SSE events are persisted
   * here so the Present tab survives a container restart, and `proxyPresentRaw`
   * uses it to re-register an artifact with a freshly-started worker.
   */
  private readonly _presentStore: PresentStore | undefined;

  // Compose service management
  private _serviceManager: ServiceManager | null = null;
  private _serviceManagerListeners: (() => void)[] = [];
  /** Called when config files change and no ServiceManager exists (e.g. after migration). */
  onComposeConfigChanged?: () => void;
  /**
   * docs/178 — re-run `setupServiceManager` for this runner. Invoked by the
   * trust endpoint when the user accepts a previously-untrusted remote, so the
   * deferred `agent.install` + compose stack start for the already-open
   * session without requiring a restart.
   */
  rerunServiceSetup?: () => void;

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

  /**
   * Cooldown between dependency-change-triggered reinstalls (#1622). A git
   * `reset`/`checkout`/`rebase` or a manual `npm install` can rewrite a lockfile
   * repeatedly; this throttles the auto-reinstall so back-to-back dep-input
   * changes (including the reinstall's own lockfile rewrite) can't spin an
   * install loop. A change arriving inside the window schedules a single
   * trailing reinstall so the final lockfile state always wins. Matches the
   * "30s cooldown" the agent-facing docs (environment.md / preview.md) promise.
   */
  private static readonly DEP_REINSTALL_COOLDOWN_MS = 30_000;

  private _disposed = false;
  pendingCommitLink: { commitHash: string; parentCommitHash: string } | null = null;
  private _subAgentSpawnsThisTurn = 0;
  /**
   * planning#280 — in-flight sub-agent spawns brokered to the worker, keyed by
   * spawnId. The container runner's counterpart to `SessionRunner`'s
   * `_subAgentHandles`: a container spawn is an HTTP request, not a local
   * process handle, so cancelling it means aborting the request. Aborted on
   * dispose so a force-teardown can't leave one hanging. Carries the agent
   * being consulted so planning#246 can name the consult in the busy marker
   * instead of only counting it.
   */
  private readonly _subAgentAborts = new Map<string, { controller: AbortController; agentId: AgentId }>();
  /** planning#246 — last announced `backgroundWorkDescriptions`, for change detection. */
  private _lastAnnouncedWork = "[]";
  /** See `SessionRunnerInterface.postTurnWorkInFlight`. */
  private readonly _postTurnHold = new PostTurnHold();
  private _workerResourcesStarted = false;
  /**
   * docs/240 — in-flight one-time worker-resource start. Concurrent callers
   * (the post-restart reattach sweep and a viewer attaching at the same moment)
   * await this instead of connecting SSE themselves, so the probe-and-adopt step
   * always completes before the stream opens.
   */
  private _workerStartInFlight: Promise<void> | null = null;

  constructor(opts: {
    sessionId: string;
    sessionDir: string;
    defaultAgentId: AgentId;
    workerUrl: string;
    presentStore?: PresentStore;
  }) {
    super();
    this.sessionId = opts.sessionId;
    this.sessionDir = opts.sessionDir;
    this._agentId = opts.defaultAgentId;
    this.workerUrl = opts.workerUrl;
    this._presentStore = opts.presentStore;
    // Seed the presentation cache from durable storage (docs/093) so a runner
    // created for a freshly restarted container replays the session's
    // presentations via `present_state` on viewer attach. Metadata only — the
    // bytes are re-read from disk on demand (and re-registered with the new
    // worker by `proxyPresentRaw`).
    if (this._presentStore) {
      this._presentations = this._presentStore.listForClient(this.sessionId);
    }
    // If workerUrl looks like a placeholder, defer readiness until setWorkerUrl() is called.
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

  /** Update the worker URL once the container is ready. */
  setWorkerUrl(url: string): void {
    this.workerUrl = url;
    this._workerUnavailableReason = null;
    this._resolveWorkerReady();
    // docs/262 — a container that just came up has no `/plugins` links: they
    // live on its own filesystem (a tmpfs under readonly-rootfs), while the
    // generations they point at live on the session's persistent state dir. So
    // a RESTART leaves published generations with nothing addressing them, and
    // the activation-settled hook does not fire again for a session whose
    // declarations did not change. Re-linking here covers that; it is cheap and
    // idempotent — it reads the declaration and maintains symlinks, nothing more.
    void this.preparePlugins();
  }

  /**
   * True while this runner is still waiting for its container to be created —
   * it holds the placeholder URL and creation hasn't failed yet.
   *
   * The missing-container reconciler consults this. It force-disposes any
   * registered runner the container manager doesn't know about, but a runner is
   * registered SYNCHRONOUSLY by `getOrCreate` while `createContainerForRunner`
   * runs fire-and-forget — and the manager's map entry is only written partway
   * into `createContainer`. Everything before that (destroying a stale
   * container, resolving overlay specs, building the config) is a window where
   * a perfectly healthy session looks orphaned. Disposing it there resolved the
   * worker-ready gate against the placeholder URL, which is one of the two ways
   * a turn ended up dialing `0.0.0.0`.
   */
  get awaitingContainer(): boolean {
    return (
      !this._disposed
      && this._workerUnavailableReason === null
      && this.workerUrl === PLACEHOLDER_WORKER_URL
    );
  }

  /**
   * Record that container creation failed terminally, so worker calls report
   * the real cause. Called by the create path immediately before it disposes
   * the runner — dispose resolves `_workerReady`, releasing any parked turn,
   * and this is what that turn reports instead of a bare transport error.
   */
  markWorkerUnavailable(reason: string): void {
    this._workerUnavailableReason = reason;
  }

  /**
   * Throw when this runner has no reachable worker. Called after every
   * `await this._workerReady` on a path whose failure surfaces to the user, so
   * the chat error names the container instead of the placeholder address.
   * The transport-level guard in `worker-http.ts` is the backstop for paths
   * that don't call this.
   */
  private assertWorkerReachable(path: string): void {
    if (this._workerUnavailableReason !== null) {
      throw new WorkerUnavailableError(path, this._workerUnavailableReason);
    }
    if (this.workerUrl === PLACEHOLDER_WORKER_URL) {
      throw new WorkerUnavailableError(path);
    }
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
  get systemTurnInProgress(): boolean { return this._systemTurnInProgress; }
  set systemTurnInProgress(v: boolean) { this._systemTurnInProgress = v; }

  get wasInterrupted(): boolean { return this._wasInterrupted; }
  set wasInterrupted(v: boolean) { this._wasInterrupted = v; }
  get lastTurnErrored(): boolean { return this._lastTurnErrored; }
  set lastTurnErrored(v: boolean) { this._lastTurnErrored = v; }
  get guardedUnavailable(): boolean { return this._guardedUnavailable; }
  set guardedUnavailable(v: boolean) { this._guardedUnavailable = v; }
  get isStreamingActive(): boolean { return this._isStreamingActive; }
  set isStreamingActive(v: boolean) {
    this._isStreamingActive = v;
    // Capture / release the live streaming proxy. When streaming turns on, the
    // current slot occupant IS the streaming process; hold a stable reference so
    // the SSE relay can re-adopt it if a stale spawn nulls `_agent` mid-turn
    // (the prod sse-drop). When it turns off, the streaming process is exiting —
    // drop the reference so genuinely-orphaned events stop being re-adopted.
    this._streamingProxy = v ? this._agent : null;
    // The tracker's liveness gate zeroes the task list without a resident
    // streaming process, so flipping this changes the marker even though no
    // task was touched.
    this.announceBackgroundWork();
  }
  // docs/235 — gated on `isStreamingActive` inside the tracker: a background
  // task cannot outlive the CLI process, so without a resident streaming
  // process the answer is definitionally zero.
  get backgroundTaskCount(): number { return this._backgroundTasks.count(this._isStreamingActive); }
  get backgroundTaskDescriptions(): string[] { return this._backgroundTasks.descriptions(this._isStreamingActive); }
  // planning#298 — a live consult is a fact we own (the in-flight abort-controller
  // set), not a reported hint, so it needs no `isStreamingActive` gate. This is
  // what keeps a backgrounded `shipit agent run` off the idle-eviction list.
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
      // The turn's terminal sequence and the auto-push it arms both happen once
      // `running` is false, and reclaim destroys both. See the interface doc.
      || this._postTurnHold.active;
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
  /**
   * planning#246 — emit `background_work` when the marker's value actually
   * changed. See `SessionRunner.announceBackgroundWork` for why it dedupes.
   */
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

  /** docs/244 / planning#299 — stable reference, mutable contents. */
  get committedBodyIds(): CommittedBodyIds { return this.turn.committedBodyIds; }

  get agentId(): AgentId { return this._agentId; }
  set agentId(id: AgentId) { this._agentId = id; }
  get subAgentSpawnsThisTurn(): number { return this._subAgentSpawnsThisTurn; }
  set subAgentSpawnsThisTurn(n: number) { this._subAgentSpawnsThisTurn = n; }

  /**
   * docs/144 — broker a one-shot SUB-AGENT spawn to the session worker's
   * `/agent/spawn`, which runs a fresh adapter subprocess OUTSIDE the agent slot
   * and returns the accumulated final text synchronously. No SSE involvement —
   * the result flows back over this HTTP response, so the runner's `_agent`
   * accumulators are untouched. The worker's own wall-clock cap stays
   * authoritative for the run itself; a primary-turn interrupt (which hits the
   * worker's `/agent/interrupt`) cancels it.
   *
   * planning#280 — two things the original `{ timeoutMs: 0 }` got wrong:
   *  - **Unbounded.** An interrupt is not the only way this request can be
   *    orphaned. Destroy the container under it (Restart agent, idle teardown)
   *    and the worker's timer dies with the worker, leaving this promise pending
   *    forever. {@link SUB_AGENT_TRANSPORT_TIMEOUT_MS} is the backstop.
   *  - **Uncancellable.** The request is now registered in `_subAgentAborts` so
   *    {@link dispose} can abort it, which is what lets `runSubAgent` land a
   *    terminal "cancelled" card instead of vanishing with the container.
   */
  async spawnSubAgent(req: SubAgentSpawnRequest): Promise<SubAgentRunResult> {
    const controller = new AbortController();
    this._subAgentAborts.set(req.spawnId, { controller, agentId: req.agentId });
    // planning#246 — synchronously, before the first await below, so the marker
    // already counts this consult by the time the caller resumes.
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

  /**
   * planning#280 — abort every in-flight sub-agent spawn brokered by this runner.
   * Called from {@link dispose} (the one chokepoint every force-teardown path
   * funnels through: Restart agent, Restart container, Rescue, archive, full
   * reset), so no caller has to remember to cancel spawns. `reason` reaches
   * `runSubAgent`'s catch via `WorkerAbortedError` and names who cancelled.
   */
  private cancelInFlightSubAgents(reason: string): void {
    for (const [spawnId, spawn] of this._subAgentAborts) {
      console.warn(`[sub-agent] cancelled session=${this.sessionId} spawn=${spawnId} by=${reason}`);
      try { spawn.controller.abort(reason); } catch { /* best-effort */ }
    }
    this._subAgentAborts.clear();
    this.announceBackgroundWork();
  }

  getAgent(): AgentProcess | null { return this._agent; }

  /**
   * planning#318 — tell the proxy that is being pushed out of the `_agent` slot by a
   * DIFFERENT, newer one that its turn has been superseded.
   *
   * This is the moment the displaced turn loses its ability to settle itself:
   * its own `agent_done` / `agent_error` will arrive after the slot moved on and
   * be ignored by {@link isStaleSpawnEvent} (docs/146). That guard is right — it
   * stops a stale exit from tearing down the live turn — but nothing then told
   * the displaced turn it was over, so its settlement stayed pending forever. In
   * production that stranded a self-merge wake at `merge-observed`, which the
   * retry supervisor could not distinguish from a delivery that never reached
   * the session, so it re-delivered the identical wake prompt 7.5 minutes later.
   *
   * Deliberately only fired for a REPLACEMENT (`a !== null`), never for
   * `setAgent(null)`: clearing the slot is the normal end-of-turn teardown (the
   * proxy has already emitted `done`), and the two paths that clear it without a
   * terminal event — `verifyRunningState` and `dispose` — have their own,
   * correctly-`dropped` settlement signals (`turn_abandoned` / `disposed`). A
   * superseded turn is the opposite case: it RAN.
   */
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
    // When the orchestrator sets the agent, it's creating a new one to run.
    // For the container runner, we create a proxy that receives events via SSE.
    this.supersedeDisplacedAgent(a as ProxyAgentProcess | null);
    this._agent = a as ProxyAgentProcess | null;
    // See SessionRunner.setAgent — dropping the ref normally invalidates the
    // previously-applied permission mode so the next turn re-applies cleanly.
    // BUT for a container/persistent session the worker's StreamingClaudeProcess
    // survives proxy-agent recreation across WS reloads, so clearing the mode
    // here would make the orchestrator "forget" the CLI is still pinned to
    // `--permission-mode plan` — the mode-change gate then compares against
    // `undefined` and never pushes the freeing `set_permission_mode`, wedging
    // the session ("can't exit plan mode"). Preserve the applied mode while the
    // streaming process is still alive (`isStreamingActive`); a genuine process
    // exit clears the flag and the next non-reuse spawn overwrites the mode at
    // `run()` anyway.
    if (a === null && !this._isStreamingActive) {
      this._appliedPermissionMode = undefined;
      // The spawn-time model follows the same rule: the worker's streaming
      // process outlives proxy recreation and keeps running its `--model`, so
      // the drift check must keep comparing against it until the process
      // genuinely exits.
      this._appliedSpawnIdentity = undefined;
      this._residentRoute = undefined;
    }
  }

  // --- Message queue ---

  get messageQueue(): QueuedMessage[] { return this.turn.messageQueue; }
  get queueLength(): number { return this.turn.queueLength; }
  enqueue(msg: QueuedMessage): number { return this.turn.enqueue(msg); }
  dequeue(): QueuedMessage | undefined { return this.turn.dequeue(); }
  clearQueue(): void { this.turn.clearQueue(); }
  getQueueSnapshot(): { text: string; position: number }[] { return this.turn.getQueueSnapshot(); }

  /** planning#266 — see `SessionRunnerInterface.activeDeliveryId`. */
  activeDeliveryId: string | undefined;
  /** planning#266 — see `SessionRunnerInterface.hasDelivery`. */
  hasDelivery(deliveryId: string): boolean {
    if (this.activeDeliveryId === deliveryId) return true;
    return this.turn.messageQueue.some((m) => m.deliveryId === deliveryId);
  }

  /**
   * planning#318 — see `SessionRunnerInterface.hasTurnInFlight`.
   *
   * Reads the worker's `turnActive`, NOT its `running`: `running` is
   * `agent !== null`, which stays true for a resident streaming process between
   * turns (that is the whole point of live steering), so it would report a
   * perfectly idle session as busy and block a legitimate retry forever.
   * `turnActive` is the worker's own turn bracket (`beginTurn` / `endTurn`).
   *
   * A legacy worker that doesn't publish `turnActive` falls back to `running`,
   * which is the conservative answer for the one thing this gates: not spawning
   * over a live process.
   */
  async hasTurnInFlight(): Promise<boolean> {
    if (this._isRunning) return true;
    const status = await workerGet(this.workerUrl, "/agent/status", { timeoutMs: 3000 }) as WorkerAgentStatus;
    return status.turnActive ?? status.running;
  }

  // --- Terminal ---

  getTerminal(): TerminalProcess | null { return this._terminal; }
  setTerminal(t: TerminalProcess | null): void { this._terminal = t; }

  /** Whether the remote terminal inside the container is running. */
  get remoteTerminalRunning(): boolean { return this.termBuf.running; }

  appendTerminalOutput(data: string): void { this.termBuf.append(data); }
  getTerminalOutputBuffer(): string { return this.termBuf.buffer; }
  clearTerminalOutputBuffer(): void { this.termBuf.clear(); }

  // --- Turn event buffer ---

  getTurnEventBuffer(): WsServerMessage[] { return this.turn.getTurnEventBuffer(); }
  clearTurnEventBuffer(): void { this.turn.clearTurnEventBuffer(); }

  get lastPersistedBufferIndex(): number { return this.turn.lastPersistedBufferIndex; }
  set lastPersistedBufferIndex(v: number) { this.turn.lastPersistedBufferIndex = v; }

  emitMessage(msg: WsServerMessage): void {
    this.turn.pushTurnEvent(msg);
    this.emit("message", msg);
  }

  // --- Detected ports ---

  get detectedPorts(): number[] { return this._detectedPorts; }
  set detectedPorts(ports: number[]) { this._detectedPorts = ports; }

  get presentations(): PresentStateEntry[] { return this._presentations; }

  /**
   * Apply a present_content entry to the local cache, mirroring the client
   * store's reducer. `presentId` is content-addressed by the file path, so a
   * known id means the same file was re-presented → replace it in place
   * (keeping its carousel slot); a new id → append.
   */
  private cachePresentation(entry: PresentStateEntry): void {
    const existing = this._presentations.findIndex((p) => p.presentId === entry.presentId);
    if (existing >= 0) {
      this._presentations[existing] = entry;
      return;
    }
    this._presentations.push(entry);
  }

  /** Timestamp of the most recent SSE event from the worker, or 0 if none yet. */
  get lastSseEventAt(): number { return this.sse.lastActivityAt; }

  /**
   * `Date.now()` of the moment the worker `/events` stream went down without
   * coming back; 0 while it is up. Surfaced for the missing-container
   * reconciler — see `SseConnectionManager.streamDownSince`.
   */
  get workerStreamDownSince(): number { return this.sse.streamDownSince; }

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
   *
   * Passing `null` detaches the current manager without attaching a new one —
   * used when a `shipit.yaml` change drops the `compose:` block entirely.
   */
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
      });

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
      // docs/192 — unified channel-keyed transport. Live service lines ride
      // the same `log_append` envelope as agent lines, keyed by channel, and
      // render through the same `<LogView>`. Raw chunk, no per-line source.
      this.emitMessage({
        type: "log_append",
        channel: `service:${name}`,
        records: [{ ts: new Date().toISOString(), text }],
      });
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
      });

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
        plugins: snapshot.plugins,
      });

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

  /**
   * Log a reconcile failure. User-actionable errors (invalid compose file,
   * malformed YAML — common while the user is mid-edit or while a merge has
   * left conflict markers in the file) are logged as a single-line warning
   * with the error message only; the stack trace is suppressed because the
   * cause is the file content, not a bug in the orchestrator. Unexpected
   * errors still get a full `console.error` so we don't swallow real bugs.
   */
  private logReconcileError(prefix: string, err: unknown): void {
    const name = err instanceof Error ? err.name : "";
    const message = err instanceof Error ? err.message : String(err);
    // ComposeValidationError wraps YAMLParseError (and other user-file
    // problems) from `parseComposeFile`. Treat both names defensively in
    // case the wrapping is bypassed in a future code path.
    if (name === "ComposeValidationError" || name === "YAMLParseError") {
      console.warn(`[container-runner:${this.sessionId}] ${prefix}: ${message}`);
      return;
    }
    console.error(`[container-runner:${this.sessionId}] ${prefix}:`, err);
  }

  // --- Viewer management ---

  get viewerCount(): number { return this._viewerCount; }
  get lastViewerDetachAt(): number { return this._lastViewerDetachAt; }

  attachViewer(): void {
    this._viewerCount++;
    // Clear the detach timestamp on any attach — a viewer is back, and the
    // grace period only matters when no viewers are attached. If viewers
    // come and go later, the timestamp will be re-armed only when the LAST
    // one detaches (see detachViewer() below).
    this._lastViewerDetachAt = 0;
    console.log(`[container-runner:${this.sessionId}] attachViewer (count=${this._viewerCount}, disposed=${this._disposed})`);
    // Lazy-start worker resources on first viewer attach. Same machinery
    // is also invoked from `_startAgentViaProxy` so a system-turn (spawned
    // child) without an attached viewer still has SSE connected before
    // the worker's `/agent/start` fires the CLI.
    void this.ensureWorkerResourcesStarted();
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
  createAgent(agentId: AgentId, opts?: { runToken?: string; deliveryId?: string }): ProxyAgentProcess {
    const proxy = new ProxyAgentProcess(agentId, this, opts);
    // planning#318 — this is one of the two places a spawn can take the slot from a
    // proxy that never reached a terminal event; the displaced turn has to be
    // told, or it can never settle. See `supersedeDisplacedAgent`.
    this.supersedeDisplacedAgent(proxy);
    this._agent = proxy;
    return proxy;
  }

  /**
   * Called by ProxyAgentProcess.run(). Waits for worker readiness, POSTs
   * /agent/start, and kicks off SSE setup in the background.
   *
   * The HTTP call is deliberately unbounded (`timeoutMs: 0`). The worker
   * accepts /agent/start synchronously, spawns the CLI, and returns
   * `{ started: true }`. Agent events stream over SSE, but the worker
   * also buffers them in a ring keyed by monotonic seq — so we no
   * longer need SSE to be connected before /agent/start. If SSE comes
   * up late (spawned-child sessions never have a viewer attached at
   * dispatch time) the events are replayed via `?since=<seq>` on
   * connect. Worker liveness is still monitored via the SSE idle timer;
   * if the worker is genuinely dead, the SSE stream fails and the
   * Rescue-session UI surfaces it. (Refines doc 124 §1.3.)
   */
  async _startAgentViaProxy(agentId: AgentId, params: AgentRunParams, runToken?: string, deliveryId?: string): Promise<void> {
    // Serialize start sequences per runner. The B2 recovery path below can
    // kill the worker's agent and start a fresh one; if a second caller is
    // mid-kill+restart at the same moment, the two sequences tear down each
    // other's agents (SIGHUP 129 / SIGTERM 143 loop — docs/124 follow-up).
    // Chaining on `_startInFlight` makes each start observe a settled worker
    // state before it begins. Errors don't poison the chain (`.catch`).
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
    // The gate above is ALSO resolved by `dispose()` (so pending awaiters don't
    // leak when creation fails before `setWorkerUrl`). Reaching here with no
    // real worker means this turn has nowhere to run — fail with the recorded
    // cause rather than POSTing to the placeholder address.
    this.assertWorkerReachable("/agent/start");

    await this.fastForwardStaleWorkerEventsBeforeFreshStart();

    // Kick off SSE setup BEFORE waiting on the install gate. The install
    // gate (`_waitForInstallBeforeAgent`) resolves on the SSE-delivered
    // `install_done` event — without an SSE consumer the worker's event
    // sits in the ring buffer forever and we deadlock. For spawned-child
    // sessions no viewer ever calls `attachViewer()`, so this is the only
    // place that wires SSE up. The worker buffers agent events too, so a
    // slow handshake here doesn't drop the first agent events either; the
    // `?since=<seq>` replay on connect makes the order purely a kickoff
    // concern. Fire-and-forget — idempotent against later `attachViewer()`.
    void this.ensureWorkerResourcesStarted();

    await this._waitForInstallBeforeAgent();

    try {
      await workerPost(this.workerUrl, "/agent/start", { agentId, params, runToken, deliveryId }, { timeoutMs: 0 });
    } catch (err) {
      // Narrow race: the previous turn's `agent_done` SSE event reaches the
      // orchestrator and triggers the queue drain → new POST /agent/start —
      // but the worker hasn't yet executed `this.agent = null` in its own
      // `agent.on("done")` handler (session-worker.ts wireAgentEvents). The
      // worker rejects with 409 "Agent already running". The window is
      // microseconds wide; one short retry clears it.
      //
      // If the retry ALSO 409s, the worker is holding a stale agent that will
      // not clear on its own — most often a persistent `StreamingClaudeProcess`
      // (live steering) whose turn errored without the process exiting, so the
      // worker's `done`/`error` handlers never ran. `_startAgentViaProxy` is
      // only reached when the orchestrator believes no turn is active, so a
      // lingering worker agent here is always a desync: kill it and start
      // fresh rather than stranding the session in "Agent already running"
      // forever. See docs/142 (Problem B2).
      if (err instanceof Error && err.message === "Agent already running") {
        await new Promise((r) => setTimeout(r, 150));
        try {
          await workerPost(this.workerUrl, "/agent/start", { agentId, params, runToken, deliveryId }, { timeoutMs: 0 });
        } catch (retryErr) {
          if (retryErr instanceof Error && retryErr.message === "Agent already running") {
            // Name the stale resident as the kill's victim when the worker can
            // tell us who it is. This kill is the desync clear, so it must
            // still fire — but untargeted, a kill that TIMES OUT client-side
            // and executes on a wedged worker minutes later (the 2026-08-09
            // incident had a ~9-minute-late kill) would land on whatever spawn
            // is resident by then, including the one the retry below starts.
            // Targeted at the reported resident, a late execution against a
            // reused slot no-ops. Status probe failure → untargeted, exactly
            // today's behavior.
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
      // docs/240 — never fast-forward past a turn that is still in flight. This
      // probe can land after our own `/agent/start` (it is fired without an
      // await from the start path), and skipping a live turn's already-emitted
      // events would silently truncate the turn.
      if (status.turnActive === true) return;
      this.sse.fastForwardLastSeenSeq(status.latestSseSeq ?? 0);
    } catch {
      // Best-effort only. If the probe fails, keep the existing since=0 path
      // so spawned/headless turns still prefer possible replay over event loss.
    }
  }

  /**
   * Before the FIRST SSE connect for this runner, advance the worker-event
   * cursor past any turn that has already COMPLETED on the worker, so the
   * `since=0` replay doesn't re-deliver a finished turn into a fresh runner.
   *
   * On a fresh orchestrator `_lastSeenSeq` starts at 0, so the first connect
   * would otherwise replay the worker's entire ring buffer — including the
   * last turn that finished before the orchestrator restarted. Routed into
   * the (possibly already re-created) `_agent` slot, those stale assistant
   * events get re-persisted as part of the next turn: the turn renders twice
   * and the duplicate survives a reload (the post-deploy double-render bug).
   *
   * `fastForwardStaleWorkerEventsBeforeFreshStart()` already covers the
   * spawned/headless fresh-start path, but its guard short-circuits the moment
   * ANY viewer is present (`attachViewer` → `ensureWorkerResourcesStarted` sets
   * `_workerResourcesStarted`). So for an interactive session a human is
   * watching — exactly the reported repro — that fast-forward never runs. This
   * method closes that gap by fast-forwarding on the viewer-driven first
   * connect too.
   *
   * Gated on there being no LIVE turn: if a turn is genuinely still in flight,
   * a viewer attaching mid-turn MUST still replay it, so we anchor the cursor
   * at the turn's own start seq instead (docs/240) and adopt the turn. We only
   * skip the replay of a turn that already finished.
   *
   * No-op once SSE is connected (advancing the cursor after connect would skip
   * live events) and best-effort on probe failure (keep the `since=0` path so
   * a slow/unreachable worker still prefers replay over event loss).
   */
  private async reconcileWorkerTurnBeforeFirstConnect(): Promise<void> {
    if (this.sse.isConnected) return;
    let status: WorkerAgentStatus;
    try {
      status = await workerGet(this.workerUrl, "/agent/status", { timeoutMs: 3000 }) as WorkerAgentStatus;
    } catch {
      // Best-effort only — preserve the since=0 replay path on probe failure.
      return;
    }

    // docs/240 — a turn is STILL RUNNING inside the container while this runner
    // has no agent object for it: the orchestrator restarted mid-turn (or the
    // runner was recreated after an idle eviction that the running agent should
    // have blocked). Adopt it — rebuild the proxy + listeners and replay from
    // the turn's first event — instead of letting the replay drop `(no _agent)`.
    if (status.turnActive === true && !this._agent && !this._isRunning) {
      if (await this.adoptWorkerTurn(status)) return;
      // Adoption unavailable (no system-turn deps wired). Fall through: leave
      // the cursor at since=0 so the events are at least replayed to whatever
      // takes the slot next, matching the pre-docs/240 behavior.
      return;
    }

    // A live turn on a runner that already knows about it — leave the cursor
    // alone so the mid-turn viewer catches up (the docs/237 snapshot path).
    if (status.turnActive === true) return;
    // Legacy worker (no `turnActive` field) with a resident process: can't tell
    // in-flight from idle-resident, so keep the conservative full replay.
    if (status.turnActive === undefined && status.running) return;

    this.sse.fastForwardLastSeenSeq(status.latestSseSeq ?? 0);
  }

  /**
   * docs/240 — adopt a turn the worker still has in flight. Fills the `_agent`
   * slot with a proxy carrying the WORKER's run token (so the turn's eventual
   * `agent_done` correlates instead of being ignored as a stale spawn), anchors
   * the SSE replay cursor at the turn's first event, and wires the standard
   * listener + post-turn flow through `adoptInFlightTurn`.
   *
   * Must complete BEFORE the SSE stream connects — the slot has to be occupied
   * when the replay lands. Returns false when the runner has no system-turn deps
   * (the registry always wires them in production; a bare test runner may not).
   */
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
    // The ring buffer is bounded (5000 events), so a very long turn can outrun
    // it. We still adopt — the tail is worth far more than nothing — but say so,
    // because the turn's earliest rows are then unrecoverable.
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
      // planning#266 — the adopted turn keeps the delivery identity the worker
      // reported, so a re-spawn on this proxy (auth retry) carries it too.
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

  /**
   * docs/240 — public entry point for the post-restart reattach sweep
   * (`restart-turn-reattach.ts`). Connects worker resources (which probes the
   * worker and adopts any in-flight turn — see
   * `reconcileWorkerTurnBeforeFirstConnect`) and reports whether this runner
   * ended up owning a running turn.
   *
   * Idempotent and safe to call on an idle session: it does exactly what a
   * viewer attach would do, minus the viewer count.
   */
  async resumeInFlightTurn(): Promise<boolean> {
    if (this._disposed) return false;
    await this.ensureWorkerResourcesStarted();
    return this._isRunning;
  }

  /**
   * Ensure SSE is connected and worker resources are marked as started.
   * Used both by `attachViewer` (lazy on first viewer) and by
   * `_startAgentViaProxy` (so headless system-turns started without a
   * viewer don't drop the worker's initial agent events). Idempotent.
   */
  private async ensureWorkerResourcesStarted(): Promise<void> {
    if (this._disposed) return;
    if (this._workerResourcesStarted) {
      // docs/240 — a start is still in flight: await IT rather than racing
      // ahead to `connectEventStream`. The first start may be mid-probe,
      // about to adopt an in-flight worker turn, and adoption must fill the
      // `_agent` slot BEFORE the stream opens or the replay is dropped.
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

  /** The one-time body of {@link ensureWorkerResourcesStarted}. */
  private async _doStartWorkerResources(): Promise<void> {
    // Reconcile against the worker's turn state before the very first connect:
    // skip the ring-buffer replay of an already-completed turn (the post-restart
    // double-render bug), or ADOPT a turn still in flight (docs/240) so its
    // replay lands in a live agent instead of being dropped. See the method.
    await this.reconcileWorkerTurnBeforeFirstConnect();
    await this.connectEventStream();
    if (!this._disposed) void this.startWorkerResources();
  }

  /**
   * Start an agent on the worker. Creates a proxy AgentProcess locally
   * that receives events via the SSE stream. Convenience method for tests.
   */
  async startAgentOnWorker(agentId: AgentId, params: AgentRunParams): Promise<ProxyAgentProcess> {
    await this._workerReady;

    // Kick SSE BEFORE the install-gate wait — same chicken-and-egg as
    // `_startAgentViaProxy`. See the comment there.
    void this.ensureWorkerResourcesStarted();

    await this._waitForInstallBeforeAgent();
    const proxy = new ProxyAgentProcess(agentId, this);
    this.supersedeDisplacedAgent(proxy);
    this._agent = proxy;

    await workerPost(this.workerUrl, "/agent/start", { agentId, params, runToken: proxy.runToken }, { timeoutMs: 0 });

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

  /**
   * Kill the agent running on the worker.
   *
   * planning#290 — the slot clear is IDENTITY-GUARDED against the proxy that was in
   * the slot when the kill was requested. `ProxyAgentProcess.kill()` is
   * fire-and-forget, so this POST is routinely still in flight while the caller
   * synchronously moves on. Both retirement blocks in `dispatched-turn.ts` do
   * exactly that:
   *
   *     outgoing.kill(); runner.setAgent(null); createAgent(); // → new proxy
   *
   * An unconditional `this._agent = null` here then landed tens of ms LATER, on
   * the slot that by then held the INCOMING proxy — and nothing reinstalls it.
   * Every event of the new turn, including its own `agent_init` and
   * `agent_result`, was dropped `(no _agent)` by the SSE relay for the rest of
   * the turn. In prod that hung `runRebaseResolutionTurn` until its 10-minute
   * timeout, which then aborted a conflict resolution the agent had already
   * completed.
   *
   * Capturing the victim synchronously (before the first await) and comparing on
   * resolve makes the clear a no-op once the slot has moved on. When the victim
   * IS still in the slot, the clear happens exactly as before.
   *
   * The WORKER side needs the same guard (prod incident 2026-08-09, session
   * 468191f5): a `/agent/kill` that executed ~9 minutes late SIGTERMed the NEW
   * resident streaming process mid-turn — the slot-clear guard above fired
   * ("not clearing the incoming agent") but the wrong process was already dead.
   * `victimRunToken` names the intended victim in the POST body; the worker
   * no-ops when its resident spawn is not that victim. Only passed by callers
   * that know their victim (`ProxyAgentProcess.kill()`); recovery paths omit it
   * on purpose — they clear whatever the worker holds, orchestrator-view-stale
   * or not.
   */
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
    // A caller that named its victim killed AT MOST that spawn: when the slot
    // holds a different spawn (a late kill from a retired proxy — the slot was
    // reused before its fire-and-forget kill even started), the worker
    // no-opped, the resident is alive, and clearing the slot would strand its
    // event stream — the planning#290 symptom through the front door.
    if (opts?.victimRunToken !== undefined && this._agent?.runToken !== opts.victimRunToken) {
      console.warn(
        `[container-runner:${this.sessionId}] /agent/kill victim ${opts.victimRunToken} is not the slot occupant — nothing was killed, not clearing the slot`,
      );
      return;
    }
    this._agent = null;
  }

  /** Write to the agent's stdin on the worker. */
  async writeAgentStdin(data: string): Promise<void> {
    await workerPost(this.workerUrl, "/agent/stdin", { data });
  }

  /** Inject a user message into the running streaming agent (live steering, docs/140). */
  async sendAgentMessage(text: string): Promise<void> {
    await workerPostMessage(this.workerUrl, text);
  }

  /**
   * Change the streaming agent's permission mode mid-process (docs/138 /
   * docs/140). `null` on the wire means ShipIt "auto" (no flag); the worker
   * adapter maps to the CLI's `default` mode.
   */
  async setAgentPermissionModeOnWorker(mode: PermissionMode | undefined): Promise<void> {
    await workerPost(this.workerUrl, "/agent/permission-mode", { mode: mode ?? null });
  }

  /**
   * docs/178 — ask the resident agent on the worker to compact its context
   * (`/compact`). The worker calls `agent.compact()` on the in-container adapter
   * (streaming Claude → inject `/compact`; live Codex → `thread/compact/start`).
   */
  async compactAgentOnWorker(instructions?: string): Promise<void> {
    await workerPost(this.workerUrl, "/agent/compact", instructions ? { instructions } : undefined);
  }

  /**
   * docs/193 — deliver the user's approve/deny answer for a pending permission
   * request to the worker's broker, which unblocks the held bridge/RPC call.
   */
  async resolvePermissionOnWorker(requestId: string, decision: PermissionDecision): Promise<void> {
    await workerPost(this.workerUrl, "/agent/permission/resolve", {
      requestId,
      behavior: decision.behavior,
      ...(decision.remember ? { remember: true } : {}),
      ...(decision.message ? { message: decision.message } : {}),
    });
  }

  // --- Worker communication: terminal ---

  /** Start a terminal PTY inside the container. */
  async startTerminalOnWorker(cols?: number, rows?: number): Promise<void> {
    await workerPost(this.workerUrl, "/terminal/start", { cols, rows });
    this.termBuf.running = true;
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
   * Fetch Codex's built-in system skills from inside the container
   * (`~/.codex/skills/**`). Short timeout — it's a small directory scan that
   * feeds the composer's `/` autocomplete, so a wedged worker must not block
   * the skills route. See docs/138-skill-invocation (change #5b).
   */
  async getCodexBuiltinSkills(): Promise<SkillInfo[]> {
    await this._workerReady;
    const res = await workerGet(this.workerUrl, "/codex/skills", { timeoutMs: 3000 }) as { skills?: SkillInfo[] };
    return res.skills ?? [];
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

  /**
   * Fetch a presentation's raw bytes on demand (docs/093). The worker reads the
   * file from disk fresh and returns `{ content, mimeType }`; nothing is cached
   * orchestrator-side. Backs the authenticated `GET …/present/:id/content`
   * route the Present tab renders from.
   *
   * After a container restart the new worker's `PresentRegistry` is empty, so
   * the first read 404s. When we hold a durable record for the id, re-register
   * it with the fresh worker (handing back the persisted `resolvedPath`) and
   * retry once. If the file is genuinely gone (a `/tmp` throwaway after a
   * restart), the retry 404s too — propagated so the Present tab shows a
   * graceful "no longer available" placeholder.
   */
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
      // Re-register with the (possibly fresh) worker, then retry. A failure to
      // register surfaces the original error rather than masking it.
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

  // --- Worker resource lifecycle ---

  /**
   * Start the file watcher on the session worker. Idempotent on both sides —
   * the worker returns `{ existing: true }` when it is already watching — so
   * this is re-issued on every SSE (re)open as a self-heal (see `onSseOpen`).
   */
  private async startWorkerResources(): Promise<void> {
    await this._workerReady;
    if (this._disposed) { console.log(`[container-runner:${this.sessionId}] Disposed before worker ready`); return; }

    // Start file watcher on session worker
    try {
      const res = await workerPost(this.workerUrl, "/files/watch") as { existing?: boolean };
      if (!res?.existing) {
        console.log(`[container-runner:${this.sessionId}] File watcher started on worker`);
      }
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
  private _installComplete: Promise<{ ok: boolean }> | null = null;
  private _resolveInstallComplete: ((result: { ok: boolean }) => void) | null = null;
  /**
   * True while the orchestrator believes an install is in flight on the
   * worker. Used by the SSE reconnect path: if our SSE stream drops between
   * `install_status: running` and the worker emitting `install_done`, the
   * completion event would be silently lost. On reconnect we re-poll the
   * worker's install state via `/install/status` and synthesize a completion.
   */
  private _installInFlight = false;
  /**
   * True once the current install cycle's POST /install has returned. Guards
   * `resyncInstallStateAfterReconnect`: the SSE stream is opened inside
   * `runInstall` BEFORE the POST is sent, so the first-connect resync can
   * probe `/install/status` while the worker has not yet seen the install at
   * all — `{ running: false, lastResult: null }` — and the "worker restarted"
   * heuristic would synthesize a completion for an install that hasn't
   * started. Observed live on the docs/183 canary: the install gate resolved
   * ~100ms after worker-ready while npm ran 20s+ in the background, so the
   * overlay publish hook snapshotted a not-yet-installed dep dir.
   */
  private _installPostIssued = false;

  /**
   * #1622 — dependency-change auto-reinstall state. `_depReinstallCommands` is
   * this session's `agent.install` and `_depReinstallInputs` the resolved set
   * of dependency input files to watch (lockfiles + manifests, from
   * `resolveDepsHashInputs`), both pushed by `setupServiceManager` via
   * {@link setDepReinstallInputs}. When the file watcher reports one of those
   * inputs changed — including from a git operation, which rewrites files on
   * disk like any edit — we re-run install and restart gated services. The
   * cooldown fields throttle that (see {@link DEP_REINSTALL_COOLDOWN_MS}).
   */
  private _depReinstallCommands: string[] = [];
  private _depReinstallInputs: string[] = [];
  private _lastDepReinstallAt = 0;
  private _depReinstallPending = false;
  private _depReinstallTimer: ReturnType<typeof setTimeout> | null = null;

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
  /**
   * docs/262 — ask the container to link its plugin checkouts under `/plugins`
   * (and unlink what is no longer declared), materialize each imported plugin's
   * skills, and CARRY THE RESULT BACK to the Plugins card. Called when an
   * activation round settles, so the generation the worker reads is already
   * published, and again whenever a container comes up.
   *
   * Fire-and-forget and never throws: a plugin that will not prepare must not
   * take the session down with it (req 13). Only container runners have this —
   * local mode runs the agent in-process with no container to mount into, so
   * the whole container-side surface is absent there by design.
   *
   * req 13 — degrade *visibly*. A skill that could not be materialized is a
   * plugin that silently does less than it says, so the failure travels to the
   * same card the orchestrator half's failures reach; it used to end at the
   * `console.warn` below and go nowhere the user could see.
   */
  async preparePlugins(): Promise<void> {
    await this._workerReady;
    if (this._disposed) return;
    // Captured BEFORE the request, so a result arriving after this session was
    // disposed and recreated is dropped rather than written onto the new one.
    const record = beginContainerPrepare(this.sessionId);
    let result: unknown;
    try {
      this.assertWorkerReachable("/plugins/prepare");
      result = await workerPost(this.workerUrl, "/plugins/prepare", undefined, {
        timeoutMs: PLUGIN_PREPARE_TIMEOUT_MS,
      });
    } catch (err) {
      // Deliberately NOT recorded as "no failures". Nothing reached the
      // container, so whatever the last successful prepare left there is still
      // what the agent sees: clearing the record would replace an observed
      // problem with health nobody observed, and inventing one would attach a
      // transport error to every plugin card. The previous record stands.
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
    // Only when the recorded set moved: prepare runs on every activation round
    // and every container start, and the healthy case is by far the common one.
    // An unconditional push would double the tab's refetches to say nothing.
    if (record(failures)) this.emitMessage({ type: "plugin_repos_updated", sessionId: this.sessionId });
  }

  async runInstall(commands: string[]): Promise<{ ok: boolean }> {
    if (commands.length === 0) return { ok: true };

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
      return this._installComplete;
    }
    const completion = this._installComplete = new Promise<{ ok: boolean }>((resolve) => {
      this._resolveInstallComplete = resolve;
    });
    this._installInFlight = true;
    this._installPostIssued = false;

    await this._workerReady;
    if (this._disposed) {
      this.signalInstallComplete();
      return { ok: true };
    }
    // Same gate-resolved-by-dispose caveat as `_doStartAgentViaProxy`: a runner
    // whose container never came up is not disposed in every path, so check the
    // worker itself rather than inferring reachability from `_disposed`.
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

    // Open our end of the event pipe BEFORE posting /install. The completion
    // promise above resolves on the SSE-delivered `install_done` / `install_error`
    // event — without an SSE consumer the worker's event sits in its ring
    // buffer and we never resolve. For spawned-child sessions, no viewer ever
    // calls `attachViewer()`, so this is the only place that wires SSE up
    // before the wait. Fire-and-forget — idempotent against later attaches.
    void this.ensureWorkerResourcesStarted();

    this.emitMessage({
      type: "install_status",
      sessionId: this.sessionId,
      status: "running",
      command: commands[0],
    });

    try {
      // The worker returns `{ started: true }` (or `{ skipped: true }`) fast
      // and streams completion via SSE. We still bound the POST so a wedged
      // worker resolves the gate (as a failure) via the catch below instead of
      // hanging the user's first turn forever.
      const result = await workerInstall(this.workerUrl, commands, {
        timeoutMs: INSTALL_POST_TIMEOUT_MS,
      }) as { skipped?: boolean; started?: boolean; ok?: boolean };
      this._installPostIssued = true;
      if (result.skipped) {
        this.emitMessage({
          type: "install_status",
          sessionId: this.sessionId,
          status: "skipped",
        });
        this.signalInstallComplete();
        return { ok: true };
      }
      // Started — wait for SSE-delivered install_done / install_error to
      // resolve the completion promise with the success/failure outcome.
      // Re-run the status resync once now that the POST has landed: the
      // SSE-open resync may have fired before the POST (and correctly
      // skipped via the post-issued guard), so the lost-install_done
      // recovery must not depend on SSE-connect timing. If the worker is
      // mid-install this probe is a no-op (`running: true` → wait for the
      // real event); if the install already settled and the event was
      // lost, it resolves the gate deterministically.
      void this.resyncInstallStateAfterReconnect();
      return await completion;
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

  /**
   * #1622 — record this session's install commands and the dependency input
   * files (lockfiles + manifests) whose change should trigger an auto-reinstall.
   * Pushed by `setupServiceManager` once it has resolved `shipit.yaml`. An empty
   * `inputs` (no install configured, or a non-content-keyable install such as a
   * shell script) disables auto-reinstall for this session — the safe default.
   */
  setDepReinstallInputs(commands: string[], inputs: string[]): void {
    this._depReinstallCommands = commands;
    this._depReinstallInputs = inputs;
  }

  /**
   * The `agent.install` command list currently applied to this session — i.e.
   * what `shipit.yaml` said the last time the config was read. Compared against
   * a freshly-resolved config so a rebase that changes `agent.install` actually
   * re-runs it (see `applyShipitConfigChange`).
   */
  get appliedInstallCommands(): readonly string[] {
    return this._depReinstallCommands;
  }

  /**
   * Ask for a re-run of the recorded `agent.install`, subject to the same
   * cooldown + install-gate bracketing as the dependency-input-driven
   * reinstall. Used when `shipit.yaml`'s `agent.install` itself changes.
   */
  requestDepReinstall(): void {
    this.maybeReinstallForDepChange();
  }

  /**
   * Re-read the workspace's `shipit.yaml` + compose file and apply whatever
   * changed to this live session.
   *
   * Two callers: the in-container file watcher (a config file was edited), and
   * orchestrator-side workspace rewrites — a rebase/sync replaces the whole
   * working tree from outside the container, and the inotify-based watcher is
   * not a signal we can depend on there (it is started best-effort, and a
   * cross-mount event can be missed entirely). The orchestrator knows exactly
   * when it rewrote the tree, so it says so directly.
   *
   * `onComposeConfigChanged` is wired by the runner registry to
   * `applyShipitConfigChange`, which owns the full delta (compose path,
   * docker-socket, `agent.install`, compose added/removed). The reconcile-only
   * fallback keeps runners built without that wiring (unit tests) working.
   */
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

  /**
   * True when a changed path is one of this session's dependency input files.
   * Paths arrive workspace-relative; the watcher and `git` may prefix `./`, so
   * normalize before comparing. Pure so the predicate is unit-testable.
   */
  private isDepInputChange(paths: string[]): boolean {
    if (this._depReinstallInputs.length === 0) return false;
    return paths.some((p) => this._depReinstallInputs.includes(p.replace(/^\.\//, "")));
  }

  /**
   * #1622 — a dependency input file changed (edit OR git operation). Re-run
   * install so the agent container and gated services pick up the new tree,
   * throttled by {@link DEP_REINSTALL_COOLDOWN_MS}. Leading-edge: fire at once
   * when idle; while a reinstall is in flight or within the cooldown, set a
   * pending flag and arm a single trailing timer so the final lockfile state is
   * always installed. The worker `/install` marker gate makes a no-op change a
   * fast skip, so triggering eagerly is safe.
   */
  private maybeReinstallForDepChange(): void {
    if (this._disposed) return;
    if (this._depReinstallCommands.length === 0) return;

    const now = Date.now();
    const elapsed = now - this._lastDepReinstallAt;
    const inFlight = this._installComplete !== null;
    if (inFlight || (this._lastDepReinstallAt !== 0 && elapsed < ContainerSessionRunner.DEP_REINSTALL_COOLDOWN_MS)) {
      // Coalesce into one trailing reinstall after the cooldown window.
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

  /**
   * Run the bracketed mid-session reinstall: open the install gate (which holds
   * + tears down `dependsOnInstall` services), re-run `agent.install`, then
   * close the gate (which relaunches them against the fresh tree, or latches
   * them to `error` on failure). Mirrors the bracket in `setupServiceManager`.
   */
  private async reinstallForDepChange(): Promise<void> {
    const mgr = this._serviceManager;
    console.log(`[container-runner:${this.sessionId}] dependency input changed — reinstalling`);
    mgr?.setInstallRunning(true);
    let res: { ok: boolean } = { ok: true };
    try {
      res = await this.runInstall(this._depReinstallCommands);
    } catch {
      res = { ok: false };
    } finally {
      mgr?.setInstallRunning(false, { failed: !res.ok });
    }
  }

  /**
   * Resolve the in-flight install promise (idempotent). `ok` carries whether
   * the install succeeded — propagated to the ServiceManager install gate so
   * a failed install latches dependent services to `error` rather than
   * starting them (docs/137).
   */
  private signalInstallComplete(ok = true): void {
    this._installInFlight = false;
    if (this._resolveInstallComplete) {
      const r = this._resolveInstallComplete;
      this._resolveInstallComplete = null;
      r({ ok });
    }
    this._installComplete = null;
  }

  /**
   * Re-poll the worker for its current install state when an SSE stream opens
   * (first connect or reconnect). If the worker finished install while we had
   * no attached consumer — or the `install_done`/`install_error` event raced
   * our handshake and was lost — synthesize the completion locally so a) the
   * awaiting `runInstall` resolves and b) the client gets the terminal
   * `install_status` it would have seen.
   *
   * No-op when no install was in flight from our POV (avoids double-emitting
   * for the steady-state reconnect-during-idle case). Idempotent against the
   * real event and the HTTP-response fast-path resolution — `signalInstallComplete`
   * only fires once.
   */
  private async resyncInstallStateAfterReconnect(): Promise<void> {
    if (!this._installInFlight || this._disposed) return;
    // The current cycle's POST /install hasn't returned yet — the worker may
    // not have seen the install at all, so a `{ running: false, lastResult:
    // null }` probe result means "not started", NOT "worker restarted".
    // `runInstall` re-runs this resync right after the POST lands, so the
    // lost-event recovery is preserved without racing the POST.
    if (!this._installPostIssued) return;
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
    this.signalInstallComplete(last.ok);
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
    return this.sse.connect();
  }

  /**
   * Called by the SSE manager when a fresh stream opens. On reconnect with
   * a running terminal we replay buffered output prefixed with a terminal
   * reset sequence so xterm.js starts from a known-good state.
   *
   * With an in-flight install we re-poll the worker so we don't hang forever
   * waiting for an `install_done` event that was lost — and we do this on the
   * FIRST connect too, not just reconnects (docs/163). The fast-install path
   * can finish and broadcast `install_done` before our SSE consumer is even
   * attached; if that event raced our handshake, the buffered-replay/live
   * delivery could be consumed before the gate resolver is armed, leaving the
   * gate stuck. Probing `/install/status` on first open is a deterministic
   * backstop: if the worker already finished, `resyncInstallStateAfterReconnect`
   * synthesizes the completion and resolves the gate. (The primary fix is the
   * worker resolving a cache HIT in the /install HTTP response; this is belt
   * and braces for the streamed real-install path.)
   */
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
    // Re-arm the worker's file watcher on every stream open. `/files/watch` is
    // otherwise a single best-effort POST fired once per runner
    // (`startWorkerResources`): if it fails, or the worker restarts under a
    // live runner, the watcher stays dead for the rest of the session — no file
    // tree updates AND no compose reconcile on a config-file change, silently.
    // The worker endpoint is idempotent (an already-running watcher answers
    // `existing: true`), so re-posting here is free and self-healing.
    void this.startWorkerResources();
  }

  /**
   * Called by the SSE manager when the stream errors or closes. If the
   * remote terminal is running, emits `terminal_reconnecting` so the
   * client can render a banner, and bumps the terminal-only reconnect
   * counter. Returning `false` aborts the manager's auto-reconnect when
   * we've exceeded the terminal-only cap.
   */
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

  /**
   * Decide whether a slot-ending worker event (`agent_done` / `agent_error` /
   * `agent_auth_required`) belongs to a PREVIOUS spawn that no longer owns the
   * runner's `_agent` slot — i.e. a stale exit that must be ignored.
   *
   * The worker stamps the spawning proxy's `runToken` (a per-spawn epoch) onto
   * these events. We compare it against the token of the proxy CURRENTLY in the
   * slot. A mismatch means the slot was reused (the rebase / Fix-CI flow killed
   * the resident process and spawned a fresh one) and this event is the old
   * process's late exit. Emitting it would run the live agent's done handler
   * and null `_agent`, stranding the new turn's whole event stream — the prod
   * bug this guard fixes.
   *
   * Backward/forward compatible: if the event carries no `runToken` (legacy
   * worker) or the slot proxy has none, we DON'T treat it as stale — the
   * existing object-identity guards and `verifyRunningState` safety net still
   * apply, and the "missed agent_done" SSE-drop resilience path is preserved.
   */
  private isStaleSpawnEvent(
    eventType: string,
    data: Record<string, unknown>,
    // planning#290 — `agent_event` may be routed to the tracked streaming proxy
    // rather than the slot occupant (the docs/146 re-adopt branch), so the
    // comparison is against whichever proxy would actually receive it.
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

  private handleSSEEvent(event: SSEEvent): void {
    try {
      const data = JSON.parse(event.data) as Record<string, unknown>;
      this.sse.markActivity();

      switch (event.type) {
        // --- Agent events ---

        case "agent_event": {
          // docs/146 follow-up — when the slot is null but a resident streaming
          // process is still mid-turn, re-adopt the tracked streaming proxy
          // instead of dropping. That is the prod stranding: a stale / one-shot
          // spawn displaced the streaming proxy and then exited, nulling
          // `_agent`, while the live streaming process kept emitting. A
          // genuinely-orphaned stream has `isStreamingActive === false` (the
          // streaming `done` clears it), so this never resurrects a dead turn.
          const target = this._agent
            ?? (this._isStreamingActive ? this._streamingProxy : null);
          if (!target) {
            // docs/140 diag — events arriving with no orchestrator-side agent
            // ref AND no live streaming turn mean a genuinely-orphaned stale
            // streaming process in the worker is still emitting after the
            // orchestrator already finalized the turn (setAgent(null) on
            // agent_result). Drop is correct; the log correlates with the
            // double-spawn / double-bubble repro.
            const eventType = (data as { type?: string }).type ?? "unknown";
            console.warn(`[sse-drop:${this.sessionId}] agent_event type=${eventType} dropped (no _agent)`);
            break;
          }
          // planning#290 — a retired spawn's late event must not be routed into the
          // turn that replaced it. Unstamped events (the permission broker's
          // frames, a legacy worker) fall through as before.
          if (this.isStaleSpawnEvent("agent_event", data, target)) break;
          this._agent = target;
          // The token is transport-level correlation, not part of the event
          // contract — strip it so `AgentEvent` consumers see what they always did.
          const { runToken: _staleGuardToken, ...payload } = data;
          target.emit("event", payload as unknown as AgentEvent);
          break;
        }

        case "agent_done":
          if (this._agent && !this.isStaleSpawnEvent("agent_done", data)) {
            this._agent.emit("done", (data.exitCode as number) ?? 0);
          }
          break;

        case "agent_error":
          if (this._agent && !this.isStaleSpawnEvent("agent_error", data)) {
            this._agent.emit("error", new Error((data.message as string) ?? "Unknown worker error"));
          }
          break;

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

        // --- Terminal events ---

        case "terminal_data":
          this.appendTerminalOutput(data.data as string);
          this.emitMessage({ type: "terminal_output", data: data.data as string });
          break;

        case "terminal_exit":
          this.termBuf.running = false;
          this.emitMessage({ type: "terminal_exit", exitCode: data.exitCode as number | null });
          break;

        // --- Service control requests (from agent via worker) ---

        case "service_request": {
          const requestId = data.requestId as string;
          const action = data.action as string;
          const name = data.name as string | undefined;
          const lines = data.lines as number | undefined;
          // Handle asynchronously — don't block SSE processing
          void this.handleServiceRequest(requestId, action, name, lines);
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

        case "install_error": {
          const message = (data.message as string) ?? "Install failed";
          // Log to the orchestrator stdout (the service-log stream Ops reads),
          // not only `emitMessage` — a recreate-after-idle install runs with no
          // viewer attached, so an emit-only failure is effectively swallowed
          // (the original incident surfaced only as a stale `install_ok=false`).
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
            });
          }
          break;
        }

        // --- Present tool events (docs/093) ---

        case "present_content": {
          const evt = data as {
            presentId?: string;
            mimeType?: string;
            title?: string;
            filePath?: string;
            createdAt?: string;
            // docs/093 — the worker's container-internal absolute path. Carried
            // on the SSE event (NOT the client-facing WS message) so the
            // orchestrator can persist it and re-register the artifact with a
            // freshly-started worker after a container restart.
            resolvedPath?: string;
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
            };
            this.cachePresentation(entry);
            // Persist durably so the Present tab survives a container restart.
            // resolvedPath is required to re-serve bytes later; skip persistence
            // if a (legacy) worker didn't send it — the in-memory cache still works.
            if (this._presentStore && typeof evt.resolvedPath === "string") {
              this._presentStore.record({
                presentId: entry.presentId,
                sessionId: this.sessionId,
                filePath: entry.filePath,
                resolvedPath: evt.resolvedPath,
                mimeType: entry.mimeType,
                createdAt: entry.createdAt,
                ...(entry.title !== undefined ? { title: entry.title } : {}),
              });
            }
            this.emitMessage({
              type: "present_content",
              sessionId: this.sessionId,
              presentId: entry.presentId,
              mimeType: entry.mimeType,
              ...(entry.title !== undefined ? { title: entry.title } : {}),
              filePath: entry.filePath,
              createdAt: entry.createdAt,
            });
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
          // Mirror the clear into durable storage so a dropped/superseded
          // presentation doesn't resurrect after a restart.
          this._presentStore?.clear(this.sessionId, evt.presentId);
          this.emitMessage({
            type: "present_cleared",
            sessionId: this.sessionId,
            ...(typeof evt.presentId === "string" ? { presentId: evt.presentId } : {}),
          });
          break;
        }

        // --- File watcher events ---

        case "file_changes": {
          const paths = (data.paths as string[]) ?? [];
          this.emitMessage({ type: "files_changed", paths });

          // Detect config file changes and re-evaluate the session's config
          const hasConfigChange = paths.some(p =>
            ContainerSessionRunner.CONFIG_FILES.has(p) ||
            ContainerSessionRunner.CONFIG_FILES.has(p.replace(/^\.\//, "")),
          );
          if (hasConfigChange) {
            console.log(`[container-runner:${this.sessionId}] Config file changed, re-evaluating session config`);
            this.reevaluateWorkspaceConfig();
          }

          // #1622 — a dependency input file (lockfile/manifest) changed. This
          // fires for git operations (reset/checkout/rebase) as well as direct
          // edits, since they rewrite files on disk the watcher reports. Re-run
          // install + restart gated services so a stale dep tree can't leave the
          // preview 500'ing on an unresolved import.
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

  // --- Service control request handling ---

  /**
   * Handle a service control request from the agent (received via SSE from the worker).
   * Performs the action via ServiceManager and POSTs the result back to the worker.
   */
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

      /**
       * Read a service back out of the manager AFTER the mutation + `pollOnce`.
       *
       * docs/238 — start/restart used to return a hardcoded
       * `{ status: "running" }`, throwing away the fresh poll they had just
       * performed. A container that started and immediately exited (a dev server
       * with no `node_modules`, exit 127) still reported `running`, so the agent
       * proceeded against a dead service. Reporting the polled status makes a
       * failed start legible as a failed start.
       */
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
        case "list":
          result = {
            services: mgr.getServices().map(s => ({
              name: s.name,
              status: s.status,
              port: s.port,
              preview: s.preview,
              url: s.url,
              error: s.error,
            })),
          };
          break;
        case "start": {
          if (!name) throw new Error("Service name is required");
          // Report an already-running service as a no-op rather than silently
          // re-`up`ing it, so the agent doesn't have to guess whether its start
          // was the thing that brought the service up.
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
          // Same source as the orchestrator's logs route: the durable log store
          // when it has been seeded, else a fresh `docker compose logs --tail`.
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

  assertCanDispatch(): void {
    const authorize = this._systemTurnDeps?.authorizeDispatch;
    if (!authorize) {
      if (process.env.NODE_ENV === "test") return;
      throw new AgentTurnAdmissionError(this.sessionId);
    }
    authorize(this.sessionId);
  }

  /**
   * docs/240 — the send-or-queue rule lives in ONE place (`dispatchOnRunner`)
   * that both runner implementations delegate to, rather than being copied
   * field-for-field into each. Takes a branded `PreparedDispatch` and returns a
   * `TurnHandle`.
   */
  dispatch(opts: PreparedDispatch): TurnHandle {
    return dispatchOnRunner(this, this._systemTurnDeps, opts);
  }

  get canRunDispatchedTurn(): boolean { return this._systemTurnDeps !== null; }

  /** planning#301 — see `SessionRunnerInterface.schedulePostTurnPush`. */
  schedulePostTurnPush(): void {
    this._systemTurnDeps?.scheduleAutoPush(this.sessionDir);
  }

  /** planning#257 — the queue-drain re-entry for `execution: "dispatched"` entries. */
  async runDispatchedTurn(opts: PreparedDispatch): Promise<void> {
    await runDispatchedTurn(this, this._systemTurnDeps!, this._agentId, opts, (agentId) => {
      return this.createAgent(agentId);
    });
  }

  // --- Lifecycle ---

  onAgentFinished(): void {
    if (!this._isRunning && this.turn.queueLength === 0) {
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
   * `session_status` message, settle the abandoned turn, release the queue, and
   * signal idle so the runner is reclaimable.
   *
   * planning#282 — the reset alone was not a recovery. It restored `running` and
   * emitted `idle`, but the phantom turn had TWO other things hanging off it:
   *
   *  1. Anything QUEUED behind it. Every other drain in the system is reached
   *     from a turn that actually ran (the executor's post-turn drain, the WS
   *     drain, `dispatchOnRunner`'s setup-failure release), and none of them can
   *     fire for a turn whose events never arrived. So a wake-turn enqueued
   *     behind the phantom sat in the queue indefinitely — until a human
   *     happened to send a new message, which ran immediately and whose own
   *     post-turn drain picked the entry up. In the field that was 40+ minutes
   *     and counting, with the entry visibly stuck in the queue chip.
   *  2. Its SETTLEMENT. The turn never reached the executor's settling
   *     `finally`, so `onTurnComplete` never fired and `activeDeliveryId` stayed
   *     published — which reads as "this delivery is still in flight" and
   *     suppresses every retry (`isDeliveryInFlight`). That is the stranding
   *     class planning#265 / planning#266 / docs/240 closed, reached through the one path
   *     they did not cover.
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
    this._isStreamingActive = false;
    this._streamingProxy = null;
    // docs/235 — the streaming process is gone, so its background tasks went
    // with it. The count getter already gates on `isStreamingActive`; clearing
    // here keeps the tracker from holding a stale list across a respawn.
    this._backgroundTasks.clear();
    // planning#246 — written directly rather than through the setters, so the
    // marker needs saying: the reconciler just declared this session's agent
    // dead, and nothing else will tell the sidebar.
    this.announceBackgroundWork();
    this._appliedPermissionMode = undefined;
    this._appliedSpawnIdentity = undefined;
      this._residentRoute = undefined;
    this._agent = null;
    this.emitMessage({
      type: "session_status",
      sessionId: this.sessionId,
      running: false,
      queueLength: this.queueLength,
      error: "Agent state was out of sync with the worker — reset. You can send a new message.",
    });
    // The delivery stops being live BEFORE its consumer is told, for the reason
    // `executeAgentTurn.settleTurn` spells out: the consumer's first act on a
    // non-`completed` outcome is to ask whether a retry is warranted, and a
    // delivery still reading as in-flight would suppress it forever. Safe to
    // clear unconditionally here — `running` is false, so no turn owns it.
    this.activeDeliveryId = undefined;
    this.emit("turn_abandoned");
    // Release the queue before signalling idle. `releaseQueuedTurn` re-enters
    // the branded `dispatch` path, so a dispatched entry keeps its `systemTurn`
    // / `onTurnComplete` / `postTurn` fields instead of being re-narrowed into
    // an interactive turn (the planning#257 / planning#261 rule — see `queue-drain.ts`).
    // When it starts a turn the runner is NOT idle, so the `idle` event that
    // drives auto-remediation and `waitForIdle` is deliberately not emitted;
    // that turn's own post-turn flow signals idle when it finishes.
    if (releaseQueuedTurn(this)) return false;
    this.emit("idle");
    return false;
  }

  get disposed(): boolean { return this._disposed; }

  dispose(opts?: { force?: boolean; preserveAgent?: boolean }): void {
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
    // planning#280 — same protection for a BACKGROUNDED sub-agent consult. docs/236
    // tells agents to background long consults, so the primary turn routinely
    // finishes while the spawn keeps running — `_isRunning` is false and idle
    // cleanup would otherwise reap a live 30-minute review that nothing is
    // wrong with. An explicit teardown (`{ force: true }`) still proceeds and
    // cancels it below; only the lifecycle-driven paths defer.
    if (this._subAgentAborts.size > 0 && !opts?.force) {
      console.log(
        `[container-runner:${this.sessionId}] dispose() skipped — ${this._subAgentAborts.size} sub-agent spawn(s) in flight`,
      );
      return;
    }
    // …and for a turn's TERMINAL SEQUENCE, which runs with `running` already
    // false: the auto-commit, the PR flow and the settlement all land after
    // `tryDrain` clears the flag. Production disposed a runner 31 ms after a
    // completed turn's commit, which cancelled the debounced push below and
    // reported the finished turn to the CI auto-fix loop as never-run. Bounded
    // by `post-turn-hold.ts`, so a wedged sequence cannot pin the container.
    if (this._postTurnHold.active && !opts?.force) {
      console.log(
        `[container-runner:${this.sessionId}] dispose() skipped — a turn's post-turn sequence is still running`,
      );
      return;
    }
    // An ARMED auto-push takes the same hold, so the guard above covers it too
    // — the reason the two used to be separate terms was that `dispose()`
    // cancelled the timer it found on this object, and there is no longer one to
    // find. The push now outlives a forced teardown as well
    // (`services/auto-push-scheduler.ts`).
    this._disposed = true;
    this._postTurnHold.reset();

    // docs/113 — `preserveAgent` is the orchestrator-shutdown path, and it must
    // not reach into the worker AT ALL. Keeping the container alive across an
    // update is only half of "running turns survive": the CLI inside it has to
    // keep running too. The kill below clears the worker's `turnActive`
    // (`agent-controller.ts` → `endTurn()`), and the next orchestrator's
    // `reattachInFlightTurns()` (docs/240) adopts a turn ONLY while
    // `turnActive === true` — so killing here leaves a live turn unadoptable,
    // its transcript tail unpersisted and its post-turn commit unrun, with the
    // edits sitting in the working tree. That is the half of the 2026-08-10
    // incident that surviving containers alone does not fix.
    //
    // Everything below this block is local state and still runs: the runner
    // object dies with the process either way.
    if (!opts?.preserveAgent) {
      // planning#280 — cancel in-flight sub-agent spawns BEFORE the container goes
      // away. Their HTTP requests are the only handle we have on them; without
      // this abort the awaiting `runSubAgent` either hangs on a half-open socket
      // or rejects minutes later, and either way the consult vanishes from the
      // transcript with no terminal card.
      this.cancelInFlightSubAgents("runner disposed");

      // Kill agent on worker (fire and forget). Names ITS OWN spawn as the
      // victim: the container outlives this runner (a new runner may reconnect
      // and adopt or start a fresh spawn), so an untargeted kill delayed on a
      // slow worker could land on that successor's live process — the 2026-08-09
      // incident class. Targeted, a late execution against a reused slot no-ops.
      if (this._agent) {
        workerPost(this.workerUrl, "/agent/kill", { runToken: this._agent.runToken }).catch(() => {});
      }
    }
    // Drop the local proxy either way — it is an in-memory object that cannot
    // outlive this process. On the preserve path its worker-side spawn keeps
    // running and is re-proxied by the next orchestrator's reattach sweep.
    this._agent = null;

    // Don't stop worker resources (preview, file watcher) — the container
    // stays alive and a new runner may reconnect to it. Stopping the preview
    // would force a full restart on reconnect.

    this.stopReconcileTimer();
    if (this._depReinstallTimer) {
      clearTimeout(this._depReinstallTimer);
      this._depReinstallTimer = null;
    }
    this._depReinstallPending = false;
    this.clearServiceManager();
    this.sse.disconnect();
    // Resolve any awaiters of in-flight install so they don't leak.
    this.signalInstallComplete();
    // Resolve `_workerReady` so any `whenWorkerReady().then(...)` chain
    // pending against a placeholder-URL runner doesn't leak when the
    // container creation fails before `setWorkerUrl()` ever fires. The
    // chained `.then` will run with no meaningful worker — that's fine:
    // its callers (e.g. `adoptExistingServiceManager`'s connectToNetwork)
    // will hit "No container found" and the `.catch` handles it.
    this._resolveWorkerReady();
    // Same defense for the SSE-connect awaiter: if dispose runs before
    // the SSE stream actually opens, any `connectEventStream()` awaiter
    // would otherwise hang forever. Resolving here is safe — awaiters
    // that proceed past it check `this._disposed` and bail.
    this.sse.resolvePendingConnect();
    this.turn.reset();
    this._isRunning = false;
    this._isStreamingActive = false;
    this._streamingProxy = null;
    // docs/235 — the streaming process is gone, so its background tasks went
    // with it. The count getter already gates on `isStreamingActive`; clearing
    // here keeps the tracker from holding a stale list across a respawn.
    this._backgroundTasks.clear();
    this._appliedPermissionMode = undefined;
    this._appliedSpawnIdentity = undefined;
      this._residentRoute = undefined;
    // planning#246 — same as above, and before `removeAllListeners()` takes the
    // channel away. A disposed runner holds nothing outstanding, and idle
    // reclaim, rescue, restart and archive all land here without a draining
    // event of their own.
    this.announceBackgroundWork();
    this.termBuf.reset();
    this.emit("disposed");
    this.removeAllListeners();
  }
}
