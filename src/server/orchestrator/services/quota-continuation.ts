// A turn the CLI started on its own has no prompt to replay, so a quota refusal used to
// end the session's autonomous work until a human sent a message. ShipIt starts a fresh
// continuation turn instead — now if another credential is free, later when a bench ends.
// docs/306-quota-continuation. A sign-in ShipIt renewed under such a turn stops it the same
// way, and is continued the same way (docs/140-live-steering Phase 6.13). So is an automatic
// wake that every credential refused for quota, at the reset the providers stated.

import type { AgentId, SessionInfo, SessionQuotaResume } from "../../shared/types.js";
import type { PersistedMessage } from "../chat-history.js";
import type { ProviderAccountManager } from "../provider-account-manager.js";
import { selectRouteForSelection } from "../service-routing.js";
import { modelSelectionOf } from "../session-agent-env.js";
import { wakeSessionWithTurn, type WakeSessionDeps } from "../wake-session.js";
import { loadPrompt } from "../load-prompt.js";
import { emitNoticePostTurn } from "../chat-card-persistence.js";
import { MAX_QUOTA_REFUSALS, formatUtc, quotaWaitUntil } from "../quota-wait.js";
import type { TurnOutcome } from "../turn-settlement.js";

/** Selects what the continuation turn is told; routing and timing never read it. */
export type StandDownCause = SessionQuotaResume["cause"];

const CONTINUATIONS: Record<StandDownCause, { text: string; activity: string }> = {
  quota: {
    text: loadPrompt(import.meta.url, "../prompts/quota-continuation-wake.md"),
    activity: "Continuing after a quota limit…",
  },
  auth: {
    text: loadPrompt(import.meta.url, "../prompts/auth-continuation-wake.md"),
    activity: "Continuing after a sign-in renewal…",
  },
  wake: {
    text: loadPrompt(import.meta.url, "../prompts/refused-wake-continuation.md"),
    activity: "Continuing after a quota limit…",
  },
};

// Polling resolution only: eligibility is the router's answer, on the docs/260 refusal clocks.
const STALL_SWEEP_MS = 60_000;

// A wake that cannot be delivered is usually transient (a container that would not resume).
const MAX_WAKE_ATTEMPTS = 3;

export interface QuotaContinuationDeps extends WakeSessionDeps {
  providerAccountManager?: ProviderAccountManager | undefined;
  chatHistoryManager: { append(sessionId: string, message: PersistedMessage): unknown };
}

/** What a wake's owner tells the manager when every credential refused that wake for quota. */
export interface RefusedWake {
  sessionId: string;
  resetsAt: readonly (string | null)[];
}

export type QuotaResumeRecorder = Pick<QuotaContinuationManager, "recordRefusedWake">;

export class QuotaContinuationManager {
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private sweepInFlight = false;
  // Covers a wake's preparation, before a turn holds the session.
  private readonly waking = new Set<string>();

  constructor(private readonly deps: QuotaContinuationDeps) {}

  /** Resumes the sweep for what a restart left waiting. */
  start(): void {
    if (this.deps.sessionManager.listQuotaResumes().length > 0) this.ensureSweepLoop();
  }

  /**
   * The stand-down decision. Records the session either way, and answers whether a credential
   * is free to continue it right now: `true` means the caller runs `continueNow` at the end of
   * the stopped turn's teardown, `false` leaves it to the sweep.
   */
  recordStandDown(args: {
    sessionId: string;
    agentId: AgentId;
    benchedRouteId?: string;
    cause?: StandDownCause;
  }): { continues: boolean } {
    const session = this.deps.sessionManager.get(args.sessionId);
    if (!session || isArchived(session)) return { continues: false };

    this.deps.sessionManager.setQuotaResume(args.sessionId, {
      agentId: args.agentId,
      cause: args.cause ?? "quota",
      lastUsedAt: session.lastUsedAt,
      wakeAttempts: 0,
    });
    this.ensureSweepLoop();

    // The refusal is already stamped, but exclude the route explicitly: the probe must not
    // answer "yes" on the strength of the credential this turn just spent.
    const exclude = args.benchedRouteId ? [args.benchedRouteId] : [];
    if (this.credentialIsFree(session, args.agentId, exclude)) return { continues: true };

    console.log(
      `[quota] no credential is free to continue ${args.sessionId}; `
      + "ShipIt will resume it when one is",
    );
    return { continues: false };
  }

  /**
   * An automatic wake ended without running: every credential refused it for quota. The owner
   * has parked what the wake was for, and the session resumes at the earliest stated reset —
   * not at the router's re-probe, which a weekly limit would turn into a wake every half hour.
   */
  recordRefusedWake(wake: RefusedWake): void {
    this.recordRefusal(wake, undefined);
  }

  /**
   * Phase 1: continue now, from the end of the stopped turn's terminal sequence. That position
   * is the ordering guarantee, so — unlike the sweep — this does not test `agentBusy`: it runs
   * inside the post-turn hold it would be reading.
   */
  async continueNow(sessionId: string): Promise<void> {
    const found = this.currentIfStillStopped(sessionId);
    if (!found || waitsForReset(found.resume)) return;
    // A queued turn drained during teardown; the sweep decides once it has ended.
    if (this.deps.runnerRegistry.get(sessionId)?.running) return;
    await this.wake(found.session, found.resume);
  }

  stop(): void {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** Resume every stopped session the router will now serve. Exposed for tests. */
  async sweep(): Promise<void> {
    if (this.sweepInFlight) return;
    this.sweepInFlight = true;
    try {
      for (const { sessionId } of this.deps.sessionManager.listQuotaResumes()) {
        const found = this.currentIfStillStopped(sessionId);
        if (!found) continue;
        const { session, resume } = found;
        if (waitsForReset(resume)) continue;
        // Terminal work outlives `running`; a wake against an uncommitted tree can discard it.
        if (this.deps.runnerRegistry.get(sessionId)?.agentBusy) continue;
        if (!this.credentialIsFree(session, resume.agentId, [])) continue;
        await this.wake(session, resume);
      }
    } finally {
      this.sweepInFlight = false;
      this.stopSweepLoopIfIdle();
    }
  }

  /** The session and its entry as they stand, or undefined — dropping one that no longer wants a wake. */
  private currentIfStillStopped(
    sessionId: string,
  ): { session: SessionInfo; resume: SessionQuotaResume } | undefined {
    const resume = this.deps.sessionManager.getQuotaResume(sessionId);
    if (!resume) return undefined;
    const session = this.deps.sessionManager.get(sessionId);
    if (!session || isArchived(session)) {
      this.deps.sessionManager.setQuotaResume(sessionId, null);
      return undefined;
    }
    // Any later turn — a user message, another wake — supersedes this one, also one that no
    // credential could run: what the wake was for is parked, and rides the turn that runs.
    if (session.lastUsedAt !== resume.lastUsedAt) {
      this.deps.sessionManager.setQuotaResume(sessionId, null);
      return undefined;
    }
    return { session, resume };
  }

  private recordRefusal(wake: RefusedWake, prior: SessionQuotaResume | undefined): void {
    const session = this.deps.sessionManager.get(wake.sessionId);
    if (!session || isArchived(session)) return;
    const refusals = (prior?.quotaRefusals ?? 0) + 1;
    if (refusals >= MAX_QUOTA_REFUSALS) {
      this.deps.sessionManager.setQuotaResume(wake.sessionId, null);
      console.warn(`[quota] no credential could run ${wake.sessionId} ${refusals} times; ShipIt stops waiting`);
      this.notify(
        wake.sessionId,
        `No connected account could run this session's work ${refusals} times in a row, so ShipIt `
        + "has stopped waiting for quota. The work continues with your next message.",
        "warn",
      );
      return;
    }
    const until = new Date(quotaWaitUntil(wake.resetsAt, refusals, Date.now()));
    this.deps.sessionManager.setQuotaResume(wake.sessionId, {
      agentId: session.agentId ?? this.deps.defaultAgentId,
      cause: prior?.cause ?? "wake",
      lastUsedAt: session.lastUsedAt,
      wakeAttempts: 0,
      notBefore: until.toISOString(),
      quotaRefusals: refusals,
    });
    this.ensureSweepLoop();
    console.log(
      `[quota] no credential could run a wake of ${wake.sessionId} (${refusals}/${MAX_QUOTA_REFUSALS}); `
      + `ShipIt resumes it at ${until.toISOString()}`,
    );
    this.notify(
      wake.sessionId,
      `No connected account had quota left to continue this session's work. ShipIt will continue it at `
      + `${formatUtc(until)}. You do not need to do anything.`,
      "info",
    );
  }

  /**
   * The entry is cleared once a turn has the wake, not before: a restart during the wake's
   * preparation finds it still recorded. The wake never queues — a turn that took the session
   * meanwhile refuses it, and the sweep judges the entry again.
   */
  private async wake(session: SessionInfo, resume: SessionQuotaResume): Promise<void> {
    if (this.waking.has(session.id)) return;
    this.waking.add(session.id);
    const attempts = resume.wakeAttempts + 1;
    try {
      const handle = await wakeSessionWithTurn(this.deps, session, {
        ...CONTINUATIONS[resume.cause],
        startOrRefuse: { automatic: true },
        stillWanted: () => this.isCurrent(session.id, resume),
        onSettled: (outcome: TurnOutcome) => {
          if (!outcome.quotaRefused) return;
          this.recordRefusal({ sessionId: session.id, resetsAt: outcome.quotaRefused.resetsAt }, resume);
        },
      });
      if (handle.admitted === "refused") return;
      console.log(`[quota] a credential is free again; resumed ${session.id}`);
      this.replaceIfUnchanged(session.id, resume, null);
    } catch (err) {
      console.error(
        `[quota] the continuation turn for ${session.id} was not delivered `
        + `(attempt ${attempts} of ${MAX_WAKE_ATTEMPTS}):`,
        err,
      );
      // Delivery failures are usually transient; leave the session for a later sweep.
      if (attempts >= MAX_WAKE_ATTEMPTS) {
        this.replaceIfUnchanged(session.id, resume, null);
        return;
      }
      this.replaceIfUnchanged(session.id, resume, { ...resume, wakeAttempts: attempts });
      this.ensureSweepLoop();
    } finally {
      this.waking.delete(session.id);
    }
  }

  /** The entry this wake was for still stands, unsuperseded and due. */
  private isCurrent(sessionId: string, resume: SessionQuotaResume): boolean {
    const found = this.currentIfStillStopped(sessionId);
    return !!found && sameResume(found.resume, resume) && !waitsForReset(found.resume);
  }

  // A refusal recorded while this wake was in flight has replaced the entry; that one stays.
  private replaceIfUnchanged(
    sessionId: string,
    resume: SessionQuotaResume,
    next: SessionQuotaResume | null,
  ): void {
    const current = this.deps.sessionManager.getQuotaResume(sessionId);
    if (current && sameResume(current, resume)) this.deps.sessionManager.setQuotaResume(sessionId, next);
  }

  private notify(sessionId: string, text: string, level: "info" | "warn"): void {
    try {
      const runner = this.deps.runnerRegistry.get(sessionId);
      emitNoticePostTurn((m) => runner?.emitMessage(m), this.deps.chatHistoryManager, sessionId, text, level);
    } catch (err) {
      console.error(`[quota] the notice for ${sessionId} failed:`, err);
    }
  }

  /**
   * Ask the question a turn would ask, through the same router — an account, or a subscription
   * credential stored as a string. Deliberately not `optimistic`: that mode hands back a
   * refusal-blocked candidate to a caller that is about to attempt it, and the only useful
   * answer here is whether anything is actually free.
   */
  private credentialIsFree(
    session: SessionInfo,
    agentId: AgentId,
    exclude: readonly string[],
  ): boolean {
    const credentialStore = this.deps.credentialStore;
    if (!credentialStore) return false;
    return selectRouteForSelection(
      agentId,
      modelSelectionOf(session),
      {
        credentialStore,
        ...(this.deps.providerAccountManager
          ? { providerAccountManager: this.deps.providerAccountManager }
          : {}),
      },
      exclude.length > 0 ? { exclude } : {},
    ).ok;
  }

  private ensureSweepLoop(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch((err: unknown) => {
        console.error("[quota] the stopped-session sweep errored:", err);
      });
    }, STALL_SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  private stopSweepLoopIfIdle(): void {
    if (this.deps.sessionManager.listQuotaResumes().length === 0) this.stop();
  }
}

function sameResume(a: SessionQuotaResume, b: SessionQuotaResume): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function waitsForReset(resume: SessionQuotaResume): boolean {
  return resume.notBefore !== undefined && Date.now() < Date.parse(resume.notBefore);
}

function isArchived(session: SessionInfo): boolean {
  return session.archived === true || session.userArchived === true;
}
