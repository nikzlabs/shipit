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
import { wakeSessionWithTurn, type WakeSessionDeps } from "./wake-session.js";
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

export interface MergeWatchDeps extends WakeSessionDeps {
  chatHistoryManager: ChatHistoryManager;
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
  // Keyed by slotKey: one merge starts both of a session's deliveries at once.
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
    if (found.state === "merge-observed" && found.mergedPr && found.mergedPr.prNumber !== event.prNumber) {
      this.keepForNextArm(event.sessionId, found, event);
      return;
    }
    // The poller can repeat a terminal event (merge-claim recovery promotes with `force`).
    if (found.state === "armed" && samePrOutcome(found.reportedPr, event)) return;

    // The PRs that an armed watch kept are older than this event: it reports the first of
    // them, and the event waits behind the others.
    let watch = found;
    let info = event;
    if (found.state === "armed") {
      const [first, ...later] = addUnreportedPr(unreportedPrs(found), prOf(event), "last");
      info = { sessionId: event.sessionId, ...first };
      watch = withUnreportedPrs(found, later);
    }

    const now = new Date().toISOString();
    const cardOutcome = info.outcome === "merged" ? "merged" : "closed-unmerged";

    if (info.outcome === "merged") {
      if (watch.state === "armed") {
        this.deps.sessionManager.setMergeWatch(info.sessionId, {
          ...watch,
          state: "merge-observed",
          observedAt: now,
          mergedPr: mergedPrOf(info),
        });
        this.surfaceCard(parent.id, child, info, cardOutcome);
      }
      // Enqueueing is not delivery: settlement must confirm the turn reached the agent.
      await this.attemptDelivery("parent", parent, child, info);
      return;
    }

    // Closed-without-merge wakes are attempted once; mark terminal before dispatch.
    this.surfaceCard(parent.id, child, info, cardOutcome);
    const closed: SessionMergeWatch = {
      parentSessionId: watch.parentSessionId,
      ...(watch.watchId !== undefined ? { watchId: watch.watchId } : {}),
      state: "closed-unmerged",
      registeredAt: watch.registeredAt,
      observedAt: now,
      deliveredAt: now,
      deliveryAttempts: 1,
      lastAttemptAt: now,
      ...(watch.unreportedPrs ? { unreportedPrs: watch.unreportedPrs } : {}),
    };
    this.deps.sessionManager.setMergeWatch(info.sessionId, {
      ...closed,
      reportedPr: { prNumber: info.prNumber, outcome: "closed" },
    });
    try {
      await this.deliverWakeTurn(parent, child, info, cardOutcome);
    } catch (err) {
      const message = errorMessage(err);
      console.error(`[merge-watch] closed-unmerged wake-turn delivery failed for ${info.sessionId}:`, err);
      // The parent was not told: this close goes back in front of what the watch still owes,
      // for the next arm. The dispatch was awaited, so a newer watch can hold the slot by now,
      // and that one stays as it is.
      const current = this.deps.sessionManager.getMergeWatch(info.sessionId);
      if (current?.state === "closed-unmerged" && current.watchId === watch.watchId && current.observedAt === now) {
        const { reportedPr: _told, ...kept } = current;
        const untold: SessionMergeWatch = {
          ...kept,
          ...(watch.reportedPr ? { reportedPr: watch.reportedPr } : {}),
          lastDeliveryError: message,
        };
        // The parent can have been archived while the dispatch ran.
        const owed = this.isParentGone(watch.parentSessionId)
          ? []
          : addUnreportedPr(unreportedPrs(untold), prOf(info), "first");
        this.deps.sessionManager.setMergeWatch(info.sessionId, withUnreportedPrs(untold, owed));
      }
      if (!this.isParentGone(parent.id)) {
        this.surfaceCard(parent.id, child, info, cardOutcome, { attempts: 1, error: message });
      }
    }
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
    await this.attemptDelivery("self", session, session, info);
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

  // `parent` is the session to wake: the real parent, or the child itself in the self slot.
  private async attemptDelivery(
    slot: WatchSlot,
    parent: SessionInfo,
    child: SessionInfo,
    info: PrTerminalStateInfo,
  ): Promise<void> {
    const childId = child.id;
    const key = slotKey(childId, slot);
    const watch = this.readWatch(childId, slot);
    if (watch?.state !== "merge-observed") return;
    // All callers use this guard, including reconciliation after turn adoption.
    if (this.isDeliveryInFlight(childId, watch)) return;

    // What the watch recorded is what it delivers; the argument only serves a watch without it.
    const merged = infoFromWatch(childId, watch) ?? info;
    const attempts = (watch.deliveryAttempts ?? 0) + 1;
    const observedAt = watch.observedAt ?? new Date().toISOString();
    // Persist identity before dispatch so restart adoption can bind the surviving turn.
    const deliveryId = `${watch.watchId ?? childId}:${attempts}`;
    this.writeWatch(childId, slot, {
      ...watch,
      deliveryAttempts: attempts,
      lastAttemptAt: new Date().toISOString(),
      deliveryId,
      // A watch observed before `mergedPr` existed gets it here, for its later retries.
      mergedPr: mergedPrOf(merged),
    });
    this.dispatching.add(key);
    this.ensureRetryLoop();
    console.log(
      `[merge-watch] PR #${merged.prNumber} of ${childId} merged: waking ${parent.id} `
      + `(${slot} watch, attempt ${attempts}/${MAX_DELIVERY_ATTEMPTS})`,
    );

    try {
      await this.deliverWakeTurn(
        parent, child, merged, "merged",
        this.buildDeliverySettlement(childId, slot, watch.watchId, attempts, observedAt),
        deliveryId,
      );
    } catch (err) {
      const message = errorMessage(err);
      console.error(
        `[merge-watch] wake-turn delivery failed for ${childId} (${slot} watch, `
        + `attempt ${attempts}/${MAX_DELIVERY_ATTEMPTS}):`,
        err,
      );
      if (!this.isCurrentWatch(childId, slot, watch.watchId)) return;
      const current = this.readWatch(childId, slot);
      if (current?.state !== "merge-observed") return;
      this.writeWatch(childId, slot, { ...current, lastDeliveryError: message });
      if (attempts >= MAX_DELIVERY_ATTEMPTS) this.failWatch(childId, slot, message);
    } finally {
      this.dispatching.delete(key);
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
        this.markDelivered(childSessionId, slot, observedAt);
        return;
      }
      // An interrupted turn reached the agent; retrying would duplicate a delivered notification.
      if (outcome.status === "interrupted") {
        console.warn(
          `[merge-watch] wake-turn for ${childSessionId} reached the agent and was then cut short `
          + `(${outcome.detail ?? "interrupted"}) — treating the wake as delivered, not re-delivering`,
        );
        this.markDelivered(childSessionId, slot, observedAt);
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
      watch.deliveryAttempts ?? 1,
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
      if (await this.isParentTurnInFlight(watch)) continue;

      const attempts = watch.deliveryAttempts ?? 0;
      const lastAt = Date.parse(watch.lastAttemptAt ?? watch.observedAt ?? watch.registeredAt);
      if (Number.isFinite(lastAt) && now - lastAt < retryBackoffMs(attempts)) continue;

      if (attempts >= MAX_DELIVERY_ATTEMPTS) {
        this.failWatch(childSessionId, slotOf(watch), watch.lastDeliveryError ?? "wake-turn never ran");
        continue;
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
  private async isParentTurnInFlight(watch: SessionMergeWatch): Promise<boolean> {
    const runner = this.deps.runnerRegistry.get(watch.parentSessionId);
    if (!runner || runner.disposed) return false;
    if (runner.running) return true;
    if (!runner.hasTurnInFlight) return false;
    try {
      return await runner.hasTurnInFlight();
    } catch (err) {
      console.warn(
        `[merge-watch] could not read turn state for ${watch.parentSessionId}; assuming idle:`,
        err,
      );
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
    await this.attemptDelivery(slot, parent, child, info);
  }

  private failWatch(childSessionId: string, slot: WatchSlot, error: string): void {
    const watch = this.readWatch(childSessionId, slot);
    if (watch?.state !== "merge-observed") return;
    this.writeWatch(childSessionId, slot, {
      ...watch,
      state: "delivery-failed",
      failedAt: new Date().toISOString(),
      lastDeliveryError: error,
    });
    const info = infoFromWatch(childSessionId, watch) ?? this.infoFromPersistedStatus(childSessionId);
    if (slot === "self") endSelfMergeWatchCard(this.deps, childSessionId, watch.watchId, "wake-failed");

    const child = this.deps.sessionManager.get(childSessionId);
    const parent = this.deps.sessionManager.get(watch.parentSessionId);
    const attempts = watch.deliveryAttempts ?? MAX_DELIVERY_ATTEMPTS;
    if (watch.kind === "self") {
      if (child && !child.archived && !child.userArchived) {
        this.appendNote(
          childSessionId,
          `Your PR merged, but this session could not be resumed automatically after ${attempts} `
          + `attempts (${error}). The merge-watch has given up — send a message to continue.`,
          "warn",
        );
      }
    } else if (child && parent && !parent.archived && !parent.userArchived && info) {
      this.surfaceCard(parent.id, child, info, "merged", { attempts, error });
    }
    console.error(
      `[merge-watch] giving up on the wake-turn for ${childSessionId} (${slot} watch) after `
      + `${watch.deliveryAttempts ?? MAX_DELIVERY_ATTEMPTS} attempts: ${error}`,
    );
    // The failure card told the parent about this PR; the arm made in the meantime is for the next one.
    if (slot === "parent") this.armFollowingWatch(childSessionId, watch, reportedMerge(watch));
    this.stopRetryLoopIfIdle();
  }

  // docs/196-session-notify-on-merge req 3 — the parent armed again while `ended` was in delivery.
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
      + `the parent armed again during the wake for PR #${ended.mergedPr?.prNumber ?? "?"}`,
    );
    // The next PR can have resolved while the previous wake was in delivery. This runs inside
    // that wake's settlement, so the dispatch waits until the turn executor has returned.
    setImmediate(() => {
      void this.checkAndFireNow(childSessionId).catch((err: unknown) => {
        console.error(`[merge-watch] check after a queued arm failed for ${childSessionId}:`, err);
      });
    });
    return true;
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
    if (attempts >= MAX_DELIVERY_ATTEMPTS) this.failWatch(childSessionId, slot, reason);
    else this.ensureRetryLoop();
  }

  private markDelivered(childSessionId: string, slot: WatchSlot, fallbackObservedAt: string): void {
    const watch = this.readWatch(childSessionId, slot);
    if (!watch || isTerminalWatchState(watch.state)) return;
    const reportedPr = slot === "parent" ? reportedMerge(watch) : undefined;
    if (slot === "parent" && this.armFollowingWatch(childSessionId, watch, reportedPr)) {
      this.stopRetryLoopIfIdle();
      return;
    }
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
    this.stopRetryLoopIfIdle();
  }

  private surfaceCard(
    parentId: string,
    child: SessionInfo,
    info: PrTerminalStateInfo,
    outcome: "merged" | "closed-unmerged",
    deliveryFailure?: { attempts: number; error?: string },
  ): void {
    const card: ChildMergedCard = {
      cardId: `child-merged-${randomUUID()}`,
      childSessionId: child.id,
      childTitle: child.title,
      ...(child.branch ? { branch: child.branch } : {}),
      outcome,
      prNumber: info.prNumber,
      prUrl: info.prUrl,
      ...(info.prTitle ? { prTitle: info.prTitle } : {}),
      ...(info.mergeSha ? { mergeSha: info.mergeSha } : {}),
      ...(deliveryFailure ? { deliveryFailure } : {}),
      createdAt: new Date().toISOString(),
    };
    this.deps.chatHistoryManager.append(parentId, { role: "assistant", text: "", childMerged: card });
    const runner = this.deps.runnerRegistry.get(parentId);
    if (runner) {
      const message: WsServerMessage = { type: "child_merged_card", sessionId: parentId, card };
      runner.emitMessage(message);
    }
  }

  private async deliverWakeTurn(
    parent: SessionInfo,
    child: SessionInfo,
    info: PrTerminalStateInfo,
    outcome: "merged" | "closed-unmerged",
    onSettled?: (turnOutcome: TurnOutcome) => void,
    deliveryId?: string,
  ): Promise<void> {
    const isSelf = parent.id === child.id;
    const text = isSelf ? buildSelfWakeTurnPrompt(info) : buildWakeTurnPrompt(child, info, outcome);
    const activity = isSelf
      ? "Resuming after your PR merged…"
      : outcome === "merged" ? "Resuming after child PR merged…" : "Reassessing after child PR closed…";

    // Carry settlement through both queued and immediate dispatch; the durable id survives restart.
    const handle = await wakeSessionWithTurn(this.deps, parent, {
      text,
      activity,
      ...(onSettled ? { onSettled } : {}),
      ...(deliveryId !== undefined ? { deliveryId } : {}),
    });
    // Delivered marks the dispatch, not the turn; say which one this was.
    if (handle.admitted !== "started") {
      console.log(
        `[merge-watch] the wake for ${parent.id} about ${child.id} was ${handle.admitted}; `
        + "no turn has started on it yet",
      );
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

function isTerminalWatchState(state: SessionMergeWatch["state"]): boolean {
  return state === "delivered" || state === "closed-unmerged" || state === "delivery-failed";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function buildWakeTurnPrompt(
  child: SessionInfo,
  info: PrTerminalStateInfo,
  outcome: "merged" | "closed-unmerged",
): string {
  const lines: string[] = [];
  const id = `${child.title} (${child.id})`;
  if (outcome === "merged") {
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
