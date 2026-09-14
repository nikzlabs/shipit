// A turn the CLI started on its own has no prompt to replay, so a quota refusal used to
// end the session's autonomous work until a human sent a message. ShipIt starts a fresh
// continuation turn instead — now if another credential is free, later when a bench ends.
// docs/306-quota-continuation.

import type { AgentId, SessionInfo } from "../../shared/types.js";
import type { ProviderAccountManager } from "../provider-account-manager.js";
import { accountServiceForHarness } from "../provider-account-manager.js";
import { wakeSessionWithTurn, type WakeSessionDeps } from "../wake-session.js";
import { loadPrompt } from "../load-prompt.js";

const CONTINUATION_PROMPT = loadPrompt(import.meta.url, "../prompts/quota-continuation-wake.md");
const CONTINUATION_ACTIVITY = "Continuing after a quota limit…";

// Polling resolution only: eligibility is the router's answer, on the docs/260 refusal clocks.
const STALL_SWEEP_MS = 60_000;

export interface QuotaContinuationDeps extends WakeSessionDeps {
  providerAccountManager?: ProviderAccountManager | undefined;
}

interface StalledSession {
  serviceId: string;
  /** Every turn start stamps lastUsedAt; a change means the session no longer needs a wake. */
  lastUsedAt: string;
}

export class QuotaContinuationManager {
  private readonly stalled = new Map<string, StalledSession>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private sweepInFlight = false;

  constructor(private readonly deps: QuotaContinuationDeps) {}

  /**
   * The stand-down decision. Answers whether another credential can continue this session's
   * work right now; when none can, the session is remembered so the sweep resumes it once
   * the refusal it hit has expired.
   */
  recordStandDown(args: {
    sessionId: string;
    agentId: AgentId;
    benchedRouteId?: string;
  }): { continues: boolean } {
    const session = this.deps.sessionManager.get(args.sessionId);
    if (!session || isArchived(session)) return { continues: false };
    const serviceId = this.serviceIdFor(session, args.agentId, args.benchedRouteId);
    if (!serviceId) return { continues: false };

    // The refusal is already stamped, but exclude the route explicitly: a wake must never
    // land back on the account this turn just spent.
    const exclude = args.benchedRouteId ? [args.benchedRouteId] : [];
    if (this.accountAvailable(serviceId, exclude)) {
      this.stalled.delete(args.sessionId);
      return { continues: true };
    }

    console.log(
      `[quota] no credential is free to continue ${args.sessionId}; `
      + "ShipIt will resume it when one is",
    );
    this.stalled.set(args.sessionId, { serviceId, lastUsedAt: session.lastUsedAt });
    this.ensureSweepLoop();
    return { continues: false };
  }

  /** Phase 1: start the continuation turn, after the stand-down turn's terminal sequence. */
  async continueNow(sessionId: string): Promise<void> {
    const session = this.deps.sessionManager.get(sessionId);
    if (!session || isArchived(session)) return;
    await this.wake(session);
  }

  stop(): void {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** Exposed for tests and for an immediate check after a bench is known to have moved. */
  async sweep(): Promise<void> {
    if (this.sweepInFlight) return;
    this.sweepInFlight = true;
    try {
      for (const [sessionId, entry] of [...this.stalled]) {
        const session = this.deps.sessionManager.get(sessionId);
        if (!session || isArchived(session)) {
          this.stalled.delete(sessionId);
          continue;
        }
        // Any later turn — a user message, another wake — supersedes this stall.
        if (session.lastUsedAt !== entry.lastUsedAt) {
          this.stalled.delete(sessionId);
          continue;
        }
        if (this.deps.runnerRegistry.get(sessionId)?.running) continue;
        if (!this.accountAvailable(entry.serviceId, [])) continue;
        // Delete before waking: at most one wake per session per bench.
        this.stalled.delete(sessionId);
        console.log(`[quota] a credential is free again; resuming ${sessionId}`);
        await this.wake(session);
      }
    } finally {
      this.sweepInFlight = false;
      this.stopSweepLoopIfIdle();
    }
  }

  private async wake(session: SessionInfo): Promise<void> {
    try {
      await wakeSessionWithTurn(this.deps, session, {
        text: CONTINUATION_PROMPT,
        activity: CONTINUATION_ACTIVITY,
      });
    } catch (err) {
      console.error(`[quota] the continuation turn for ${session.id} was not delivered:`, err);
    }
  }

  private accountAvailable(serviceId: string, exclude: readonly string[]): boolean {
    const manager = this.deps.providerAccountManager;
    if (!manager) return false;
    return manager.selectAccountForTurn(serviceId, { exclude }).ok;
  }

  private serviceIdFor(
    session: SessionInfo,
    agentId: AgentId,
    benchedRouteId: string | undefined,
  ): string | undefined {
    const benched = benchedRouteId
      ? this.deps.providerAccountManager?.getByRouteId(benchedRouteId)
      : undefined;
    // accountServiceForHarness returns "" for a harness with no account-backed service.
    return benched?.serviceId ?? session.serviceId ?? (accountServiceForHarness(agentId) || undefined);
  }

  private ensureSweepLoop(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch((err: unknown) => {
        console.error("[quota] the stalled-session sweep errored:", err);
      });
    }, STALL_SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  private stopSweepLoopIfIdle(): void {
    if (this.stalled.size === 0) this.stop();
  }
}

function isArchived(session: SessionInfo): boolean {
  return session.archived === true || session.userArchived === true;
}
