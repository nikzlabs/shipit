// ShipIt compacts a large, idle session's context shortly before its provider's prompt cache
// expires (docs/333-idle-compaction). One timer for the whole orchestrator, at the earliest
// deadline; the deadlines are re-derived from the usage rows at boot.
import type { AgentId } from "../../shared/types.js";
import type { ModelFamily } from "../../shared/catalogue/model-identity.js";
import { modelIdentityFor } from "../../shared/catalogue/index.js";
import { getAgentCapabilities } from "../../shared/agent-registry.js";
import { GLOBAL_SETTINGS } from "../../shared/settings-catalogue/global-settings.js";
import { doneSessionTest } from "../../shared/session-resolution.js";
import { AUTOMATIC_COMPACTION_MIN_CONTEXT_TOKENS } from "../../shared/compaction-threshold.js";
import type { CompactionCard, SessionInfo } from "../../shared/types.js";
import type { SessionManager } from "../sessions.js";
import type { AnchoredTurn, CacheTtl, UsageManager } from "../usage.js";
import type { PersistedMessage } from "../chat-history.js";
import type { SessionContainerManager } from "../session-container.js";
import type { SessionRunnerInterface, SessionRunnerRegistry } from "../session-runner.js";
import { DISPATCH_SETUP_FAILURE } from "../session-runner.js";
import { prepareDispatch } from "../prepared-dispatch.js";
import type { TurnHandle, TurnOutcome } from "../turn-settlement.js";
import { selectionOf } from "../turn-attribution.js";
import { emitNoticePostTurn } from "../chat-card-persistence.js";
import { MISSED_COMPACTION_NOTICE } from "../compact-before-turn.js";
import { getErrorMessage } from "../validation.js";
import { busyReason } from "./agent-compaction-request.js";

/** req 11 — a shorter cache would be compacted while the user may still read the reply. */
export const IDLE_COMPACTION_MIN_LIFETIME_MINUTES = 30;
/** req 10 */
const ASSUMED_LIFETIME_MINUTES = 30;
/** The longest lifetime there is; boot re-derives nothing older. */
const MAX_LIFETIME_MINUTES = 60;
/** The last 10% of the lifetime, as the CLI's own idle compaction (54 of 60 minutes). */
const FIRE_AT_FRACTION = 0.9;
const COMPACTION_ACTIVITY = "Compacting context…";
const SETTING = GLOBAL_SETTINGS["advanced.idleCompaction"];

interface HarnessCacheFacts {
  /** Why the harness gets no idle compaction. */
  excluded?: string;
  /** The lifetime of the Anthropic cache it gets by setting no ttl of its own. */
  anthropicDefaultMinutes?: number;
}

// The probes and sources of plan.md, piece 1 and "Verify first".
const HARNESS_CACHE: Readonly<Record<AgentId, HarnessCacheFacts>> = {
  // CLI 2.1.300 rebuilds a resumed conversation's request from its stored prompt snapshot, so a
  // new process read 303,085 of 303,135 tokens from the cache.
  claude: {},
  // Codex 0.160.1 read 98.8% of the previous input from the cache in a new process.
  codex: {},
  // req 14 — with one instruction-file path per prompt (planning#701), OpenCode 1.18.34 read
  // 99.1% of the previous input from the cache in a new process. It sends Anthropic
  // `cacheControl: {type: "ephemeral"}` with no ttl.
  opencode: { anthropicDefaultMinutes: 5 },
  // req 15 — no probe has shown a new Grok process reading the previous one's cache.
  grok: { excluded: "Grok's cache across processes is not probed (req 15)" },
  antigravity: {},
};

/**
 * How long the session's cache lives, in minutes. Observed where the harness reports it
 * (Claude's 5m/1h split), else documented for the model's vendor, else assumed (req 10).
 * Sources: plan.md, piece 1.
 */
export function cacheLifetimeMinutes(input: {
  agentId: AgentId;
  family: ModelFamily | undefined;
  observed: CacheTtl | undefined;
}): number {
  if (input.observed) return input.observed === "1h" ? 60 : 5;
  const anthropicDefault = HARNESS_CACHE[input.agentId].anthropicDefaultMinutes;
  if (input.family === "claude" && anthropicDefault !== undefined) return anthropicDefault;
  // Kimi's documented default; no harness sets `prompt_cache_options`.
  if (input.family === "kimi") return 5;
  // "At least 30 minutes after the latest write or reuse", GPT-5.6 and later.
  if (input.family === "gpt") return 30;
  return ASSUMED_LIFETIME_MINUTES;
}

/** Why a harness gets no idle compaction at all, or null. */
export function idleCompactionExclusion(agentId: AgentId): string | null {
  if (!(getAgentCapabilities(agentId)?.supportsCompaction ?? false)) return `${agentId} cannot compact`;
  return HARNESS_CACHE[agentId].excluded ?? null;
}

export interface IdleCompactionDeps {
  /** req 5 — `advanced.idleCompaction`, off by default. Read at the fire. */
  isEnabled: () => boolean;
  defaultAgentId: AgentId;
  sessionManager: Pick<SessionManager, "get" | "listAll">;
  usageManager: Pick<UsageManager, "latestContextTokens" | "observedCacheTtl" | "anchoredTurnsSince">;
  chatHistoryManager: {
    latestCompactionCard(sessionId: string): CompactionCard | undefined;
    append(sessionId: string, message: PersistedMessage): unknown;
  };
  runnerRegistry: Pick<SessionRunnerRegistry, "get">;
  /** null in local mode, where the orchestrator process is the one that runs the agents. */
  containerManager: Pick<SessionContainerManager, "get" | "isStandby"> | null;
  /** The session's runner, with a container started when none runs (`bootSessionRunner`). */
  wake: (session: SessionInfo) => Promise<SessionRunnerInterface>;
  /** The route the compaction turn would take now (`nextTurnRouteId`); absent skips the check. */
  nextTurnRouteId?: (session: SessionInfo, agentId: AgentId, runner: SessionRunnerInterface | undefined) => string | null;
  /** The session's preview services run. */
  hasPreview?: (sessionId: string) => boolean;
}

interface Deadline {
  due: number;
  expires: number;
  /** The conversation the reading describes; another harness or model reads another cache. */
  agentId: AgentId;
  model: string | null;
  /** The account whose cache the anchor turn wrote; caches are per account. */
  routeId: string | null;
}

/** req 13 — what a session looked like before the fire started its container. */
export interface WokenSession {
  /** Every other turn moves it; a silent compaction does not (piece 4). */
  lastUsedAt: string;
  /** A preview that ran before the wake keeps running when the container stops again. */
  previewBefore: boolean;
}

export class IdleCompaction {
  private readonly deadlines = new Map<string, Deadline>();
  private readonly woken = new Map<string, WokenSession>();
  /** From the wake to the dispatch, while no turn holds the runner yet. */
  private readonly starting = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerAt: number | null = null;

  constructor(private readonly deps: IdleCompactionDeps) {}

  /** After an ordinary turn's usage row: replaces the session's deadline, or drops it. */
  arm(turn: AnchoredTurn): void {
    this.deadlines.delete(turn.sessionId);
    const deadline = this.deadlineFor(turn);
    if (deadline) {
      this.deadlines.set(turn.sessionId, deadline);
      console.log(
        `[idle-compaction] ${turn.sessionId}: compacts at ${new Date(deadline.due).toISOString()} if still idle`,
      );
    }
    this.reschedule();
  }

  /** At boot: the newest anchored own turn of each session whose cache can still be warm. */
  rederive(): void {
    for (const turn of this.deps.usageManager.anchoredTurnsSince(Date.now() - MAX_LIFETIME_MINUTES * 60_000)) {
      this.arm(turn);
    }
  }

  /** The session has a deadline, and its compaction could run now (piece 5's order). */
  isWaiting(sessionId: string): boolean {
    const deadline = this.deadlines.get(sessionId);
    if (!deadline) return false;
    return this.blockedReason(sessionId, deadline, this.deps.runnerRegistry.get(sessionId)) === null;
  }

  /** One attempt: the deadline is taken before anything else, so nothing starts a second. */
  async fire(sessionId: string): Promise<void> {
    const deadline = this.deadlines.get(sessionId);
    if (!deadline) return;
    this.deadlines.delete(sessionId);
    this.reschedule();

    const blocked = this.blockedReason(sessionId, deadline, this.deps.runnerRegistry.get(sessionId));
    if (blocked) {
      console.log(`[idle-compaction] not compacting ${sessionId}: ${blocked}`);
      return;
    }
    this.starting.add(sessionId);
    try {
      await this.reachAndDispatch(sessionId, deadline);
    } finally {
      this.starting.delete(sessionId);
    }
  }

  /** req 13 — sessions whose container a fire started, for the idle enforcer to stop again. */
  wokenSessions(): ReadonlyMap<string, WokenSession> {
    return this.woken;
  }

  forgetWoken(sessionId: string): void {
    this.woken.delete(sessionId);
  }

  /** The idle enforcer leaves such a session alone: no turn holds its runner yet. */
  isStarting(sessionId: string): boolean {
    return this.starting.has(sessionId);
  }

  private async reachAndDispatch(sessionId: string, deadline: Deadline): Promise<void> {
    if (!this.hasContainer(sessionId)) {
      // Read before the wake, so that a visit or a turn during it counts as use.
      this.woken.set(sessionId, {
        lastUsedAt: this.deps.sessionManager.get(sessionId)?.lastUsedAt ?? "",
        previewBefore: this.deps.hasPreview?.(sessionId) ?? false,
      });
    }
    let runner: SessionRunnerInterface;
    try {
      runner = await this.attachRunner(sessionId);
    } catch (err) {
      console.error(`[idle-compaction] reaching the runner of ${sessionId} failed:`, getErrorMessage(err));
      this.warnUser(sessionId, undefined);
      return;
    }
    // A new process would end the one the worker still runs, and its background work with it.
    if (runner.residentToAttach) {
      console.log(`[idle-compaction] not compacting ${sessionId}: the worker runs a process this runner could not take over`);
      return;
    }
    await this.readyForAgent(runner, deadline);
    // The awaits above: the user can have come back, the session become done, the cache expired.
    const blockedNow = runner.disposed ? "the runner was disposed" : this.blockedReason(sessionId, deadline, runner);
    if (blockedNow) {
      console.log(`[idle-compaction] not compacting ${sessionId}: ${blockedNow}`);
      return;
    }
    this.dispatch(sessionId, runner);
  }

  // A fresh process starts once the worker is ready and the install is over; a cache that
  // expires meanwhile is cold.
  private async readyForAgent(runner: SessionRunnerInterface, deadline: Deadline): Promise<void> {
    if (!runner.whenReadyForAgent) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      runner.whenReadyForAgent(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, deadline.expires - Date.now()));
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerAt = null;
  }

  private deadlineFor(turn: AnchoredTurn): Deadline | null {
    const { sessionId, anchor } = turn;
    const session = this.deps.sessionManager.get(sessionId);
    if (!session) return null;
    const { agentId } = anchor;
    if (idleCompactionExclusion(agentId)) return null;
    const selection = selectionOf(session);
    const lifetime = cacheLifetimeMinutes({
      agentId,
      family: selection ? modelIdentityFor(selection)?.family : undefined,
      observed: this.deps.usageManager.observedCacheTtl(sessionId, turn.credentialRouteId, anchor),
    });
    if (lifetime < IDLE_COMPACTION_MIN_LIFETIME_MINUTES) return null;
    if (!this.contextLargeEnough(sessionId)) return null;
    const lifetimeMs = lifetime * 60_000;
    const expires = anchor.at + lifetimeMs;
    if (Date.now() >= expires) return null;
    return {
      due: anchor.at + FIRE_AT_FRACTION * lifetimeMs,
      expires,
      agentId,
      model: anchor.model,
      routeId: turn.credentialRouteId,
    };
  }

  // req 6. A compaction since the reading (`/compact`, docs/295, docs/324) answers with its own
  // size. An unknown size never wakes a container.
  private contextLargeEnough(sessionId: string): boolean {
    const context = this.deps.usageManager.latestContextTokens(
      sessionId, this.deps.chatHistoryManager.latestCompactionCard(sessionId),
    );
    return context !== undefined && context >= AUTOMATIC_COMPACTION_MIN_CONTEXT_TOKENS;
  }

  private blockedReason(
    sessionId: string,
    deadline: Deadline,
    runner: SessionRunnerInterface | undefined,
  ): string | null {
    if (!this.deps.isEnabled()) return `"${SETTING.label}" is off`;
    const session = this.deps.sessionManager.get(sessionId);
    if (!session || session.archived || session.userArchived) return "the session is archived";
    if (doneSessionTest(this.deps.sessionManager.listAll())(session)) return "the session is done (req 7)";
    const agentId = session.agentId ?? this.deps.defaultAgentId;
    if (agentId !== deadline.agentId || (session.model ?? null) !== deadline.model) {
      return "the session's harness or model changed, so its next turn reads another cache";
    }
    if (session.agentResumeAt) return "a rewind waits for the next turn";
    // Never on a cold cache: it would cost a full read and save nothing.
    if (Date.now() >= deadline.expires) return "the cache has expired";
    if (!this.contextLargeEnough(sessionId)) return "the context is under 200K tokens (req 6)";
    if (this.accountMoved(session, agentId, deadline, runner)) return "a turn would run on another account, whose cache is cold";
    if (runner) {
      // The question hold is the one part this skips (req 12).
      const busy = busyReason(runner, { pastAnswerHold: true });
      if (busy) return busy;
    }
    return null;
  }

  // The deadline's route wrote the cache; a process reads it warm only on that account.
  private accountMoved(
    session: SessionInfo,
    agentId: AgentId,
    deadline: Deadline,
    runner: SessionRunnerInterface | undefined,
  ): boolean {
    if (deadline.routeId === null || !this.deps.nextTurnRouteId) return false;
    return this.deps.nextTurnRouteId(session, agentId, runner) !== deadline.routeId;
  }

  // "starting" is a container someone else is starting; a fire that finds one wakes nothing.
  private hasContainer(sessionId: string): boolean {
    const { containerManager } = this.deps;
    if (!containerManager) return true;
    const status = containerManager.get(sessionId)?.status;
    return (status === "running" || status === "starting") && !containerManager.isStandby(sessionId);
  }

  // A runner whose container is gone is replaced by the wake, which starts a container.
  private async attachRunner(sessionId: string): Promise<SessionRunnerInterface> {
    const session = this.deps.sessionManager.get(sessionId);
    if (!session) throw new Error("the session is gone");
    const existing = this.deps.runnerRegistry.get(sessionId);
    const runner = existing && this.hasContainer(sessionId) ? existing : await this.deps.wake(session);
    // docs/334 — a process that survived an orchestrator restart keeps its background work.
    if (runner.residentToAttach) await runner.attachIdleResident?.();
    if (runner.disposed) throw new Error("the runner was disposed while it attached");
    return runner;
  }

  private dispatch(sessionId: string, runner: SessionRunnerInterface): void {
    let handle: TurnHandle;
    try {
      handle = runner.dispatch(prepareDispatch({
        text: "/compact",
        agentInterface: undefined,
        execution: undefined,
        activity: COMPACTION_ACTIVITY,
        images: undefined,
        files: undefined,
        uploads: undefined,
        // The resident keeps the mode it has; a change would reach the CLI.
        permissionMode: runner.appliedPermissionMode,
        postTurn: undefined,
        automatic: true,
        heldId: undefined,
        // A dispatch that fails in setup never reaches the compaction turn's own missed-card notice.
        onTurnComplete: (outcome: TurnOutcome) => {
          if (outcome.detail?.startsWith(DISPATCH_SETUP_FAILURE)) this.warnUser(sessionId, runner);
        },
        deliveryId: undefined,
        dictated: undefined,
        resetMergedBranch: undefined,
        compactContext: undefined,
        silent: true,
      }), { whenBusy: "refuse" });
    } catch (err) {
      console.error(`[idle-compaction] dispatching the compaction of ${sessionId} failed:`, getErrorMessage(err));
      this.warnUser(sessionId, runner);
      return;
    }
    console.log(`[idle-compaction] compacting the idle context of ${sessionId} (${handle.admitted})`);
  }

  // req 4 — the notice a compaction turn that wrote no card posts too.
  private warnUser(sessionId: string, runner: SessionRunnerInterface | undefined): void {
    try {
      emitNoticePostTurn(
        (m) => runner?.emitMessage(m),
        this.deps.chatHistoryManager,
        sessionId,
        MISSED_COMPACTION_NOTICE,
        "warn",
      );
    } catch (err) {
      console.error(`[idle-compaction] the missed-compaction notice for ${sessionId} failed:`, getErrorMessage(err));
    }
  }

  private reschedule(): void {
    let next = Infinity;
    for (const deadline of this.deadlines.values()) next = Math.min(next, deadline.due);
    if (this.timer && this.timerAt === next) return;
    this.stop();
    if (next === Infinity) return;
    this.timerAt = next;
    this.timer = setTimeout(() => this.onTimer(), Math.max(0, next - Date.now()));
    this.timer.unref?.();
  }

  private onTimer(): void {
    this.timer = null;
    this.timerAt = null;
    const now = Date.now();
    for (const [sessionId, deadline] of [...this.deadlines]) {
      if (deadline.due > now) continue;
      void this.fire(sessionId).catch((err: unknown) => {
        console.error(`[idle-compaction] the compaction of ${sessionId} failed:`, getErrorMessage(err));
      });
    }
    this.reschedule();
  }
}
