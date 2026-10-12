import { randomUUID } from "node:crypto";
import type { ChatHistoryManager } from "./chat-history.js";
import type {
  ChildMergedCard,
  SessionInfo,
  SessionMergeWatch,
  SessionMergeWatchPr,
  WsServerMessage,
} from "../shared/types.js";
import type { PrStatusSummary } from "../shared/types/github-types.js";
import { REFUSAL_REPROBE_MS } from "../shared/types/domain-types/credential-route.js";
import { wakeSessionWithTurn, type WakeSessionDeps } from "./wake-session.js";
import type { SessionInbox } from "./services/session-inbox.js";
import { hasHeldDelivery } from "./held-turns.js";
import type { PrTerminalStateInfo } from "./pr-status-poller.js";
import type { TurnOutcome } from "./turn-settlement.js";
import { emitNoticePostTurn } from "./chat-card-persistence.js";
import { endSelfMergeWatchCard } from "./self-merge-watch-card.js";
import { addUnreportedPr, samePrOutcome, unreportedPrs, withUnreportedPrs } from "./merge-watch-prs.js";
import { loadPrompt, fillPromptTokens } from "./load-prompt.js";

const SELF_MERGE_WAKE_PROMPT = loadPrompt(import.meta.url, "./prompts/self-merge-wake.md");

export const MAX_DELIVERY_ATTEMPTS = 5;
const RETRY_TICK_MS = 30_000;
const RETRY_BASE_BACKOFF_MS = 60_000;
const RETRY_MAX_BACKOFF_MS = 10 * 60_000;

function retryBackoffMs(attempts: number): number {
  return Math.min(RETRY_BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_BACKOFF_MS);
}

// docs/306-quota-continuation — a self wake that every credential refused for quota waits for a
// reset and spends no attempt. This many such refusals end the watch, so quota that never
// returns cannot wake the session for ever.
export const MAX_QUOTA_REFUSALS = 5;
// A provider's reset time is to the minute; a wake on that second can be refused again.
const QUOTA_RESET_MARGIN_MS = 60_000;

export interface MergeWatchDeps extends WakeSessionDeps {
  chatHistoryManager: ChatHistoryManager;
  /** A parent's watch stores its notice here (docs/328-session-message-inbox req 6). */
  sessionInbox: Pick<SessionInbox, "add" | "tell">;
}

// A session holds two independent watches: its parent's (docs/196) and its own (docs/239).
type WatchSlot = "parent" | "self";

function slotOf(watch: SessionMergeWatch): WatchSlot {
  return watch.kind === "self" ? "self" : "parent";
}

function slotKey(sessionId: string, slot: WatchSlot): string {
  return `${slot}:${sessionId}`;
}

export class MergeWatchManager {
  private prStatusLookup?: (sessionId: string) => PrStatusSummary | undefined;

  // Covers only dispatch's await, before a runner can report ownership of the delivery.
  private readonly dispatching = new Set<string>();
  private retryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: MergeWatchDeps) {}

  setPrStatusLookup(fn: (sessionId: string) => PrStatusSummary | undefined): void {
    this.prStatusLookup = fn;
  }

  stopRetryLoop(): void {
    if (!this.retryTimer) return;
    clearInterval(this.retryTimer);
    this.retryTimer = null;
  }

  // A watch armed after the PR became terminal will not receive a new poller event.
  async checkAndFireNow(childSessionId: string): Promise<void> {
    const watch = this.deps.sessionManager.getMergeWatch(childSessionId);
    if (!watch || isTerminalWatchState(watch.state)) return;
    const info = infoFromWatch(childSessionId, watch) ?? this.unreportedPrFor(childSessionId, watch);
    if (info) await this.handleParentWatchTerminal(info);
  }

  // The oldest PR that resolved on the child and that this watch's parent was not told about.
  private unreportedPrFor(childSessionId: string, watch: SessionMergeWatch): PrTerminalStateInfo | undefined {
    const [kept] = unreportedPrs(watch);
    if (kept) return { sessionId: childSessionId, ...kept };
    const reported = watch.reportedPr;
    // A child that continues after a merge clears its snapshot and keeps that merge as its
    // previous one, which is then older than any snapshot. Only an arm that follows an earlier
    // report reads it: a first arm waits for the next PR.
    const child = this.deps.sessionManager.get(childSessionId);
    const previous = child?.previousMergedPr;
    if (child && previous && reported && mergedAfterReport(previous.number, reported)) {
      return {
        sessionId: childSessionId,
        outcome: "merged",
        prNumber: previous.number,
        prUrl: previous.url,
        prTitle: previous.title,
        branch: child.branch ?? "",
      };
    }
    const snapshot = this.infoFromPersistedStatus(childSessionId);
    return snapshot && !samePrOutcome(reported, snapshot) ? snapshot : undefined;
  }

  private infoFromPersistedStatus(childSessionId: string): PrTerminalStateInfo | undefined {
    const status = this.prStatusLookup?.(childSessionId);
    if (!status || (status.prState !== "merged" && status.prState !== "closed")) return undefined;
    return {
      sessionId: childSessionId,
      outcome: status.prState === "merged" ? "merged" : "closed",
      prNumber: status.prNumber ?? 0,
      prUrl: status.prUrl ?? "",
      prTitle: status.prTitle ?? "",
      branch: status.headBranch ?? "",
    };
  }

  // The poller's terminal hook. Each of the session's two watches takes its own path from here.
  async handleChildPrTerminal(info: PrTerminalStateInfo): Promise<void> {
    if (info.outcome === "merged") {
      // The self wake waits for handleSelfMerge: the reset anchor and remote branch deletion come
      // first. Keep the merge facts for it; a docs/202 re-arm in between clears the PR snapshot.
      const self = this.deps.sessionManager.getSelfMergeWatch(info.sessionId);
      if (self?.state === "armed") {
        this.deps.sessionManager.setSelfMergeWatch(info.sessionId, { ...self, mergedPr: mergedPrOf(info) });
      }
    } else {
      try {
        this.handleSelfPrClosed(info);
      } catch (err) {
        console.error(`[merge-watch] self-watch close handling failed for ${info.sessionId}:`, err);
      }
    }
    await this.handleParentWatchTerminal(info);
  }

  private async handleParentWatchTerminal(event: PrTerminalStateInfo): Promise<void> {
    const child = this.deps.sessionManager.get(event.sessionId);
    const found = child?.mergeWatch;
    if (!child || !found) return;
    const parent = this.deps.sessionManager.get(found.parentSessionId);
    const parentGone = !parent || parent.archived || parent.userArchived;
    // One arm reports one PR. A watch that fired, or that delivers another PR, keeps this one
    // for the arm that follows it. An archived parent is told nothing, so nothing is kept for it.
    if (isTerminalWatchState(found.state)) {
      if (!parentGone) this.keepForNextArm(event.sessionId, found, event);
      else if (found.unreportedPrs) this.deps.sessionManager.setMergeWatch(event.sessionId, withUnreportedPrs(found, []));
      return;
    }
    if (parentGone) {
      console.log(
        `[merge-watch] dropped the parent watch on ${event.sessionId}: `
        + `parent ${found.parentSessionId} is archived or gone`,
      );
      this.clearWatch(event.sessionId, "parent");
      return;
    }
    if (found.state === "merge-observed") {
      // Its own merge, repeated by the poller or read back at startup.
      if (event.outcome === "merged" && (!found.mergedPr || found.mergedPr.prNumber === event.prNumber)) {
        await this.storeObservedMerge(parent, child, event);
        return;
      }
      // Any other PR waits for the next arm. A watch with no record of its merge and no turn
      // that can still report it has nothing to wait for: it reports this PR, as an armed one does.
      if (found.mergedPr || this.isDeliveryInFlight(event.sessionId, found)) {
        this.keepForNextArm(event.sessionId, found, event);
        return;
      }
    }
    // The poller can repeat a terminal event (merge-claim recovery promotes with `force`).
    if (samePrOutcome(found.reportedPr, event)) return;

    // The PRs that an armed watch kept are older than this event: it reports the first of
    // them, and the event waits behind the others.
    const [first, ...later] = addUnreportedPr(unreportedPrs(found), prOf(event), "last");
    const info: PrTerminalStateInfo = { sessionId: event.sessionId, ...first };
    const now = new Date().toISOString();
    const ended = withUnreportedPrs(
      {
        parentSessionId: found.parentSessionId,
        state: info.outcome === "merged" ? "delivered" : "closed-unmerged",
        registeredAt: found.registeredAt,
        observedAt: now,
        deliveredAt: now,
        reportedPr: { prNumber: info.prNumber, outcome: info.outcome },
      },
      later,
    );
    // docs/328-session-message-inbox req 6 — the stored notice is the delivery, and the watch
    // ends in the transaction that stores it: a write that fails changes nothing.
    this.deps.sessionInbox.add(parent.id, { body: buildChildPrNotice(child, info) }, () => {
      this.deps.sessionManager.setMergeWatch(info.sessionId, ended);
    });
    this.surfaceCard(parent.id, child, info);
    await this.tellParent(parent, child, info);
  }

  /**
   * A parent's watch that an older ShipIt left `merge-observed`, with a wake turn in delivery.
   * While that turn can still end, its settlement ends the watch; after it, this notice does.
   */
  private async storeObservedMerge(
    parent: SessionInfo,
    child: SessionInfo,
    event: PrTerminalStateInfo,
  ): Promise<void> {
    const watch = this.deps.sessionManager.getMergeWatch(child.id);
    if (watch?.state !== "merge-observed" || this.isDeliveryInFlight(child.id, watch)) return;
    // What the watch recorded is what it reports; the event only serves a watch without it.
    const merged = infoFromWatch(child.id, watch) ?? event;
    let followed = false;
    // A store that throws leaves the watch as it is, for the retry pass.
    this.ensureRetryLoop();
    this.deps.sessionInbox.add(parent.id, { body: buildChildPrNotice(child, merged) }, () => {
      // `markDelivered` reads the PR that it records as reported from the watch.
      if (!watch.mergedPr) this.deps.sessionManager.setMergeWatch(child.id, { ...watch, mergedPr: mergedPrOf(merged) });
      followed = this.markDelivered(child.id, "parent", watch.observedAt ?? new Date().toISOString());
    });
    this.afterDelivered(child.id, followed);
    await this.tellParent(parent, child, merged);
  }

  private async tellParent(parent: SessionInfo, child: SessionInfo, info: PrTerminalStateInfo): Promise<void> {
    const told = await this.deps.sessionInbox.tell(parent.id);
    console.log(
      `[merge-watch] PR #${info.prNumber} of ${child.id} ${info.outcome === "merged" ? "merged" : "closed"}: `
      + `the notice is in the inbox of ${parent.id} (its agent is told: ${told})`,
    );
  }

  private isParentGone(parentSessionId: string): boolean {
    const parent = this.deps.sessionManager.get(parentSessionId);
    return !parent || parent.archived === true || parent.userArchived === true;
  }

  private keepForNextArm(childSessionId: string, watch: SessionMergeWatch, info: PrTerminalStateInfo): void {
    if (samePrOutcome(watch.reportedPr, info)) return;
    const kept = unreportedPrs(watch);
    const next = addUnreportedPr(kept, prOf(info), "last");
    if (next !== kept) this.deps.sessionManager.setMergeWatch(childSessionId, withUnreportedPrs(watch, next));
  }

  // Called after markMergedAndPruneExcess resolves, when resetting and pushing are safe.
  async handleSelfMerge(sessionId: string): Promise<void> {
    const session = this.deps.sessionManager.get(sessionId);
    const watch = session?.selfMergeWatch;
    if (!session || !watch) return;
    if (isTerminalWatchState(watch.state)) return;

    if (session.archived || session.userArchived) {
      console.log(`[merge-watch] dropped the self-watch on ${sessionId}: the session is archived`);
      this.clearWatch(sessionId, "self");
      return;
    }

    const info = infoFromWatch(sessionId, watch) ?? this.infoFromPersistedStatus(sessionId);
    if (info?.outcome !== "merged") return;

    if (watch.prNumber !== undefined && info.prNumber !== watch.prNumber) {
      this.appendNote(
        sessionId,
        `PR #${info.prNumber} merged, but this session was waiting on PR #${watch.prNumber}. `
        + "The watch was armed for different work, so nothing was resumed automatically — "
        + "send a message to continue.",
        "warn",
      );
      console.log(
        `[merge-watch] dropped the self-watch on ${sessionId}: `
        + `PR #${info.prNumber} merged, the watch was on PR #${watch.prNumber}`,
      );
      this.clearWatch(sessionId, "self");
      endSelfMergeWatchCard(this.deps, sessionId, watch.watchId, "other-pr-merged");
      return;
    }

    if (watch.state === "armed") {
      this.deps.sessionManager.setSelfMergeWatch(sessionId, {
        ...watch,
        state: "merge-observed",
        observedAt: new Date().toISOString(),
        mergedPr: mergedPrOf(info),
      });
      endSelfMergeWatchCard(this.deps, sessionId, watch.watchId, "merged");
    }
    await this.attemptSelfWake(session, info);
  }

  private handleSelfPrClosed(info: PrTerminalStateInfo): void {
    const sessionId = info.sessionId;
    const watch = this.deps.sessionManager.getSelfMergeWatch(sessionId);
    if (!watch || isTerminalWatchState(watch.state)) return;
    if (watch.prNumber !== undefined && info.prNumber !== watch.prNumber) {
      return;
    }
    this.appendNote(
      sessionId,
      `PR #${info.prNumber} was closed without merging, so this session was not resumed. `
      + "The merge-watch has been cleared — send a message to decide what to do next.",
      "warn",
    );
    console.log(`[merge-watch] dropped the self-watch on ${sessionId}: PR #${info.prNumber} closed unmerged`);
    this.clearWatch(sessionId, "self");
    endSelfMergeWatchCard(this.deps, sessionId, watch.watchId, "closed");
  }

  private appendNote(sessionId: string, text: string, level: "info" | "warn"): void {
    const runner = this.deps.runnerRegistry.get(sessionId);
    emitNoticePostTurn(
      (m) => runner?.emitMessage(m),
      this.deps.chatHistoryManager,
      sessionId,
      text,
      level,
    );
  }

  forgetSelfWatch(sessionId: string): void {
    this.clearWatch(sessionId, "self");
  }

  private readWatch(sessionId: string, slot: WatchSlot): SessionMergeWatch | undefined {
    return slot === "self"
      ? this.deps.sessionManager.getSelfMergeWatch(sessionId)
      : this.deps.sessionManager.getMergeWatch(sessionId);
  }

  private writeWatch(sessionId: string, slot: WatchSlot, watch: SessionMergeWatch | null): void {
    if (slot === "self") this.deps.sessionManager.setSelfMergeWatch(sessionId, watch);
    else this.deps.sessionManager.setMergeWatch(sessionId, watch);
  }

  private async attemptSelfWake(session: SessionInfo, info: PrTerminalStateInfo): Promise<void> {
    const sessionId = session.id;
    const key = slotKey(sessionId, "self");
    const watch = this.readWatch(sessionId, "self");
    if (watch?.state !== "merge-observed") return;
    // All callers use this guard, including reconciliation after turn adoption.
    if (this.isDeliveryInFlight(sessionId, watch)) return;
    if (watch.quotaWait && this.holdForQuota(sessionId, watch, watch.quotaWait)) return;
    // Spent by an attempt that a restart cut off from its settlement: the retry pass, which
    // asks the worker first, ends the watch.
    if (spentAttempts(watch) >= MAX_DELIVERY_ATTEMPTS) {
      this.ensureRetryLoop();
      return;
    }

    // What the watch recorded is what it delivers; the argument only serves a watch without it.
    const merged = infoFromWatch(sessionId, watch) ?? info;
    const text = buildSelfWakeTurnPrompt(merged);
    const promptShown = (watch.deliveryAttempts ?? 0) > 0 && this.promptInTranscript(sessionId, text);
    const attempts = (watch.deliveryAttempts ?? 0) + 1;
    const spent = spentAttempts(watch) + 1;
    const observedAt = watch.observedAt ?? new Date().toISOString();
    // Persist identity before dispatch so restart adoption can bind the surviving turn.
    const deliveryId = `${watch.watchId ?? sessionId}:${attempts}`;
    const { quotaWait: _waitEnds, ...unheld } = watch;
    this.writeWatch(sessionId, "self", {
      ...unheld,
      deliveryAttempts: attempts,
      lastAttemptAt: new Date().toISOString(),
      deliveryId,
      // A watch observed before `mergedPr` existed gets it here, for its later retries.
      mergedPr: mergedPrOf(merged),
    });
    this.dispatching.add(key);
    this.ensureRetryLoop();
    console.log(
      `[merge-watch] PR #${merged.prNumber} of ${sessionId} merged: waking it `
      + `(attempt ${spent}/${MAX_DELIVERY_ATTEMPTS})`,
    );

    try {
      // Carry settlement through both queued and immediate dispatch; the durable id survives restart.
      const handle = await wakeSessionWithTurn(this.deps, session, {
        text,
        activity: "Resuming after your PR merged…",
        onSettled: this.buildDeliverySettlement(sessionId, "self", watch.watchId, spent, observedAt),
        deliveryId,
        ...(promptShown ? { promptShown: true } : {}),
      });
      // Delivered marks the dispatch, not the turn; say which one this was.
      if (handle.admitted !== "started") {
        console.log(
          `[merge-watch] the wake for ${sessionId} was ${handle.admitted}; no turn has started on it yet`,
        );
      }
    } catch (err) {
      const message = errorMessage(err);
      console.error(
        `[merge-watch] wake-turn delivery failed for ${sessionId} `
        + `(attempt ${spent}/${MAX_DELIVERY_ATTEMPTS}):`,
        err,
      );
      if (!this.isCurrentWatch(sessionId, "self", watch.watchId)) return;
      const current = this.readWatch(sessionId, "self");
      if (current?.state !== "merge-observed") return;
      this.writeWatch(sessionId, "self", { ...current, lastDeliveryError: message });
      if (spent >= MAX_DELIVERY_ATTEMPTS) this.failSelfWatch(sessionId, message);
    } finally {
      this.dispatching.delete(key);
    }
  }

  /** True while the wake waits for a reset, or for a running turn to end. */
  private holdForQuota(
    sessionId: string,
    watch: SessionMergeWatch,
    wait: NonNullable<SessionMergeWatch["quotaWait"]>,
  ): boolean {
    // Before the timestamp: a turn claims `running` during setup, before it stamps the session.
    const runner = this.deps.runnerRegistry.get(sessionId);
    if (runner && !runner.disposed && runner.running) {
      this.ensureRetryLoop();
      return true;
    }
    const session = this.deps.sessionManager.get(sessionId);
    // A turn since the refusal took the session on, and the wake is not needed. A turn that no
    // credential could run leaves the session stopped by quota, which resumes by itself (req 4).
    if (session && session.lastUsedAt !== wait.lastUsedAt && session.lastTurnOutcome !== "quota-refused") {
      console.log(`[merge-watch] a turn has run on ${sessionId} since its wake was refused; the wake is not needed`);
      this.afterDelivered(sessionId, this.markDelivered(sessionId, "self", watch.observedAt ?? wait.until));
      return true;
    }
    const until = Date.parse(wait.until);
    if (!Number.isFinite(until) || Date.now() >= until) return false;
    this.ensureRetryLoop();
    return true;
  }

  private recordQuotaRefusal(sessionId: string, resetsAt: readonly (string | null)[]): void {
    const current = this.readWatch(sessionId, "self");
    const session = this.deps.sessionManager.get(sessionId);
    if (current?.state !== "merge-observed" || !session) return;
    const refusals = (current.quotaRefusals ?? 0) + 1;
    const reason = "no connected account could run the wake";
    const refused: SessionMergeWatch = { ...current, quotaRefusals: refusals, lastDeliveryError: reason };
    if (refusals >= MAX_QUOTA_REFUSALS) {
      this.writeWatch(sessionId, "self", refused);
      this.failSelfWatch(sessionId, `${reason} ${refusals} times`);
      return;
    }
    const until = new Date(quotaWaitUntil(resetsAt, refusals, Date.now()));
    this.writeWatch(sessionId, "self", {
      ...refused,
      quotaWait: { until: until.toISOString(), lastUsedAt: session.lastUsedAt },
    });
    console.log(
      `[merge-watch] ${reason} on ${sessionId} (${refusals}/${MAX_QUOTA_REFUSALS}); `
      + `the next attempt is at ${until.toISOString()} and spends no delivery attempt`,
    );
    const pr = current.mergedPr ? ` #${current.mergedPr.prNumber}` : "";
    this.appendNote(
      sessionId,
      `No connected account could run this session's work, so it could not resume after your PR${pr} merged. `
      + `ShipIt will try again at ${formatUtc(until)}. You do not need to do anything.`,
      "info",
    );
    this.ensureRetryLoop();
  }

  // An earlier attempt's turn persisted the prompt, unless a rewind has taken it out since.
  private promptInTranscript(sessionId: string, text: string): boolean {
    try {
      return this.deps.chatHistoryManager.hasUserMessage(sessionId, text);
    } catch (err) {
      console.warn(`[merge-watch] could not read the transcript of ${sessionId}; showing the wake prompt:`, err);
      return false;
    }
  }

  // A wake turn may re-arm before settling; its old callback must not change the new watch.
  // A parent's watch armed by older code has no id, and neither does its callback.
  private isCurrentWatch(
    childSessionId: string,
    slot: WatchSlot,
    expectedWatchId: string | undefined,
  ): boolean {
    return this.readWatch(childSessionId, slot)?.watchId === expectedWatchId;
  }

  private buildDeliverySettlement(
    childSessionId: string,
    slot: WatchSlot,
    expectedWatchId: string | undefined,
    attempts: number,
    observedAt: string,
  ): (outcome: TurnOutcome) => void {
    return (outcome: TurnOutcome) => {
      if (!this.isCurrentWatch(childSessionId, slot, expectedWatchId)) return;
      if (outcome.status === "completed") {
        this.afterDelivered(childSessionId, this.markDelivered(childSessionId, slot, observedAt));
        return;
      }
      // An interrupted turn reached the agent; retrying would duplicate a delivered notification.
      if (outcome.status === "interrupted") {
        console.warn(
          `[merge-watch] wake-turn for ${childSessionId} reached the agent and was then cut short `
          + `(${outcome.detail ?? "interrupted"}) — treating the wake as delivered, not re-delivering`,
        );
        this.afterDelivered(childSessionId, this.markDelivered(childSessionId, slot, observedAt));
        return;
      }
      if (slot === "self" && outcome.quotaRefused) {
        this.recordQuotaRefusal(childSessionId, outcome.quotaRefused.resetsAt);
        return;
      }
      this.recordDeliveryOutcomeFailure(
        childSessionId,
        slot,
        attempts,
        outcome.detail ?? `wake-turn ended as "${outcome.status}"`,
      );
    };
  }

  rebindDelivery(deliveryId: string): ((outcome: TurnOutcome) => void) | undefined {
    const entry = this.deps.sessionManager
      .listPendingMergeWatches()
      .find(({ watch }) => watch.state === "merge-observed" && watch.deliveryId === deliveryId);
    if (!entry) return undefined;
    const { childSessionId, watch } = entry;
    this.ensureRetryLoop();
    return this.buildDeliverySettlement(
      childSessionId,
      slotOf(watch),
      watch.watchId,
      Math.max(1, spentAttempts(watch)),
      watch.observedAt ?? watch.registeredAt,
    );
  }

  async retryStalledDeliveries(): Promise<void> {
    const stalled = this.deps.sessionManager
      .listPendingMergeWatches()
      .filter(({ watch }) => watch.state === "merge-observed");
    if (stalled.length === 0) {
      this.stopRetryLoop();
      return;
    }

    const now = Date.now();
    for (const { childSessionId, watch } of stalled) {
      if (this.isDeliveryInFlight(childSessionId, watch)) continue;
      // A parent's notice is stored, and a busy session can take it: no attempt to space or count.
      if (slotOf(watch) === "self") {
        // Before the worker probe: a quota wait can last for days.
        if (watch.quotaWait && this.holdForQuota(childSessionId, watch, watch.quotaWait)) continue;
        if (await this.isSessionTurnInFlight(watch.parentSessionId)) continue;

        const attempts = spentAttempts(watch);
        const lastAt = Date.parse(watch.lastAttemptAt ?? watch.observedAt ?? watch.registeredAt);
        // A quota wait that has ended was the spacing.
        if (!watch.quotaWait && Number.isFinite(lastAt) && now - lastAt < retryBackoffMs(attempts)) continue;

        if (attempts >= MAX_DELIVERY_ATTEMPTS) {
          this.failSelfWatch(childSessionId, watch.lastDeliveryError ?? "wake-turn never ran");
          continue;
        }
      }

      try {
        await this.retryDelivery(childSessionId, watch);
      } catch (err) {
        console.error(`[merge-watch] retry pass failed for ${childSessionId}:`, err);
      }
    }
    this.stopRetryLoopIfIdle();
  }

  private isDeliveryInFlight(childSessionId: string, watch: SessionMergeWatch): boolean {
    if (this.dispatching.has(slotKey(childSessionId, slotOf(watch)))) return true;
    if (!watch.deliveryId) return false;
    // docs/322 — a wake held for the user's answer is saved, with or without a runner.
    if (hasHeldDelivery(this.deps.sessionManager, watch.parentSessionId, watch.deliveryId)) return true;
    const runner = this.deps.runnerRegistry.get(watch.parentSessionId);
    if (!runner || runner.disposed) return false;
    return runner.hasDelivery(watch.deliveryId);
  }

  // The worker may be busy while runner.running is stale. Never retire that live turn to retry.
  private async isSessionTurnInFlight(sessionId: string): Promise<boolean> {
    const runner = this.deps.runnerRegistry.get(sessionId);
    if (!runner || runner.disposed) return false;
    if (runner.running) return true;
    if (!runner.hasTurnInFlight) return false;
    try {
      return await runner.hasTurnInFlight();
    } catch (err) {
      console.warn(`[merge-watch] could not read turn state for ${sessionId}; assuming idle:`, err);
      return false;
    }
  }

  private async retryDelivery(childSessionId: string, watch: SessionMergeWatch): Promise<void> {
    const child = this.deps.sessionManager.get(childSessionId);
    if (!child) return;
    const slot = slotOf(watch);
    const parent = this.deps.sessionManager.get(watch.parentSessionId);
    if (!parent || parent.archived || parent.userArchived) {
      console.log(
        `[merge-watch] dropped the ${slot} watch on ${childSessionId} before a retry: `
        + `${watch.parentSessionId} is archived or gone`,
      );
      this.clearWatch(childSessionId, slot);
      return;
    }
    const info = infoFromWatch(childSessionId, watch) ?? this.infoFromPersistedStatus(childSessionId);
    if (info?.outcome !== "merged") return;
    if (slot === "self") await this.attemptSelfWake(child, info);
    else await this.storeObservedMerge(parent, child, info);
  }

  // Only a wake turn can fail for good. A parent's notice is stored, and its inbox tells the agent.
  private failSelfWatch(sessionId: string, error: string): void {
    const watch = this.readWatch(sessionId, "self");
    if (watch?.state !== "merge-observed") return;
    this.writeWatch(sessionId, "self", {
      ...watch,
      state: "delivery-failed",
      failedAt: new Date().toISOString(),
      lastDeliveryError: error,
    });
    endSelfMergeWatchCard(this.deps, sessionId, watch.watchId, "wake-failed");

    const session = this.deps.sessionManager.get(sessionId);
    const attempts = watch.deliveryAttempts ?? MAX_DELIVERY_ATTEMPTS;
    if (session && !session.archived && !session.userArchived) {
      this.appendNote(
        sessionId,
        `Your PR merged, but this session could not be resumed automatically after ${attempts} `
        + `attempts (${error}). The merge-watch has given up — send a message to continue.`,
        "warn",
      );
    }
    console.error(`[merge-watch] giving up on the wake-turn for ${sessionId} after ${attempts} attempts: ${error}`);
    this.stopRetryLoopIfIdle();
  }

  // docs/196-session-notify-on-merge req 3 — the parent armed again while `ended` was
  // `merge-observed`: a watch that an older ShipIt left with a wake turn in delivery.
  private armFollowingWatch(
    childSessionId: string,
    ended: SessionMergeWatch,
    reportedPr: SessionMergeWatch["reportedPr"],
  ): boolean {
    if (!ended.rearmedAt || this.isParentGone(ended.parentSessionId)) return false;
    const following: SessionMergeWatch = {
      parentSessionId: ended.parentSessionId,
      watchId: randomUUID(),
      state: "armed",
      registeredAt: ended.rearmedAt,
      ...(reportedPr ? { reportedPr } : {}),
    };
    // Read through the watch that ends: its own `reportedPr` has left some entries out already.
    this.deps.sessionManager.setMergeWatch(childSessionId, withUnreportedPrs(following, unreportedPrs(ended)));
    console.log(
      `[merge-watch] parent ${ended.parentSessionId}'s watch on ${childSessionId} is armed for the next PR: `
      + `the parent armed again before the notice about PR #${ended.mergedPr?.prNumber ?? "?"} was stored`,
    );
    return true;
  }

  /**
   * What follows a watch that ended, outside the write that ended it: that write can be part
   * of a transaction, and a check that ran inside one that rolls back would run again at once.
   */
  private afterDelivered(childSessionId: string, followed: boolean): void {
    this.stopRetryLoopIfIdle();
    if (!followed) return;
    // The next PR can have resolved in the meantime. A wake turn's settlement calls this, so
    // the check waits until the turn executor has returned.
    setImmediate(() => {
      void this.checkAndFireNow(childSessionId).catch((err: unknown) => {
        console.error(`[merge-watch] check after a queued arm failed for ${childSessionId}:`, err);
      });
    });
  }

  private clearWatch(childSessionId: string, slot: WatchSlot): void {
    this.writeWatch(childSessionId, slot, null);
    this.dispatching.delete(slotKey(childSessionId, slot));
    this.stopRetryLoopIfIdle();
  }

  private ensureRetryLoop(): void {
    if (this.retryTimer) return;
    this.retryTimer = setInterval(() => {
      void this.retryStalledDeliveries().catch((err: unknown) => {
        console.error("[merge-watch] retry pass errored:", err);
      });
    }, RETRY_TICK_MS);
    this.retryTimer.unref?.();
  }

  private stopRetryLoopIfIdle(): void {
    if (!this.retryTimer) return;
    const anyPending = this.deps.sessionManager
      .listPendingMergeWatches()
      .some(({ watch }) => watch.state === "merge-observed");
    if (!anyPending) this.stopRetryLoop();
  }

  async reconcilePending(): Promise<void> {
    if (!this.prStatusLookup) return;
    const pending = this.deps.sessionManager.listPendingMergeWatches();
    for (const { childSessionId, watch } of pending) {
      try {
        if (watch.kind === "self") {
          await this.handleSelfMerge(childSessionId);
          continue;
        }
        const info = infoFromWatch(childSessionId, watch) ?? this.unreportedPrFor(childSessionId, watch);
        if (!info) continue;
        await this.handleParentWatchTerminal(info);
      } catch (err) {
        console.error(`[merge-watch] reconcile delivery failed for ${childSessionId}:`, err);
      }
    }
  }

  private recordDeliveryOutcomeFailure(
    childSessionId: string,
    slot: WatchSlot,
    attempts: number,
    reason: string,
  ): void {
    console.error(
      `[merge-watch] wake-turn for ${childSessionId} (${slot} watch) did not complete `
      + `(attempt ${attempts}/${MAX_DELIVERY_ATTEMPTS}): ${reason}`,
    );
    const current = this.readWatch(childSessionId, slot);
    if (current?.state !== "merge-observed") return;
    this.writeWatch(childSessionId, slot, { ...current, lastDeliveryError: reason });
    // A parent's wake turn is one that an older ShipIt started: the retry pass stores its notice.
    if (slot === "self" && attempts >= MAX_DELIVERY_ATTEMPTS) this.failSelfWatch(childSessionId, reason);
    else this.ensureRetryLoop();
  }

  /** Writes only, and returns true when a watch for the next PR follows; `afterDelivered` does the rest. */
  private markDelivered(childSessionId: string, slot: WatchSlot, fallbackObservedAt: string): boolean {
    const watch = this.readWatch(childSessionId, slot);
    if (!watch || isTerminalWatchState(watch.state)) return false;
    const reportedPr = slot === "parent" ? reportedMerge(watch) : undefined;
    if (slot === "parent" && this.armFollowingWatch(childSessionId, watch, reportedPr)) return true;
    const delivered: SessionMergeWatch = {
      parentSessionId: watch.parentSessionId,
      state: "delivered",
      registeredAt: watch.registeredAt,
      observedAt: watch.observedAt ?? fallbackObservedAt,
      deliveredAt: new Date().toISOString(),
      ...(watch.deliveryAttempts !== undefined ? { deliveryAttempts: watch.deliveryAttempts } : {}),
      ...(watch.lastAttemptAt !== undefined ? { lastAttemptAt: watch.lastAttemptAt } : {}),
      ...(reportedPr ? { reportedPr } : {}),
    };
    this.writeWatch(childSessionId, slot, withUnreportedPrs(delivered, unreportedPrs(watch)));
    return false;
  }

  private surfaceCard(parentId: string, child: SessionInfo, info: PrTerminalStateInfo): void {
    const card: ChildMergedCard = {
      cardId: `child-merged-${randomUUID()}`,
      childSessionId: child.id,
      childTitle: child.title,
      ...(child.branch ? { branch: child.branch } : {}),
      outcome: info.outcome === "merged" ? "merged" : "closed-unmerged",
      prNumber: info.prNumber,
      prUrl: info.prUrl,
      ...(info.prTitle ? { prTitle: info.prTitle } : {}),
      ...(info.mergeSha ? { mergeSha: info.mergeSha } : {}),
      createdAt: new Date().toISOString(),
    };
    this.deps.chatHistoryManager.append(parentId, { role: "assistant", text: "", childMerged: card });
    const runner = this.deps.runnerRegistry.get(parentId);
    if (runner) {
      const message: WsServerMessage = { type: "child_merged_card", sessionId: parentId, card };
      runner.emitMessage(message);
    }
  }
}

function mergedPrOf(info: PrTerminalStateInfo): NonNullable<SessionMergeWatch["mergedPr"]> {
  return {
    prNumber: info.prNumber,
    prUrl: info.prUrl,
    prTitle: info.prTitle,
    branch: info.branch,
    ...(info.mergeSha ? { mergeSha: info.mergeSha } : {}),
  };
}

function prOf(info: PrTerminalStateInfo): SessionMergeWatchPr {
  const { sessionId: _session, ...pr } = info;
  return pr;
}

// One branch has one PR at a time, so its PRs are numbered in the order they resolved. A PR
// reported as closed can be reopened and merged under the same number.
function mergedAfterReport(prNumber: number, reported: NonNullable<SessionMergeWatch["reportedPr"]>): boolean {
  return prNumber > reported.prNumber || (prNumber === reported.prNumber && reported.outcome === "closed");
}

// The merge this watch delivered, or what it inherited when it has no record of one.
function reportedMerge(watch: SessionMergeWatch): SessionMergeWatch["reportedPr"] {
  return watch.mergedPr ? { prNumber: watch.mergedPr.prNumber, outcome: "merged" } : watch.reportedPr;
}

function infoFromWatch(sessionId: string, watch: SessionMergeWatch): PrTerminalStateInfo | undefined {
  return watch.mergedPr ? { sessionId, outcome: "merged", ...watch.mergedPr } : undefined;
}

function spentAttempts(watch: SessionMergeWatch): number {
  return (watch.deliveryAttempts ?? 0) - (watch.quotaRefusals ?? 0);
}

// The earliest reset a refusal stated. One that stated none is tried again when the router would
// probe that credential again (docs/260). Never sooner than the ordinary backoff.
function quotaWaitUntil(resetsAt: readonly (string | null)[], refusals: number, now: number): number {
  const times = resetsAt.map((at) => {
    const stated = at === null ? Number.NaN : Date.parse(at);
    return Number.isFinite(stated) ? stated + QUOTA_RESET_MARGIN_MS : now + REFUSAL_REPROBE_MS;
  });
  const earliest = times.length > 0 ? Math.min(...times) : now + REFUSAL_REPROBE_MS;
  return Math.max(earliest, now + retryBackoffMs(refusals));
}

function formatUtc(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function isTerminalWatchState(state: SessionMergeWatch["state"]): boolean {
  return state === "delivered" || state === "closed-unmerged" || state === "delivery-failed";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function buildChildPrNotice(child: SessionInfo, info: PrTerminalStateInfo): string {
  const lines: string[] = [];
  const id = `${child.title} (${child.id})`;
  if (info.outcome === "merged") {
    lines.push(
      `Child PR #${info.prNumber} merged: ${id}${info.prTitle ? ` — ${info.prTitle}` : ""}.`,
      `Continue the dependent work from this session's context unless the user redirected it.`,
    );
  } else {
    lines.push(
      `Child PR #${info.prNumber} closed without merging: ${id}${info.prTitle ? ` — ${info.prTitle}` : ""}.`,
      `The dependency did not ship; reassess the plan and tell the user.`,
    );
  }
  return lines.join("\n");
}

function buildSelfWakeTurnPrompt(info: PrTerminalStateInfo): string {
  return fillPromptTokens(SELF_MERGE_WAKE_PROMPT, {
    PR_NUMBER: String(info.prNumber),
    PR_TITLE_SUFFIX: info.prTitle ? ` — ${info.prTitle}` : "",
    BRANCH_LINE: info.branch ? `\nBranch:        ${info.branch}` : "",
  });
}
