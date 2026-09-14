// A turn the CLI started on its own has no prompt to replay, so a quota refusal used to
// end the session's autonomous work until a human sent a message. ShipIt starts a fresh
// continuation turn instead — now if another credential is free, later when a bench ends.
// docs/306-quota-continuation.

import type { AgentId, SessionInfo } from "../../shared/types.js";
import type { ProviderAccountManager } from "../provider-account-manager.js";
import { selectRouteForSelection } from "../service-routing.js";
import { modelSelectionOf } from "../session-agent-env.js";
import { wakeSessionWithTurn, type WakeSessionDeps } from "../wake-session.js";
import { loadPrompt } from "../load-prompt.js";

const CONTINUATION_PROMPT = loadPrompt(import.meta.url, "../prompts/quota-continuation-wake.md");
const CONTINUATION_ACTIVITY = "Continuing after a quota limit…";

// Polling resolution only: eligibility is the router's answer, on the docs/260 refusal clocks.
const STALL_SWEEP_MS = 60_000;

// A wake that cannot be delivered is usually transient (a container that would not resume).
const MAX_WAKE_ATTEMPTS = 3;

export interface QuotaContinuationDeps extends WakeSessionDeps {
  providerAccountManager?: ProviderAccountManager | undefined;
}

interface StoppedSession {
  agentId: AgentId;
  /** Every turn start stamps lastUsedAt; a change means something else took the session on. */
  lastUsedAt: string;
  wakeAttempts: number;
}

export class QuotaContinuationManager {
  private readonly stopped = new Map<string, StoppedSession>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private sweepInFlight = false;

  constructor(private readonly deps: QuotaContinuationDeps) {}

  /**
   * The stand-down decision. Records the session either way, and answers whether a credential
   * is free to continue it right now: `true` means the caller runs `continueNow` at the end of
   * the stopped turn's teardown, `false` leaves it to the sweep.
   */
  recordStandDown(args: {
    sessionId: string;
    agentId: AgentId;
    benchedRouteId?: string;
  }): { continues: boolean } {
    const session = this.deps.sessionManager.get(args.sessionId);
    if (!session || isArchived(session)) return { continues: false };

    this.stopped.set(args.sessionId, {
      agentId: args.agentId,
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
   * Phase 1: continue now, from the end of the stopped turn's terminal sequence. That position
   * is the ordering guarantee, so — unlike the sweep — this does not test `agentBusy`: it runs
   * inside the post-turn hold it would be reading.
   */
  async continueNow(sessionId: string): Promise<void> {
    const session = this.currentIfStillStopped(sessionId);
    if (!session) return;
    const attempts = this.stopped.get(sessionId)?.wakeAttempts ?? 0;
    this.stopped.delete(sessionId);
    await this.wake(session, attempts);
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
      for (const [sessionId, entry] of [...this.stopped]) {
        const session = this.currentIfStillStopped(sessionId);
        if (!session) continue;
        // Terminal work outlives `running`; a wake against an uncommitted tree can discard it.
        if (this.deps.runnerRegistry.get(sessionId)?.agentBusy) continue;
        if (!this.credentialIsFree(session, entry.agentId, [])) continue;
        // Delete before waking: at most one wake per session per stall.
        this.stopped.delete(sessionId);
        console.log(`[quota] a credential is free again; resuming ${sessionId}`);
        await this.wake(session, entry.wakeAttempts);
      }
    } finally {
      this.sweepInFlight = false;
      this.stopSweepLoopIfIdle();
    }
  }

  /** The session as it stands, or undefined — dropping it when it no longer wants a wake. */
  private currentIfStillStopped(sessionId: string): SessionInfo | undefined {
    const entry = this.stopped.get(sessionId);
    if (!entry) return undefined;
    const session = this.deps.sessionManager.get(sessionId);
    if (!session || isArchived(session)) {
      this.stopped.delete(sessionId);
      return undefined;
    }
    // Any later turn — a user message, another wake — supersedes this one.
    if (session.lastUsedAt !== entry.lastUsedAt) {
      this.stopped.delete(sessionId);
      return undefined;
    }
    return session;
  }

  private async wake(session: SessionInfo, priorAttempts: number): Promise<void> {
    const attempts = priorAttempts + 1;
    try {
      await wakeSessionWithTurn(this.deps, session, {
        text: CONTINUATION_PROMPT,
        activity: CONTINUATION_ACTIVITY,
      });
    } catch (err) {
      console.error(
        `[quota] the continuation turn for ${session.id} was not delivered `
        + `(attempt ${attempts} of ${MAX_WAKE_ATTEMPTS}):`,
        err,
      );
      // Delivery failures are usually transient; leave the session for a later sweep.
      if (attempts >= MAX_WAKE_ATTEMPTS) return;
      this.stopped.set(session.id, {
        agentId: session.agentId ?? this.deps.defaultAgentId,
        lastUsedAt: session.lastUsedAt,
        wakeAttempts: attempts,
      });
      this.ensureSweepLoop();
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
    if (this.stopped.size === 0) this.stop();
  }
}

function isArchived(session: SessionInfo): boolean {
  return session.archived === true || session.userArchived === true;
}
