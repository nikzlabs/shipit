import { randomUUID } from "node:crypto";
import type { ChatHistoryManager } from "./chat-history.js";
import type { ChildMergedCard, SessionInfo, SessionMergeWatch, WsServerMessage } from "../shared/types.js";
import type { PrStatusSummary } from "../shared/types/github-types.js";
import { wakeSessionWithTurn, type WakeSessionDeps } from "./wake-session.js";
import type { PrTerminalStateInfo } from "./pr-status-poller.js";
import type { TurnOutcome } from "./turn-settlement.js";
import { emitNoticePostTurn } from "./chat-card-persistence.js";
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

export class MergeWatchManager {
  private prStatusLookup?: (sessionId: string) => PrStatusSummary | undefined;

  // Covers only dispatch's await, before a runner can report ownership of the delivery.
  private readonly dispatching = new Set<string>();

  // Preserve observed merge SHA for retries; the persisted PR snapshot lacks it.
  private readonly lastTerminalInfo = new Map<string, PrTerminalStateInfo>();
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
    const info = this.infoFromPersistedStatus(childSessionId);
    if (!info) return;
    await this.handleChildPrTerminal(info);
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

  async handleChildPrTerminal(info: PrTerminalStateInfo): Promise<void> {
    const child = this.deps.sessionManager.get(info.sessionId);
    const watch = child?.mergeWatch;
    if (!child || !watch) return;
    if (isTerminalWatchState(watch.state)) return;

    // Self-merge wakes must wait for the reset anchor and remote branch deletion.
    if (watch.kind === "self") {
      if (info.outcome === "merged") return;
      this.handleSelfPrClosed(info, watch);
      return;
    }

    const parent = this.deps.sessionManager.get(watch.parentSessionId);
    if (!parent || parent.archived || parent.userArchived) {
      this.clearWatch(info.sessionId);
      return;
    }

    const now = new Date().toISOString();
    const cardOutcome = info.outcome === "merged" ? "merged" : "closed-unmerged";

    if (info.outcome === "merged") {
      if (watch.state === "armed") {
        this.deps.sessionManager.setMergeWatch(info.sessionId, {
          ...watch,
          state: "merge-observed",
          observedAt: now,
        });
        this.surfaceCard(parent.id, child, info, cardOutcome);
      }
      // Enqueueing is not delivery: settlement must confirm the turn reached the agent.
      await this.attemptDelivery(parent, child, info);
      return;
    }

    // Closed-without-merge wakes are attempted once; mark terminal before dispatch.
    this.surfaceCard(parent.id, child, info, cardOutcome);
    this.deps.sessionManager.setMergeWatch(info.sessionId, {
      parentSessionId: watch.parentSessionId,
      state: "closed-unmerged",
      registeredAt: watch.registeredAt,
      observedAt: now,
      deliveredAt: now,
      deliveryAttempts: 1,
      lastAttemptAt: now,
    });
    try {
      await this.deliverWakeTurn(parent, child, info, cardOutcome);
    } catch (err) {
      const message = errorMessage(err);
      console.error(`[merge-watch] closed-unmerged wake-turn delivery failed for ${info.sessionId}:`, err);
      const current = this.deps.sessionManager.getMergeWatch(info.sessionId);
      if (current) {
        this.deps.sessionManager.setMergeWatch(info.sessionId, { ...current, lastDeliveryError: message });
      }
      this.surfaceCard(parent.id, child, info, cardOutcome, { attempts: 1, error: message });
    }
  }

  // Called after markMergedAndPruneExcess resolves, when resetting and pushing are safe.
  async handleSelfMerge(sessionId: string): Promise<void> {
    const session = this.deps.sessionManager.get(sessionId);
    const watch = session?.mergeWatch;
    if (!session || watch?.kind !== "self") return;
    if (isTerminalWatchState(watch.state)) return;

    if (session.archived || session.userArchived) {
      this.clearWatch(sessionId);
      return;
    }

    const info = this.infoFromPersistedStatus(sessionId);
    if (info?.outcome !== "merged") return;

    if (watch.prNumber !== undefined && info.prNumber !== watch.prNumber) {
      this.appendNote(
        sessionId,
        `PR #${info.prNumber} merged, but this session was waiting on PR #${watch.prNumber}. `
        + "The watch was armed for different work, so nothing was resumed automatically — "
        + "send a message to continue.",
        "warn",
      );
      this.clearWatch(sessionId);
      return;
    }

    if (watch.state === "armed") {
      this.deps.sessionManager.setMergeWatch(sessionId, {
        ...watch,
        state: "merge-observed",
        observedAt: new Date().toISOString(),
      });
    }
    await this.attemptDelivery(session, session, info);
  }

  private handleSelfPrClosed(info: PrTerminalStateInfo, watch: SessionMergeWatch): void {
    const sessionId = info.sessionId;
    if (watch.prNumber !== undefined && info.prNumber !== watch.prNumber) {
      return;
    }
    this.appendNote(
      sessionId,
      `PR #${info.prNumber} was closed without merging, so this session was not resumed. `
      + "The merge-watch has been cleared — send a message to decide what to do next.",
      "warn",
    );
    this.clearWatch(sessionId);
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

  forgetWatch(sessionId: string): void {
    this.clearWatch(sessionId);
  }

  private async attemptDelivery(
    parent: SessionInfo,
    child: SessionInfo,
    info: PrTerminalStateInfo,
  ): Promise<void> {
    const childId = child.id;
    const watch = this.deps.sessionManager.getMergeWatch(childId);
    if (watch?.state !== "merge-observed") return;
    // All callers use this guard, including reconciliation after turn adoption.
    if (this.isDeliveryInFlight(childId, watch)) return;

    const attempts = (watch.deliveryAttempts ?? 0) + 1;
    const observedAt = watch.observedAt ?? new Date().toISOString();
    // Persist identity before dispatch so restart adoption can bind the surviving turn.
    const deliveryId = `${watch.watchId ?? childId}:${attempts}`;
    this.deps.sessionManager.setMergeWatch(childId, {
      ...watch,
      deliveryAttempts: attempts,
      lastAttemptAt: new Date().toISOString(),
      deliveryId,
    });
    this.lastTerminalInfo.set(childId, info);
    this.dispatching.add(childId);
    this.ensureRetryLoop();

    try {
      await this.deliverWakeTurn(
        parent, child, info, "merged",
        this.buildDeliverySettlement(childId, watch.watchId, attempts, observedAt),
        deliveryId,
      );
    } catch (err) {
      const message = errorMessage(err);
      console.error(
        `[merge-watch] wake-turn delivery failed for ${childId} `
        + `(attempt ${attempts}/${MAX_DELIVERY_ATTEMPTS}):`,
        err,
      );
      if (!this.isCurrentWatch(childId, watch.watchId)) return;
      const current = this.deps.sessionManager.getMergeWatch(childId);
      if (current?.state !== "merge-observed") return;
      this.deps.sessionManager.setMergeWatch(childId, { ...current, lastDeliveryError: message });
      if (attempts >= MAX_DELIVERY_ATTEMPTS) this.failWatch(childId, message);
    } finally {
      this.dispatching.delete(childId);
    }
  }

  // A wake turn may re-arm before settling; its old callback must not change the new watch.
  private isCurrentWatch(childSessionId: string, expectedWatchId: string | undefined): boolean {
    if (expectedWatchId === undefined) return true;
    return this.deps.sessionManager.getMergeWatch(childSessionId)?.watchId === expectedWatchId;
  }

  private buildDeliverySettlement(
    childSessionId: string,
    expectedWatchId: string | undefined,
    attempts: number,
    observedAt: string,
  ): (outcome: TurnOutcome) => void {
    return (outcome: TurnOutcome) => {
      if (!this.isCurrentWatch(childSessionId, expectedWatchId)) return;
      if (outcome.status === "completed") {
        this.markDelivered(childSessionId, observedAt);
        return;
      }
      // An interrupted turn reached the agent; retrying would duplicate a delivered notification.
      if (outcome.status === "interrupted") {
        console.warn(
          `[merge-watch] wake-turn for ${childSessionId} reached the agent and was then cut short `
          + `(${outcome.detail ?? "interrupted"}) — treating the wake as delivered, not re-delivering`,
        );
        this.markDelivered(childSessionId, observedAt);
        return;
      }
      this.recordDeliveryOutcomeFailure(
        childSessionId,
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
        this.failWatch(childSessionId, watch.lastDeliveryError ?? "wake-turn never ran");
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
    if (this.dispatching.has(childSessionId)) return true;
    if (!watch.deliveryId) return false;
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
    const parent = this.deps.sessionManager.get(watch.parentSessionId);
    if (!parent || parent.archived || parent.userArchived) {
      this.clearWatch(childSessionId);
      return;
    }
    const info = this.lastTerminalInfo.get(childSessionId)
      ?? this.infoFromPersistedStatus(childSessionId);
    if (info?.outcome !== "merged") return;
    await this.attemptDelivery(parent, child, info);
  }

  private failWatch(childSessionId: string, error: string): void {
    const watch = this.deps.sessionManager.getMergeWatch(childSessionId);
    if (watch?.state !== "merge-observed") return;
    this.deps.sessionManager.setMergeWatch(childSessionId, {
      ...watch,
      state: "delivery-failed",
      failedAt: new Date().toISOString(),
      lastDeliveryError: error,
    });
    const info = this.lastTerminalInfo.get(childSessionId)
      ?? this.infoFromPersistedStatus(childSessionId);
    this.lastTerminalInfo.delete(childSessionId);

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
      `[merge-watch] giving up on the wake-turn for ${childSessionId} after `
      + `${watch.deliveryAttempts ?? MAX_DELIVERY_ATTEMPTS} attempts: ${error}`,
    );
    this.stopRetryLoopIfIdle();
  }

  private clearWatch(childSessionId: string): void {
    this.deps.sessionManager.setMergeWatch(childSessionId, null);
    this.dispatching.delete(childSessionId);
    this.lastTerminalInfo.delete(childSessionId);
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
        const info = this.infoFromPersistedStatus(childSessionId);
        if (!info) continue;
        await this.handleChildPrTerminal(info);
      } catch (err) {
        console.error(`[merge-watch] reconcile delivery failed for ${childSessionId}:`, err);
      }
    }
  }

  private recordDeliveryOutcomeFailure(childSessionId: string, attempts: number, reason: string): void {
    console.error(
      `[merge-watch] wake-turn for ${childSessionId} did not complete `
      + `(attempt ${attempts}/${MAX_DELIVERY_ATTEMPTS}): ${reason}`,
    );
    const current = this.deps.sessionManager.getMergeWatch(childSessionId);
    if (current?.state !== "merge-observed") return;
    this.deps.sessionManager.setMergeWatch(childSessionId, { ...current, lastDeliveryError: reason });
    if (attempts >= MAX_DELIVERY_ATTEMPTS) this.failWatch(childSessionId, reason);
    else this.ensureRetryLoop();
  }

  private markDelivered(childSessionId: string, fallbackObservedAt: string): void {
    const watch = this.deps.sessionManager.getMergeWatch(childSessionId);
    this.lastTerminalInfo.delete(childSessionId);
    if (!watch || isTerminalWatchState(watch.state)) return;
    this.deps.sessionManager.setMergeWatch(childSessionId, {
      parentSessionId: watch.parentSessionId,
      state: "delivered",
      registeredAt: watch.registeredAt,
      observedAt: watch.observedAt ?? fallbackObservedAt,
      deliveredAt: new Date().toISOString(),
      ...(watch.deliveryAttempts !== undefined ? { deliveryAttempts: watch.deliveryAttempts } : {}),
      ...(watch.lastAttemptAt !== undefined ? { lastAttemptAt: watch.lastAttemptAt } : {}),
    });
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
    await wakeSessionWithTurn(this.deps, parent, {
      text,
      activity,
      ...(onSettled ? { onSettled } : {}),
      ...(deliveryId !== undefined ? { deliveryId } : {}),
    });
  }
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
