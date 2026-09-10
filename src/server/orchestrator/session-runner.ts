import { isCompactCommand } from "../shared/compact-command.js";
import type { ProviderRouteKind } from "../shared/types/domain-types/provider.js";
import type { BillingMode } from "../shared/catalogue/types.js";
import { EventEmitter } from "node:events";
import type { AgentProcess, AgentId, TerminalProcess, AgentRunParams, SessionInfo, SessionMessageOrigin } from "../shared/types.js";
import type { WsServerMessage, ImageAttachment, FileContextRef, UploadRef, PermissionMode, ClaudeContentBlockToolUse, SkillInfo } from "../shared/types.js";
import type { PresentStateEntry } from "../shared/types/ws-server-messages.js";
import type { ServiceManager } from "./service-manager.js";
import type { DependencyGap } from "./dependency-staleness.js";
import type { AgentListenerDeps } from "./ws-handlers/agent-listeners.js";
import type { PersistedMessage, ResolvedBugReport } from "./chat-history.js";
import type { SecretFinding } from "../shared/secret-scan.js";
import type { UnreadableWorkspace } from "../shared/git.js";
import type { SubAgentSpawnRequest, SubAgentRunResult, SubAgentRunHandle } from "../shared/sub-agent-run.js";
import { runAgentToCompletion, buildSubAgentRunParams } from "../shared/sub-agent-run.js";
import type { AgentInterfaceProvenance } from "../shared/agent-interface-sdk/protocol.js";
import type { PreTurnResetHookResult, PreTurnResetRunner } from "./pre-turn-reset-hook.js";

// Dispatch and steering live separately to avoid runtime cycles through agent-listeners.
import { BackgroundTaskTracker, type BackgroundTaskInfo } from "./background-task-tracker.js";
import { getAgentDisplayName } from "../shared/agent-registry.js";
import { runDispatchedTurn } from "./dispatched-turn.js";
export { runDispatchedTurn };

import { trySteerDispatch } from "./dispatch-steering.js";
import { resetVoiceNoteTurnState } from "./voice/voice-note-router.js";
import {
  createCommittedBodyIds,
  clearCommittedBodyIds,
  type CommittedBodyIds,
} from "./transcript-projection.js";

import {
  withSettlement,
  queuedMessageToDispatchOptions,
  type PreparedDispatch,
} from "./prepared-dispatch.js";
import {
  createTurnSettlement,
  settleDroppedQueueEntries,
  turnDropped,
  turnErrored,
  turnInterrupted,
  TURN_STEERED,
  type TurnHandle,
  type TurnOutcome,
} from "./turn-settlement.js";
import { PostTurnHold } from "./post-turn-hold.js";
export {
  prepareDispatch,
  queuedMessageToDispatchOptions,
  type PreparedDispatch,
  type AgentDispatchInit,
} from "./prepared-dispatch.js";
export type { TurnHandle, TurnOutcome, TurnOutcomeStatus } from "./turn-settlement.js";

export interface ToolResultEntry {
  toolUseId: string;
  content: string;
  isError?: boolean;
  /** Elapsed time from tool use to result, including any human approval wait. */
  durationMs?: number;
  /** Serve-only head slice; persistence retains the full body for the tool-results endpoint. */
  truncated?: true;
  totalLines?: number;
  totalBytes?: number;
}

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
  subagentEvents?: SubagentEvent[];
}

export interface SteeredMessage {
  /** Number of persistable assistant groups before this steer; preserves order on row replacement. */
  afterGroupIndex: number;
  text: string;
  agentInterface?: AgentInterfaceProvenance;
  messageOrigin?: SessionMessageOrigin;
  images?: { data: string; mediaType: string }[];
  files?: { path: string; contentPreview: string; startLine?: number; endLine?: number }[];
  uploadPaths?: string[];
  /** In-memory replay-ack key. Without an ack at turn end, this steer is re-queued. */
  assembledPrompt?: string;
  delivered?: boolean;
}

// Add side-channel cards through emitChatCard so they persist at their transcript position.
export interface RecordedChatCard {
  afterGroupIndex: number;
  message: PersistedMessage;
}

export interface QueuedMessage {
  text: string;
  agentInterface?: AgentInterfaceProvenance;
  messageOrigin?: SessionMessageOrigin;
  /** Interactive entries already have a client bubble; dispatched entries need the full executor. */
  execution: "interactive" | "dispatched";
  activity?: string;
  images?: ImageAttachment[];
  files?: FileContextRef[];
  uploads?: UploadRef[];
  permissionMode?: PermissionMode;
  postTurn?: "commit-push" | "none";
  systemTurn?: boolean;
  onTurnComplete?: (outcome: TurnOutcome) => void;
  deliveryId?: string;
  dictated?: boolean;
  resetMergedBranch?: boolean;
  compactContext?: boolean;
  silent?: boolean;
}

export interface AgentDispatchOptions {
  text: string;
  agentInterface?: AgentInterfaceProvenance;
  messageOrigin?: SessionMessageOrigin;
  execution?: "interactive" | "dispatched";
  activity?: string;
  images?: ImageAttachment[];
  files?: FileContextRef[];
  uploads?: UploadRef[];
  permissionMode?: PermissionMode;
  /** None leaves commit, push, PR flow and drain to the owning driver, such as rebase. */
  postTurn?: "commit-push" | "none";
  /** Blocks live steering into this turn. */
  systemTurn?: boolean;
  /** Prefer the returned TurnHandle for new completion consumers. */
  onTurnComplete?: (outcome: TurnOutcome) => void;
  /** Persisted to the worker so delivery settlement can be rebound after orchestrator restart. */
  deliveryId?: string;
  dictated?: boolean;
  resetMergedBranch?: boolean;
  compactContext?: boolean;
  /** Suppress the user bubble and row for a ShipIt-initiated compaction turn. */
  silent?: boolean;
}

export const REPOSITORY_UNTRUSTED_CODE = "repository_untrusted" as const;
export const REPOSITORY_UNTRUSTED_MESSAGE =
  "Trust this repository before sending messages to the agent.";

export class AgentTurnAdmissionError extends Error {
  readonly statusCode = 403;
  readonly code = REPOSITORY_UNTRUSTED_CODE;

  constructor(public readonly sessionId: string) {
    super(REPOSITORY_UNTRUSTED_MESSAGE);
    this.name = "AgentTurnAdmissionError";
  }
}

export function dispatchOnRunner(
  runner: SessionRunnerInterface,
  deps: SystemTurnDeps | null,
  opts: PreparedDispatch,
): TurnHandle {
  // Admission must precede all state changes, persistence, preparation and process creation.
  runner.assertCanDispatch();
  const settlement = createTurnSettlement();

  const enqueueAndReport = (): TurnHandle => {
    const position = runner.enqueue(toQueuedMessage(withSettlement(opts, settlement)));
    runner.emitMessage({ type: "message_queued", text: opts.text, position });
    return settlement;
  };

  if (runner.running) {
    // Test steering before attaching settlement: a completion callback makes a dispatch unsteerable.
    if (deps && trySteerDispatch(runner, opts, deps)) {
      settlement.settle(TURN_STEERED);
      return settlement;
    }
    return enqueueAndReport();
  }
  if (!deps) return enqueueAndReport();

  // A system driver can own the tree between turns; only its own resolution step may enter.
  if (runner.systemTurnInProgress && !(opts.systemTurn && opts.postTurn === "none")) {
    return enqueueAndReport();
  }

  if (runner.mergeHold) return enqueueAndReport();

  // System turns replace the resident process, which would destroy its background work.
  if (
    opts.systemTurn
    && runner.getAgent() !== null
    && runner.backgroundWorkDescriptions.length > 0
  ) {
    return enqueueAndReport();
  }

  // Claim synchronously so another message or delivery retry cannot enter during async setup.
  if (opts.systemTurn) runner.systemTurnInProgress = true;
  runner.running = true;
  if (opts.deliveryId !== undefined) runner.activeDeliveryId = opts.deliveryId;
  const chained = withSettlement(opts, settlement);
  // Latch this turn's result: queue drain can replace runner state before settlement.
  // A turn that produced a result is interrupted, never dropped as if it had not run.
  let sawTurnResult = false;
  const ownIsCompact = isCompactCommand(opts.text);
  const onTurnResult = ({ compact }: { compact: boolean }): void => {
    if (compact && !ownIsCompact) return;
    if (runner.activeDeliveryId === opts.deliveryId) sawTurnResult = true;
  };
  const settleAsDropped = (reason: string): void => {
    if (settlement.isSettled) return;
    if (sawTurnResult) {
      console.warn(
        `[dispatch] settling the dispatched turn for ${runner.sessionId} as interrupted — ${reason}`
        + " (the turn had already produced its result)",
      );
      chained.onTurnComplete?.(
        turnInterrupted(`${reason} — after the turn produced its result`),
      );
      return;
    }
    console.warn(`[dispatch] settling the dispatched turn for ${runner.sessionId} as dropped — ${reason}`);
    chained.onTurnComplete?.(turnDropped(reason));
  };
  const onRunnerDisposed = (): void => settleAsDropped("runner disposed mid-turn");
  const onTurnAbandoned = (): void =>
    settleAsDropped("turn abandoned — worker reported no agent running");
  runner.on("turn_result", onTurnResult);
  runner.on("disposed", onRunnerDisposed);
  runner.on("turn_abandoned", onTurnAbandoned);
  void (async () => {
    await settlement.settled;
    runner.off("turn_result", onTurnResult);
    runner.off("disposed", onRunnerDisposed);
    runner.off("turn_abandoned", onTurnAbandoned);
  })();
  void runner.runDispatchedTurn(chained).catch((err: unknown) => {
    // Setup can fail before the executor owns settlement or cleanup.
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      `[dispatch] dispatched turn for ${runner.sessionId} failed during setup:`,
      err,
    );
    if (opts.systemTurn) runner.systemTurnInProgress = false;
    runner.running = false;
    if (opts.deliveryId !== undefined && runner.activeDeliveryId === opts.deliveryId) {
      runner.activeDeliveryId = undefined;
    }
    // Notify callback consumers too, but preserve an outcome the executor already settled.
    if (!settlement.isSettled) {
      chained.onTurnComplete?.(turnErrored(`dispatched turn failed to start: ${detail}`));
    }
    if (runner.queueLength > 0) {
      const next = runner.dequeue();
      if (next) {
        runner.emitMessage({ type: "queue_updated", queue: runner.getQueueSnapshot() });
        dispatchOnRunner(runner, deps, queuedMessageToDispatchOptions(next));
      }
    }
  });
  return settlement;
}

export function toQueuedMessage(opts: PreparedDispatch): QueuedMessage {
  // The dispatched executor preserves all options; defaulting to interactive would lose them.
  const queued: QueuedMessage = { text: opts.text, execution: opts.execution ?? "dispatched" };
  if (opts.agentInterface !== undefined) queued.agentInterface = opts.agentInterface;
  if (opts.messageOrigin !== undefined) queued.messageOrigin = opts.messageOrigin;
  if (opts.activity !== undefined) queued.activity = opts.activity;
  if (opts.images !== undefined) queued.images = opts.images;
  if (opts.files !== undefined) queued.files = opts.files;
  if (opts.uploads !== undefined) queued.uploads = opts.uploads;
  if (opts.permissionMode !== undefined) queued.permissionMode = opts.permissionMode;
  if (opts.postTurn !== undefined) queued.postTurn = opts.postTurn;
  if (opts.systemTurn !== undefined) queued.systemTurn = opts.systemTurn;
  if (opts.onTurnComplete !== undefined) queued.onTurnComplete = opts.onTurnComplete;
  if (opts.deliveryId !== undefined) queued.deliveryId = opts.deliveryId;
  if (opts.dictated !== undefined) queued.dictated = opts.dictated;
  if (opts.resetMergedBranch !== undefined) queued.resetMergedBranch = opts.resetMergedBranch;
  if (opts.compactContext !== undefined) queued.compactContext = opts.compactContext;
  if (opts.silent !== undefined) queued.silent = opts.silent;
  return queued;
}

export interface SystemTurnDeps {
  authorizeDispatch?: (sessionId: string) => void;
  agentFactory: (agentId: AgentId) => AgentProcess;
  autoCommit: (
    sessionDir: string,
    summary: string,
  ) => Promise<{
    commitHash: string | null;
    parentHash: string | null;
    conflictedFiles: string[];
    rebaseInProgress: boolean;
    secretFindings: SecretFinding[];
    unreadable: UnreadableWorkspace | null;
  }>;
  /** Pass sessionId so a push can be scheduled after the viewer disconnects. */
  scheduleAutoPush: (sessionDir: string, sessionId?: string) => void;
  listenerDeps: AgentListenerDeps;
  buildRunParams: (
    sessionId: string,
    agentId: AgentId,
    prompt: string,
    turnRoute?: { kind: ProviderRouteKind; id: string },
    opts?: { compact?: boolean },
  ) => Promise<AgentRunParams>;
  /** Restore a delivery's completion callback when adopting a turn after restart. */
  rebindDelivery?: (deliveryId: string) => ((outcome: TurnOutcome) => void) | undefined;
  postTurnPrFlow?: (
    sessionId: string,
    sessionDir: string,
    commitHash: string,
    emit: (msg: WsServerMessage) => void,
  ) => Promise<void>;
  /** Runs even without a commit: release proposals do not change files. */
  postTurnReleaseFlow?: (
    sessionId: string,
    sessionDir: string,
    turnText: string,
    emit: (msg: WsServerMessage) => void,
  ) => Promise<void>;
  /** Runs even without a commit: resetting the branch can leave a clean tree. */
  postTurnReArmReset?: (
    sessionId: string,
    sessionDir: string,
    emit: (msg: WsServerMessage) => void,
  ) => Promise<void>;
  preTurnReset?: (
    runner: PreTurnResetRunner,
    sessionId: string,
    sessionDir: string,
    intent?: boolean,
  ) => Promise<PreTurnResetHookResult>;
  shouldCompactBeforeTurn?: (
    runner: SessionRunnerInterface,
    agentId: AgentId,
    sessionId: string,
    sessionDir: string,
    intent?: boolean,
  ) => Promise<boolean>;
  consumePendingAgentNotice?: (sessionId: string) => string | undefined;
  /** Restore a consumed notice if setup fails before the agent receives it. */
  restorePendingAgentNotice?: (sessionId: string, notice: string) => void;
  /** At-most-once; unlike workspace notices, bug outcomes are not restored after setup failure. */
  consumeBugOutcomes?: (sessionId: string) => ResolvedBugReport[];
  /** Consumes the role's first-turn instructions; subsequent calls return an empty string. */
  takeRoleInstructions?: (sessionId: string) => string;
  finalizeAgentEnv?: (
    sessionId: string,
    agentId: AgentId,
    route?: Pick<SessionInfo, "providerRouteKind" | "providerRouteId">,
  ) => void;
  /** Sync immediately before run params: a sibling can rotate tokens during earlier preparation. */
  prepareAgentEnv?: (
    sessionId: string,
    agentId: AgentId,
    opts?: {
      /** Suppress credential topology repair under a live CLI. */
      reusingResidentAgent?: boolean;
      excludeRouteIds?: readonly string[];
      residentRoute?: { kind: ProviderRouteKind; id: string };
      requireResidentRoute?: boolean;
    },
  ) => Promise<{ turnRoute?: { kind: ProviderRouteKind; id: string } } | undefined>;
  needsAccountFailover?: (sessionId: string, agentId: AgentId) => boolean;
  recoverResidentRoute?: (sessionId: string, agentId: AgentId) => { kind: ProviderRouteKind; id: string } | undefined;
  routeLabel?: (routeId: string) => string | undefined;
  routeProfile?: (
    kind: ProviderRouteKind,
    routeId: string,
  ) => { billingMode: BillingMode; serviceId?: string } | undefined;
  ensureAgentTokenFresh?: (
    agentId: AgentId,
    accountId?: string,
    /** Runtime 401 recovery must force refresh even when expiry claims the token is valid. */
    opts?: { force?: boolean },
  ) => Promise<boolean>;
  /** Bypass expiry ordering after healing a token rejected by the CLI. */
  repushSessionAgentToken?: (sessionId: string, agentId: AgentId) => void;
  commitTurn?: (args: {
    sessionDir: string;
    sessionId: string;
    summary: string;
    turnStartHeadHash: string | null;
    runner: SessionRunnerInterface | null;
    emit: (msg: WsServerMessage) => void;
    /** Defer arming the push until the caller's synchronous PR-flow push has finished. */
    deferPushArm?: (arm: () => void) => void;
  }) => Promise<string | null>;
  steerInputs?: () => { liveSteering: boolean; steeringCapable: boolean };
}

export function resetRunnerTurnState(runner: SessionRunnerInterface): void {
  // Stale teardown must not change the successor's accumulators or in-progress rows.
  runner.turnEpoch = (runner.turnEpoch ?? 0) + 1;
  runner.clearTurnEventBuffer();
  runner.turnSummary = "";
  runner.accumulatedText = "";
  runner.accumulatedToolUse = [];
  runner.chatMessageGroups = [];
  runner.needsNewMessageGroup = true;
  runner.steeredMessages = [];
  runner.recordedCards = [];
  runner.wasInterrupted = false;
  runner.pendingCommitLink = null;
  clearCommittedBodyIds(runner.committedBodyIds);
  resetSubAgentSpawnBudget(runner);
  resetVoiceNoteTurnState(runner);
}

// Human live steering refills this budget without clearing the running turn's transcript.
// Agent-reachable steers must not let the agent refill its own budget.
export function resetSubAgentSpawnBudget(
  runner: Pick<SessionRunnerInterface, "subAgentSpawnsThisTurn">,
): void {
  runner.subAgentSpawnsThisTurn = 0;
}

// An idle turn can still have a resident CLI reading or rotating credentials.
export function sessionHasLiveAgent(
  registry: SessionRunnerRegistry | null | undefined,
  sessionId: string,
): boolean {
  return (registry?.get(sessionId)?.getAgent() ?? null) !== null;
}

export interface SessionRunnerEvents {
  message: [WsServerMessage];
  idle: [];
  disposed: [];
  /** Worker reconciliation found the turn gone without a terminal agent event. */
  turn_abandoned: [];
  /** Per-turn signal: each dispatch latches it before queue drain can replace runner state. */
  turn_result: [{ compact: boolean }];
  background_work: [];
}

export interface SessionRunnerInterface extends EventEmitter<SessionRunnerEvents> {
  readonly sessionId: string;
  readonly sessionDir: string;

  running: boolean;
  /** A system driver owns the turn or the interval between its turns; suppress live steering. */
  systemTurnInProgress: boolean;
  /** Separate from systemTurnInProgress so a turn's cleanup cannot release an in-flight merge. */
  mergeHold: boolean;
  wasInterrupted: boolean;
  turnEpoch: number;
  guardedUnavailable: boolean;
  readonly awaitingPermissionIds: Set<string>;
  /** Decaying CLI hints, gated on resident process liveness. */
  readonly backgroundTaskCount: number;
  readonly backgroundTaskDescriptions: string[];
  /** Actual brokered requests; these can outlive the main agent process. */
  readonly subAgentSpawnsInFlight: number;
  readonly subAgentSpawnLabels: string[];
  readonly backgroundWorkDescriptions: string[];
  /** Reclaim checks this union; running alone misses background and post-turn work. */
  readonly agentBusy: boolean;
  readonly postTurnWorkInFlight: boolean;
  /** Pair with endPostTurnWork in finally; also held for an armed auto-push. */
  beginPostTurnWork(): void;
  endPostTurnWork(): void;
  setBackgroundTasks(tasks: BackgroundTaskInfo[]): void;
  clearBackgroundTasks(): void;
  /** Actual resident process mode, distinct from the adapter's static steering capability. */
  isStreamingActive: boolean;
  appliedPermissionMode: PermissionMode | undefined;
  /** Full spawn tuple; comparing the model alone misses service and credential changes. */
  appliedSpawnIdentity: string | undefined;
  residentRoute: { kind: ProviderRouteKind; id: string } | undefined;
  lastTurnErrored: boolean;
  accumulatedText: string;
  accumulatedToolUse: ClaudeContentBlockToolUse[];
  turnSummary: string;
  chatMessageGroups: ChatMessageGroup[];
  needsNewMessageGroup: boolean;
  steeredMessages: SteeredMessage[];
  recordedCards: RecordedChatCard[];
  agentId: AgentId;
  /** Defer linking until final chat rows exist; an early agent_result can precede final text. */
  pendingCommitLink: { commitHash: string; parentCommitHash: string } | null;

  subAgentSpawnsThisTurn: number;

  /** Caller enforces authorization, credentials and budget; this leaves the main agent slot intact. */
  spawnSubAgent(req: SubAgentSpawnRequest): Promise<SubAgentRunResult>;

  getAgent(): AgentProcess | null;
  setAgent(a: AgentProcess | null): void;

  readonly messageQueue: QueuedMessage[];
  readonly queueLength: number;
  enqueue(msg: QueuedMessage): number;
  dequeue(): QueuedMessage | undefined;
  clearQueue(): void;
  getQueueSnapshot(): { text: string; position: number }[];

  activeDeliveryId: string | undefined;
  hasDelivery(deliveryId: string): boolean;
  /** Ask the process owner before destructive actions; the local running mirror can be stale. */
  hasTurnInFlight?(): Promise<boolean>;

  getTerminal(): TerminalProcess | null;
  setTerminal(t: TerminalProcess | null): void;
  appendTerminalOutput(data: string): void;
  getTerminalOutputBuffer(): string;
  clearTerminalOutputBuffer(): void;

  getTurnEventBuffer(): WsServerMessage[];
  clearTurnEventBuffer(): void;
  emitMessage(msg: WsServerMessage): void;
  lastPersistedBufferIndex: number;
  /** Stable set of persisted bodies that reconnect snapshots may omit; cleared each turn. */
  readonly committedBodyIds: CommittedBodyIds;

  detectedPorts: number[];

  readonly presentations?: PresentStateEntry[];
  readonly supportsRemoteTerminal?: boolean;
  /** Registration precedes container creation; missing-container scans must skip this window. */
  readonly awaitingContainer?: boolean;
  readonly lastSseEventAt?: number;
  readonly workerStreamDownSince?: number;
  createAgent?(agentId: AgentId): AgentProcess;
  getCodexBuiltinSkills?(): Promise<SkillInfo[]>;

  readonly viewerCount: number;
  attachViewer(): void;
  detachViewer(): void;
  readonly lastViewerDetachAt: number;
  buildPreviewStatus(): WsServerMessage;
  /** Do not send a preview snapshot until this is true. */
  readonly previewStatusKnown: boolean;
  waitForPreviewStatus(): Promise<void>;

  setServiceManager?(mgr: ServiceManager | null): void;
  /** Also call after orchestrator-side rewrites: in-container inotify may miss them. */
  reevaluateWorkspaceConfig?(): void;
  notifyWorkspaceRewritten?(rewrite?: string): void;
  readonly dependencyGap?: DependencyGap | null;
  resumeInFlightTurn?(): Promise<boolean>;

  setSystemTurnDeps(deps: SystemTurnDeps): void;
  assertCanDispatch(): void;
  dispatch(opts: PreparedDispatch): TurnHandle;
  /** Bypasses queue admission; requires canRunDispatchedTurn. */
  runDispatchedTurn(opts: PreparedDispatch): Promise<void>;
  readonly canRunDispatchedTurn: boolean;
  /** Schedule pushes for commits made outside a turn, including late sub-agent work. */
  schedulePostTurnPush(): void;

  onAgentFinished(): void;
  readonly disposed: boolean;
  /** preserveAgent leaves container-side work alive for restart adoption; local runners cannot preserve it. */
  dispose(opts?: { force?: boolean; preserveAgent?: boolean }): void;
  verifyRunningState(): Promise<boolean>;
}

export class SessionRunner extends EventEmitter<SessionRunnerEvents> implements SessionRunnerInterface {
  readonly sessionId: string;
  readonly sessionDir: string;

  private agent: AgentProcess | null = null;
  private _agentId: AgentId;
  private _isRunning = false;
  private _systemTurnInProgress = false;
  private _mergeHold = false;
  private _wasInterrupted = false;
  turnEpoch = 0;
  private _lastTurnErrored = false;
  private _guardedUnavailable = false;
  readonly awaitingPermissionIds = new Set<string>();
  private _backgroundTasks = new BackgroundTaskTracker();
  private _isStreamingActive = false;
  private _appliedPermissionMode: PermissionMode | undefined = undefined;
  private _appliedSpawnIdentity: string | undefined = undefined;
  private _residentRoute: { kind: ProviderRouteKind; id: string } | undefined = undefined;
  private _accumulatedText = "";
  private _accumulatedToolUse: ClaudeContentBlockToolUse[] = [];
  private _turnSummary = "";
  private _chatMessageGroups: ChatMessageGroup[] = [];
  private _needsNewMessageGroup = true;
  private _steeredMessages: SteeredMessage[] = [];
  private _recordedCards: RecordedChatCard[] = [];
  private _messageQueue: QueuedMessage[] = [];
  activeDeliveryId: string | undefined;
  private _terminal: TerminalProcess | null = null;
  private _terminalOutputBuffer = "";
  private static readonly MAX_TERMINAL_BUFFER = 10_000;
  private _turnEventBuffer: WsServerMessage[] = [];
  private static readonly MAX_TURN_BUFFER = 1000;
  private static readonly MAX_QUEUE_SIZE = 50;
  lastPersistedBufferIndex = 0;
  readonly committedBodyIds = createCommittedBodyIds();
  private _viewerCount = 0;
  private _detectedPorts: number[] = [];
  private _disposed = false;
  pendingCommitLink: { commitHash: string; parentCommitHash: string } | null = null;
  private _subAgentSpawnsThisTurn = 0;
  private _subAgentHandles = new Map<SubAgentRunHandle, AgentId>();
  private _lastAnnouncedWork = "[]";
  private _postTurnHold = new PostTurnHold();

  createAgent?: (agentId: AgentId) => AgentProcess;

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
    this._isStreamingActive = v;
    // Liveness changes the reported task list even when its stored entries did not change.
    this.announceBackgroundWork();
  }
  get backgroundTaskCount(): number { return this._backgroundTasks.count(this._isStreamingActive); }
  get backgroundTaskDescriptions(): string[] { return this._backgroundTasks.descriptions(this._isStreamingActive); }
  get subAgentSpawnsInFlight(): number { return this._subAgentHandles.size; }
  get subAgentSpawnLabels(): string[] {
    return [...this._subAgentHandles.values()].map((id) => `${getAgentDisplayName(id)} consult`);
  }
  get backgroundWorkDescriptions(): string[] {
    return [...this.backgroundTaskDescriptions, ...this.subAgentSpawnLabels];
  }
  get agentBusy(): boolean {
    return this._isRunning
      || this.backgroundTaskCount > 0
      || this.subAgentSpawnsInFlight > 0
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
  get recordedCards(): RecordedChatCard[] { return this._recordedCards; }
  set recordedCards(m: RecordedChatCard[]) { this._recordedCards = m; }
  get agentId(): AgentId { return this._agentId; }
  set agentId(id: AgentId) { this._agentId = id; }
  get subAgentSpawnsThisTurn(): number { return this._subAgentSpawnsThisTurn; }
  set subAgentSpawnsThisTurn(n: number) { this._subAgentSpawnsThisTurn = n; }

  async spawnSubAgent(req: SubAgentSpawnRequest): Promise<SubAgentRunResult> {
    const factory = this._systemTurnDeps?.agentFactory;
    if (!factory) {
      return { status: "error", text: "", truncated: false, durationMs: 0, costUsd: 0, error: "Sub-agent factory unavailable" };
    }
    const agent = factory(req.agentId);
    const runOpts = {
      prompt: req.prompt,
      cwd: this.sessionDir,
      model: req.model,
      ...(req.serviceRouting !== undefined ? { serviceRouting: req.serviceRouting } : {}),
      ...(req.homeDir !== undefined ? { homeDir: req.homeDir } : {}),
      ...(req.reasoningEffort !== undefined ? { reasoningEffort: req.reasoningEffort } : {}),
      ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
      ...(req.maxOutputChars !== undefined ? { maxOutputChars: req.maxOutputChars } : {}),
    };
    const handle = runAgentToCompletion(agent, runOpts, Date.now());
    this._subAgentHandles.set(handle, req.agentId);
    this.announceBackgroundWork();
    const prev = process.env.SHIPIT_AGENT_DEPTH;
    try {
      process.env.SHIPIT_AGENT_DEPTH = String(req.depth + 1);
      agent.run(buildSubAgentRunParams(runOpts));
      if (prev === undefined) Reflect.deleteProperty(process.env, "SHIPIT_AGENT_DEPTH");
      else process.env.SHIPIT_AGENT_DEPTH = prev;
      return await handle.promise;
    } finally {
      this._subAgentHandles.delete(handle);
      this.announceBackgroundWork();
      try { agent.kill(); } catch { /* already exited */ }
    }
  }

  getAgent(): AgentProcess | null { return this.agent; }
  setAgent(a: AgentProcess | null): void {
    // A displaced process cannot settle through its now-stale terminal events.
    if (a && this.agent && this.agent !== a) this.agent.emit("superseded");
    this.agent = a;
    // Preserve applied settings across proxy churn while the streaming CLI remains alive.
    if (a === null && !this._isStreamingActive) {
      this._appliedPermissionMode = undefined;
      this._appliedSpawnIdentity = undefined;
      this._residentRoute = undefined;
    }
  }

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
  hasDelivery(deliveryId: string): boolean {
    if (this.activeDeliveryId === deliveryId) return true;
    return this._messageQueue.some((m) => m.deliveryId === deliveryId);
  }
  clearQueue(): void {
    settleDroppedQueueEntries(this._messageQueue, "queue cleared");
    this._messageQueue.length = 0;
  }
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

  getTurnEventBuffer(): WsServerMessage[] { return [...this._turnEventBuffer]; }
  clearTurnEventBuffer(): void { this._turnEventBuffer = []; this.lastPersistedBufferIndex = 0; }
  emitMessage(msg: WsServerMessage): void {
    if (this._turnEventBuffer.length < SessionRunner.MAX_TURN_BUFFER) {
      this._turnEventBuffer.push(msg);
    } else if (this._turnEventBuffer.length === SessionRunner.MAX_TURN_BUFFER) {
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
    this._lastViewerDetachAt = 0;
  }
  detachViewer(): void {
    this._viewerCount = Math.max(0, this._viewerCount - 1);
    // Preserve the first final-detach timestamp across duplicate detach calls.
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
    this._systemTurnDeps?.scheduleAutoPush(this.sessionDir, this.sessionId);
  }

  async runDispatchedTurn(opts: PreparedDispatch): Promise<void> {
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

  async verifyRunningState(): Promise<boolean> {
    return this._isRunning;
  }

  get disposed(): boolean { return this._disposed; }
  dispose(opts?: { force?: boolean }): void {
    if (this._disposed) return;
    if (this._isRunning && !opts?.force) {
      console.log(`[session-runner:${this.sessionId}] dispose() skipped — agent is running`);
      return;
    }
    if (this._subAgentHandles.size > 0 && !opts?.force) {
      console.log(
        `[session-runner:${this.sessionId}] dispose() skipped — ${this._subAgentHandles.size} sub-agent spawn(s) in flight`,
      );
      return;
    }
    // Includes armed auto-push work after running becomes false.
    if (this._postTurnHold.active && !opts?.force) {
      console.log(
        `[session-runner:${this.sessionId}] dispose() skipped — a turn's post-turn sequence is still running`,
      );
      return;
    }
    this._disposed = true;
    this._postTurnHold.reset();
    for (const handle of this._subAgentHandles.keys()) {
      try { handle.cancel(); } catch { /* best-effort */ }
    }
    this._subAgentHandles.clear();
    if (this.agent) { this.agent.kill(); this.agent = null; }
    if (this._terminal) { this._terminal.kill(); this._terminal = null; }
    settleDroppedQueueEntries(this._messageQueue, "runner disposed");
    this._messageQueue.length = 0;
    this._turnEventBuffer = [];
    this._isRunning = false;
    this._isStreamingActive = false;
    this._backgroundTasks.clear();
    this._appliedPermissionMode = undefined;
    this._appliedSpawnIdentity = undefined;
      this._residentRoute = undefined;
    // Direct field clears bypass setters; report the change before removing listeners.
    this.announceBackgroundWork();
    this.emit("disposed");
    this.removeAllListeners();
  }
}

export type SessionRunnerFactory = (opts: {
  sessionId: string;
  sessionDir: string;
  defaultAgentId: AgentId;
  depCacheDir?: string;
}) => SessionRunnerInterface;

export class SessionRunnerRegistry {
  private runners = new Map<string, SessionRunnerInterface>();
  // Survives disposal so a stale viewer can detect replacement from the next snapshot.
  private incarnations = new Map<string, number>();
  private _runnerFactory: SessionRunnerFactory;
  private _depCacheDirResolver?: (sessionId: string) => string | undefined;
  private _onRunnerIdle?: (sessionId: string) => void;
  private _onRunnerCreated?: (runner: SessionRunnerInterface) => void;

  constructor(opts?: {
    runnerFactory?: SessionRunnerFactory;
    depCacheDirResolver?: (sessionId: string) => string | undefined;
    onRunnerIdle?: (sessionId: string) => void;
    onRunnerCreated?: (runner: SessionRunnerInterface) => void;
  }) {
    this._runnerFactory = opts?.runnerFactory ?? ((o) => new SessionRunner(o));
    this._depCacheDirResolver = opts?.depCacheDirResolver;
    this._onRunnerIdle = opts?.onRunnerIdle;
    this._onRunnerCreated = opts?.onRunnerCreated;
  }

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
    this.incarnations.set(sessionId, (this.incarnations.get(sessionId) ?? 0) + 1);
    runner.on("disposed", () => this.runners.delete(sessionId));
    if (this._onRunnerIdle) {
      const cb = this._onRunnerIdle;
      runner.on("idle", () => cb(sessionId));
    }
    this._onRunnerCreated?.(runner);
    this.runners.set(sessionId, runner);
    return runner;
  }

  incarnation(sessionId: string): number {
    return this.incarnations.get(sessionId) ?? 0;
  }

  get(sessionId: string): SessionRunnerInterface | undefined {
    const runner = this.runners.get(sessionId);
    if (runner?.disposed) {
      this.runners.delete(sessionId);
      return undefined;
    }
    return runner;
  }

  listActive(): string[] {
    return [...this.runners.entries()]
      .filter(([, r]) => r.running && !r.disposed)
      .map(([id]) => id);
  }

  dispose(sessionId: string, opts?: { force?: boolean; preserveAgent?: boolean }): void {
    this.runners.get(sessionId)?.dispose(opts);
  }

  disposeAll(opts?: { preserveAgent?: boolean }): void {
    for (const runner of this.runners.values()) {
      runner.dispose({ force: true, ...(opts?.preserveAgent ? { preserveAgent: true } : {}) });
    }
    this.runners.clear();
  }

  get size(): number { return this.runners.size; }

  ids(): string[] { return [...this.runners.keys()]; }
}
