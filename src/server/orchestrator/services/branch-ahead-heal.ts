/**
 * Recover a branch that is already ahead of its remote.
 *
 * `postTurnCommit` arms the auto-push only as a side effect of the current turn
 * moving HEAD, so a push missed for any reason is never reconsidered: later
 * turns run on a clean tree with HEAD unchanged and arm nothing, and the branch
 * stays ahead forever while the PR sits unmergeable. The PR poller already
 * measures the state on every tick; this turns that reading into a repair.
 */
import type { SessionInfo } from "../../shared/types.js";
import type { BranchSyncStatus, PrStatusSummary } from "../../shared/types/github-types.js";
import { evaluateMergedBranchPush, type MergedPushGuardGit } from "./merged-push-guard.js";
import { autoCommitAllowed } from "./auto-commit-gate.js";

export const HEAL_BASE_COOLDOWN_MS = 60_000;
export const HEAL_MAX_COOLDOWN_MS = 30 * 60_000;

export type AheadHealSkip =
  | "no-scheduler"
  | "no-checkout"
  | "not-ahead"
  | "kind"
  | "secret-blocked"
  | "busy"
  | "push-armed"
  | "cooling-down"
  | "unknown-head"
  | "merged";

export type AheadHealOutcome =
  | { action: "scheduled"; attempt: number }
  | { action: "skip"; reason: AheadHealSkip };

export interface AheadHealRunner {
  readonly agentBusy: boolean;
  readonly systemTurnInProgress: boolean;
}

export interface BranchAheadHealerDeps {
  getRunner: (sessionId: string) => AheadHealRunner | null | undefined;
  /** True while the shared scheduler already holds an armed push for the session. */
  pushArmed: (sessionId: string) => boolean;
  now?: () => number;
}

interface HealAttempt {
  head: string;
  attempts: number;
  lastAt: number;
}

/** Back off on a branch that stays ahead: a push rejected once usually is again. */
function cooldownMs(attempts: number): number {
  return Math.min(HEAL_BASE_COOLDOWN_MS * 2 ** (attempts - 1), HEAL_MAX_COOLDOWN_MS);
}

export class BranchAheadHealer {
  private readonly history = new Map<string, HealAttempt>();

  constructor(private readonly deps: BranchAheadHealerDeps) {}

  forget(sessionId: string): void {
    this.history.delete(sessionId);
  }

  /**
   * `sync` must come from the poller's own reading. Only `ahead` is safe to heal:
   * a `diverged` branch cannot be plain-pushed, and force-pushing it would
   * discard the remote's history — that case stays held and reported.
   */
  async heal(args: {
    sessionId: string;
    session: SessionInfo | undefined;
    sync: BranchSyncStatus | undefined;
    git: MergedPushGuardGit;
    getPrStatus: () => PrStatusSummary | null;
    schedule: () => void;
  }): Promise<AheadHealOutcome> {
    const { sessionId, sync } = args;
    if (!sync) return { action: "skip", reason: "not-ahead" };
    if (sync.state !== "ahead") {
      // Only a definite non-ahead reading retires the back-off. An unreadable
      // one is no evidence of recovery, and clearing on it would renew a
      // failing branch's budget every time the state could not be measured.
      this.history.delete(sessionId);
      return { action: "skip", reason: "not-ahead" };
    }

    // The turn path refuses to auto-commit these kinds; a repair path that did
    // not check would be the one automatic git write they still receive.
    if (!autoCommitAllowed(args.session)) return { action: "skip", reason: "kind" };
    // Committed work is not what the block is about — it gates the *commit* —
    // but a session ShipIt has refused to write to is not one to start pushing
    // from in the background either. The turn path publishes it as before.
    if (args.session?.secretBlock) return { action: "skip", reason: "secret-blocked" };

    // The same two flags the managed auto-merge holds on. An armed or in-flight
    // auto-push also takes a post-turn lease, so `agentBusy` is what keeps this
    // off the turn path — including the PR-lifecycle flow's own synchronous
    // push, which a debounced plain push racing it would lose to.
    const heldBefore = this.holdReason(sessionId);
    if (heldBefore) return { action: "skip", reason: heldBefore };

    const head = await args.git.getHeadHash();
    if (!head) return { action: "skip", reason: "unknown-head" };

    const now = this.deps.now?.() ?? Date.now();
    const prior = this.history.get(sessionId);
    // New commits restart the budget; the same tip backs off.
    const repeat = prior?.head === head ? prior : undefined;
    if (repeat && now - repeat.lastAt < cooldownMs(repeat.attempts)) {
      return { action: "skip", reason: "cooling-down" };
    }

    const block = await evaluateMergedBranchPush(args.session, args.getPrStatus, args.git);
    if (block) return { action: "skip", reason: "merged" };

    // Re-read after the awaits above: a turn can start, or the turn path can arm
    // its own push, while this was reading git. Claim only on what is true now.
    const heldAfter = this.holdReason(sessionId);
    if (heldAfter) return { action: "skip", reason: heldAfter };

    const attempt = (repeat?.attempts ?? 0) + 1;
    this.history.set(sessionId, { head, attempts: attempt, lastAt: now });
    args.schedule();
    return { action: "scheduled", attempt };
  }

  private holdReason(sessionId: string): "busy" | "push-armed" | null {
    const runner = this.deps.getRunner(sessionId);
    if (runner?.agentBusy || runner?.systemTurnInProgress) return "busy";
    return this.deps.pushArmed(sessionId) ? "push-armed" : null;
  }
}
