// ShipIt compacts a large, idle session's context shortly before its provider's prompt cache
// expires (docs/333-idle-compaction). One timer for the whole orchestrator, at the earliest
// deadline; the deadlines are re-derived from the usage rows at boot.
import type { AgentId } from "../../shared/types.js";
import type { ModelFamily } from "../../shared/catalogue/model-identity.js";
import { modelIdentityFor } from "../../shared/catalogue/index.js";
import { getAgentCapabilities } from "../../shared/agent-registry.js";
import { GLOBAL_SETTINGS } from "../../shared/settings-catalogue/global-settings.js";
import { doneSessionTest } from "../../shared/session-resolution.js";
import type { CompactionCard } from "../../shared/types.js";
import type { SessionManager } from "../sessions.js";
import type { AnchoredTurn, CacheTtl, UsageManager } from "../usage.js";
import type { PersistedMessage } from "../chat-history.js";
import type { SessionContainerManager } from "../session-container.js";
import type { SessionRunnerInterface, SessionRunnerRegistry } from "../session-runner.js";
import { DISPATCH_SETUP_FAILURE } from "../session-runner.js";
import { ContainerSessionRunner } from "../container-session-runner.js";
import { prepareDispatch } from "../prepared-dispatch.js";
import type { TurnHandle, TurnOutcome } from "../turn-settlement.js";
import { reconcileRunnerAgent } from "../reconcile-runner-agent.js";
import { selectionOf } from "../turn-attribution.js";
import { emitNoticePostTurn } from "../chat-card-persistence.js";
import { MISSED_COMPACTION_NOTICE } from "../compact-before-turn.js";
import { getErrorMessage } from "../validation.js";
import { busyReason } from "./agent-compaction-request.js";

/** req 6 */
export const IDLE_COMPACTION_MIN_CONTEXT_TOKENS = 200_000;
/** req 11 — a shorter cache would be compacted while the user may still read the reply. */
export const IDLE_COMPACTION_MIN_LIFETIME_MINUTES = 30;
/** req 10 */
const ASSUMED_LIFETIME_MINUTES = 30;
/** The longest lifetime there is; boot re-derives nothing older. */
const MAX_LIFETIME_MINUTES = 60;
/** The last 10% of the lifetime, as the CLI's own idle compaction (54 of 60 minutes). */
const FIRE_AT_FRACTION = 0.9;
const WORKER_READY_TIMEOUT_MS = 30_000;
const COMPACTION_ACTIVITY = "Compacting context…";
const SETTING = GLOBAL_SETTINGS["advanced.idleCompaction"];

interface HarnessCacheFacts {
  /** Why the harness gets no idle compaction. */
  excluded?: string;
  /** A process that resumes the conversation writes all of it to the cache again. */
  firstResumeCold?: boolean;
  /** The lifetime of the Anthropic cache it gets by setting no ttl of its own. */
  anthropicDefaultMinutes?: number;
}

// The probes and sources of plan.md, piece 1 and "Verify first".
const HARNESS_CACHE: Readonly<Record<AgentId, HarnessCacheFacts>> = {
  // CLI 2.1.300: only the resident process that built the cache reads it warm.
  claude: { firstResumeCold: true },
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
  /** `advanced.liveSteering`: Claude then keeps one resident process per session. */
  liveSteering: () => boolean;
  defaultAgentId: AgentId;
  sessionManager: Pick<SessionManager, "get" | "listAll">;
  usageManager: Pick<UsageManager, "latestContextTokens" | "observedCacheTtl" | "anchoredTurnsSince">;
  chatHistoryManager: {
    latestCompactionCard(sessionId: string): CompactionCard | undefined;
    append(sessionId: string, message: PersistedMessage): unknown;
  };
  runnerRegistry: Pick<SessionRunnerRegistry, "get" | "getOrCreate">;
  /** null in local mode, where the orchestrator process is the one that runs the agents. */
  containerManager: Pick<SessionContainerManager, "get" | "isStandby"> | null;
}

interface Deadline {
  due: number;
  expires: number;
  /** The conversation the reading describes; another harness or model reads another cache. */
  agentId: AgentId;
  model: string | null;
}

export class IdleCompaction {
  private readonly deadlines = new Map<string, Deadline>();
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
    let runner: SessionRunnerInterface;
    try {
      runner = await this.attachRunner(sessionId);
    } catch (err) {
      console.error(`[idle-compaction] reaching the runner of ${sessionId} failed:`, getErrorMessage(err));
      this.warnUser(sessionId, undefined);
      return;
    }
    // The awaits above: the user can have come back, the session become done, the cache expired.
    const blockedNow = this.blockedReason(sessionId, deadline, runner);
    if (blockedNow) {
      console.log(`[idle-compaction] not compacting ${sessionId}: ${blockedNow}`);
      return;
    }
    this.dispatch(sessionId, runner);
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
      observed: this.deps.usageManager.observedCacheTtl(sessionId, turn.credentialRouteId),
    });
    if (lifetime < IDLE_COMPACTION_MIN_LIFETIME_MINUTES) return null;
    if (!this.contextLargeEnough(sessionId)) return null;
    const lifetimeMs = lifetime * 60_000;
    const expires = anchor.at + lifetimeMs;
    if (Date.now() >= expires) return null;
    return { due: anchor.at + FIRE_AT_FRACTION * lifetimeMs, expires, agentId, model: anchor.model };
  }

  // A compaction since the reading (`/compact`, docs/295, docs/324) answers with its own size.
  private contextLargeEnough(sessionId: string): boolean {
    const context = this.deps.usageManager.latestContextTokens(
      sessionId, this.deps.chatHistoryManager.latestCompactionCard(sessionId),
    );
    return context !== undefined && context >= IDLE_COMPACTION_MIN_CONTEXT_TOKENS;
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
    if (!this.hasLiveContainer(sessionId)) return "the session's container is gone (req 13)";
    if (runner) {
      // The question hold is the one part this skips (req 12).
      const busy = busyReason(runner, { pastAnswerHold: true });
      if (busy) return busy;
    }
    // With live steering on, the session's turns run on one resident process. Where a new
    // process reads cold, only that resident can compact the cache warm.
    if (HARNESS_CACHE[agentId].firstResumeCold && this.deps.liveSteering()
      && !(runner?.isStreamingActive && runner.getAgent())) {
      return "the resident process that holds the warm cache is gone";
    }
    return null;
  }

  private hasLiveContainer(sessionId: string): boolean {
    const { containerManager } = this.deps;
    if (!containerManager) return true;
    return containerManager.get(sessionId)?.status === "running" && !containerManager.isStandby(sessionId);
  }

  // Never a new container: the container is live, so a missing runner is an orchestrator restart.
  private async attachRunner(sessionId: string): Promise<SessionRunnerInterface> {
    const existing = this.deps.runnerRegistry.get(sessionId);
    if (existing) return existing;
    const session = this.deps.sessionManager.get(sessionId);
    if (!session?.workspaceDir) throw new Error("the session has no workspace");
    const runner = this.deps.runnerRegistry.getOrCreate(
      sessionId, session.workspaceDir, session.agentId ?? this.deps.defaultAgentId,
    );
    reconcileRunnerAgent(runner, session.agentId);
    if (runner instanceof ContainerSessionRunner) {
      await Promise.race([
        runner.whenWorkerReady(),
        new Promise<void>((resolve) => {
          setTimeout(resolve, WORKER_READY_TIMEOUT_MS).unref?.();
        }),
      ]);
    }
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
