/**
 * Notify-on-merge watches (docs/196).
 *
 * The async counterpart to `shipit session wait`: instead of blocking a parent
 * agent's turn on a human merge (which can take days), a parent **arms** a watch
 * with `shipit session notify-on-merge <child-id>` and ends its turn. When the
 * child's PR later reaches a terminal state, the PR poller fires
 * `handleChildPrTerminal`, which:
 *
 *   1. surfaces a persisted "Child PR merged / closed" card into the parent's
 *      transcript immediately (decoupled from the actionable turn, so the human
 *      sees it even while another turn is mid-flight), and
 *   2. enqueues a self-describing **system turn** into the parent's message
 *      queue — never preempting a running turn; it drains by post-turn
 *      processing if the parent is busy, or starts immediately if idle.
 *
 * The watch is persisted on the CHILD session row (`SessionMergeWatch`) with a
 * fire-once state machine (`armed → merge-observed → delivered`, or terminal
 * `closed-unmerged` / `delivery-failed`). Persistence is what makes the firing
 * survive an orchestrator restart: `reconcilePending` re-derives "child PR
 * terminal + watch un-delivered → fire" from the persisted PR snapshot on
 * startup, so a crash between merge-detection and delivery doesn't strand the
 * parent.
 *
 * ## Retrying a failed delivery (SHI-258)
 *
 * `deliverWakeTurn` can throw — the parent's container won't resume, its
 * credential refresh fails, the worker is unreachable. The design always claimed
 * such a watch was retried, but the only retry that existed was
 * `reconcilePending`, whose sole call site is bootstrap: the PR poller's terminal
 * callbacks fire behind an `alreadyTerminal` guard, so once the terminal PR
 * snapshot is persisted no later poll re-enters delivery. A failed delivery
 * therefore sat at `merge-observed` until an orchestrator restart — the merge
 * card visible in the parent's transcript, the agent never starting — while the
 * polling gate kept the loop alive precisely *because* the watch was pending.
 *
 * The fix is a self-managing retry loop in this manager
 * (`retryStalledDeliveries`, driven by an interval that exists only while some
 * watch sits at `merge-observed`). Its whole difficulty is that `merge-observed`
 * is ALSO the legitimate state of a wake-turn that is **enqueued behind a busy
 * parent** — re-firing those would resurrect the duplicate-wake bug docs/196
 * already fought twice. So the retry distinguishes in-flight from failed on two
 * independent axes:
 *
 *   1. **In-memory `inFlight` set** — the precise signal. A dispatch that
 *      returned without throwing is genuinely pending *in this process*: its
 *      completion callback rides the runner's in-memory queue and will fire when
 *      the turn runs, however long the parent stays busy. That fact cannot be
 *      persisted (the queue itself is in-memory), which is exactly why the
 *      restart case needs `reconcilePending` and the same-process case needs
 *      this set. A watch in `inFlight` is never re-fired — unless the parent's
 *      runner has since disappeared, which means the queued turn went with it.
 *   2. **Persisted `deliveryAttempts` + `lastAttemptAt` backoff** — the safety
 *      net. Even an eligible watch is only re-attempted once an exponential
 *      backoff window has elapsed, so a failing container boot is retried on a
 *      sane cadence rather than every tick.
 *
 * The attempt budget is capped: after `MAX_DELIVERY_ATTEMPTS` the watch moves to
 * the terminal `delivery-failed` state and surfaces a persisted failure card
 * into the parent, so a permanently-undeliverable wake is visible to the human
 * instead of retried forever (and stops holding the polling gate open).
 *
 * ## The self variant (docs/239)
 *
 * `shipit session notify-on-merge --self` is this same machine pointed back at
 * the same session: the same row with `kind: "self"` and `parentSessionId ===`
 * its own id, so the state machine, the retry supervisor above, the polling gate
 * and `reconcilePending` are inherited rather than reimplemented. Everything
 * that differs lives on a `kind` branch:
 *
 *   - it fires from the poller's `onMergeDetectedCb` (`handleSelfMerge`), AFTER
 *     `markMergedAndPruneExcess` — `onPrTerminalState` runs before
 *     `setMergedHeadSha` and before the remote head branch is deleted, so a wake
 *     from there races its own preconditions;
 *   - the merged PR is compared to the watch's anchor (`prNumber`), because a
 *     docs/202 re-arm can replace the work before the merge lands;
 *   - arming always REPLACES (the wake turn re-arms for the next PR mid-turn, so
 *     an idempotent arm would make chaining impossible), which is why every
 *     asynchronous settlement checks an expected `watchId`;
 *   - terminal outcomes append plain notes instead of a card — the self flow
 *     surfaces exactly one card, at arm time.
 *
 * One row means one watch, so a session cannot be parent-watched and
 * self-watching at once; the arm service refuses that collision explicitly.
 *
 * The card-surfacing + wake-turn delivery mirror `issue-lifecycle.ts`: both fire
 * **outside any turn**, so the card is appended directly to chat history
 * (durable, rehydrates on reload) and broadcast live only when a runner is still
 * attached. The wake-turn delivery mirrors `sendChildMessage`'s container-resume
 * dance so an idle/idle-reaped parent is woken, not silently dropped.
 */

import { randomUUID } from "node:crypto";
import type { ChatHistoryManager } from "./chat-history.js";
import type { ChildMergedCard, SessionInfo, SessionMergeWatch, WsServerMessage } from "../shared/types.js";
import type { PrStatusSummary } from "../shared/types/github-types.js";
import { wakeSessionWithTurn, type WakeSessionDeps } from "./wake-session.js";
import type { PrTerminalStateInfo } from "./pr-status-poller.js";
import type { TurnOutcome } from "./turn-settlement.js";
import { emitNoticePostTurn } from "./chat-card-persistence.js";
import { loadPrompt, fillPromptTokens } from "./load-prompt.js";

/**
 * docs/239 — the self-merge wake prompt template, read ONCE at module load (a
 * missing file then fails at boot, not mid-delivery). See CLAUDE.md › Prompts.
 */
const SELF_MERGE_WAKE_PROMPT = loadPrompt(import.meta.url, "./prompts/self-merge-wake.md");

/**
 * SHI-258 — how many times a merge wake-turn delivery is attempted before the
 * watch gives up and moves to the terminal `delivery-failed` state. Counts every
 * `deliverWakeTurn` invocation, not only the failing ones, so a watch can never
 * loop indefinitely however the attempts are spread across restarts.
 */
export const MAX_DELIVERY_ATTEMPTS = 5;

/**
 * How often the retry supervisor wakes while at least one watch sits at
 * `merge-observed`. The tick is cheap (one indexed read of the rare merge-watch
 * rows) and the timer exists only while such a watch exists — the steady state
 * is no timer at all.
 */
const RETRY_TICK_MS = 30_000;
/** First retry lands this long after the failed attempt. */
const RETRY_BASE_BACKOFF_MS = 60_000;
/** Backoff ceiling — a persistently-failing parent is probed at most this often. */
const RETRY_MAX_BACKOFF_MS = 10 * 60_000;

/**
 * Exponential backoff between delivery attempts: 1m, 2m, 4m, 8m, capped at
 * {@link RETRY_MAX_BACKOFF_MS}. Deliberately generous — each attempt may boot a
 * container and refresh credentials, and the failure modes it recovers from
 * (host restart, Docker hiccup, token rotation) resolve on a minutes scale, not
 * a seconds one.
 */
function retryBackoffMs(attempts: number): number {
  return Math.min(RETRY_BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_BACKOFF_MS);
}

/**
 * Collaborators the deliverer needs — all orchestrator-side. The wake-turn half
 * is `WakeSessionDeps` (shared with the docs/233 report delivery); this adds the
 * chat history the merge card is appended to.
 */
export interface MergeWatchDeps extends WakeSessionDeps {
  chatHistoryManager: ChatHistoryManager;
}

export class MergeWatchManager {
  /**
   * Late-bound lookup of a session's last-known PR snapshot (the poller's
   * `getStatus`). Bound after construction because the poller is built *after*
   * this manager (the poller's `onPrTerminalState` references it). Used by the
   * startup reconcile and the register-time "already resolved?" check.
   */
  private prStatusLookup?: (sessionId: string) => PrStatusSummary | undefined;

  /**
   * SHI-258 — child session ids whose wake-turn dispatch succeeded **in this
   * process** and whose turn has not yet run. This is the one signal that tells
   * "queued behind a busy parent" (never re-fire) apart from "delivery threw"
   * (retry), and it is deliberately in-memory: the thing it tracks — the
   * runner's queued turn plus its completion callback — is in-memory too, so a
   * restart correctly empties it and hands recovery back to
   * `reconcilePending`.
   */
  private readonly inFlight = new Set<string>();

  /**
   * SHI-258 — the terminal PR facts a watch was fired with, kept so a retry can
   * rebuild the identical self-describing prompt. The persisted PR snapshot
   * (`prStatusLookup`) is the restart-safe fallback, but it carries no merge
   * SHA, so preferring the observed info keeps a same-process retry's prompt
   * byte-identical to the first attempt's.
   */
  private readonly lastTerminalInfo = new Map<string, PrTerminalStateInfo>();

  /**
   * The retry supervisor's interval. Armed on the first delivery attempt and
   * cleared as soon as no watch sits at `merge-observed`, so an instance with
   * nothing to retry holds no timer. Unref'd — it must never keep the process
   * alive on its own.
   */
  private retryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: MergeWatchDeps) {}

  /** Bind the PR-status lookup (the poller's `getStatus`). Called once at wiring. */
  setPrStatusLookup(fn: (sessionId: string) => PrStatusSummary | undefined): void {
    this.prStatusLookup = fn;
  }

  /** Stop the retry supervisor. Called from the orchestrator's shutdown hook. */
  stopRetryLoop(): void {
    if (!this.retryTimer) return;
    clearInterval(this.retryTimer);
    this.retryTimer = null;
  }

  /**
   * Register-time backstop for the rare race where a watch is armed AFTER the
   * child's PR already reached a terminal state — the poller won't re-observe a
   * session it has already promoted, so without this the watch would never fire.
   * Checks the child's last-known PR snapshot and fires immediately if terminal.
   * No-op (and harmless) for the common case where the PR is still open / absent.
   */
  async checkAndFireNow(childSessionId: string): Promise<void> {
    const info = this.infoFromPersistedStatus(childSessionId);
    if (!info) return;
    await this.handleChildPrTerminal(info);
  }

  /**
   * Re-derive `PrTerminalStateInfo` from the child's last-known (persisted) PR
   * snapshot. Returns undefined while the PR is absent or still open. Shared by
   * the register-time check, the startup reconcile, and the retry supervisor —
   * all three need the same "what did this child's PR resolve to?" question
   * answered from durable state rather than a live poll event.
   */
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

  /**
   * PR-poller hook: a tracked session's PR reached a terminal state. No-ops
   * unless THIS session carries an armed merge-watch. Idempotent — a watch that
   * is already `delivered` / `closed-unmerged` / `delivery-failed` is skipped
   * (fire-once), so a re-poll or a restart re-observation never double-fires.
   */
  async handleChildPrTerminal(info: PrTerminalStateInfo): Promise<void> {
    const child = this.deps.sessionManager.get(info.sessionId);
    const watch = child?.mergeWatch;
    if (!child || !watch) return;
    // Fire-once: terminal states are never re-delivered.
    if (isTerminalWatchState(watch.state)) return;

    // docs/239 — a SELF watch takes a different route for the merged case. The
    // hook fires from `onPrTerminalState`, which in `verifyMissingPr` runs
    // BEFORE `setMergedHeadSha` and before `markMergedAndPruneExcess` (which
    // deletes the remote head branch). Waking there would hand the agent a
    // branch whose reset anchor isn't recorded yet and whose remote is about to
    // vanish, so the merged case is driven from `onMergeDetectedCb` instead —
    // see `handleSelfMerge`. Only the CLOSE case belongs here: the merge
    // callback never fires for it.
    if (watch.kind === "self") {
      if (info.outcome === "merged") return;
      this.handleSelfPrClosed(info, watch);
      return;
    }

    const parent = this.deps.sessionManager.get(watch.parentSessionId);
    // Parent archived/gone before the merge → drop the watch silently (docs/196
    // edge case). userArchived implies archived via `fromRow`, but check both.
    if (!parent || parent.archived || parent.userArchived) {
      this.clearWatch(info.sessionId);
      return;
    }

    const now = new Date().toISOString();
    const cardOutcome = info.outcome === "merged" ? "merged" : "closed-unmerged";

    if (info.outcome === "merged") {
      // armed → merge-observed (surface the card exactly once, on the first
      // observation). A reconcile re-entry at `merge-observed` (delivery was
      // interrupted) skips the card and just retries the wake-turn below.
      if (watch.state === "armed") {
        this.deps.sessionManager.setMergeWatch(info.sessionId, {
          ...watch,
          state: "merge-observed",
          observedAt: now,
        });
        this.surfaceCard(parent.id, child, info, cardOutcome);
      }
      // Deliver the wake-turn, advancing to `delivered` ONLY once the turn has
      // actually RUN TO A CLEAN COMPLETION — surfaced via the settlement-backed
      // `markDelivered` callback, NOT the instant the turn is enqueued, and NOT
      // (docs/240) for a turn that reached a terminal state by crashing, exiting
      // without a result, or being dropped from the queue. The
      // callback now rides the in-memory queue (docs/196 fix), so it fires when
      // the turn genuinely runs on BOTH paths:
      //   • idle parent → the turn starts now → it completes → `delivered`.
      //   • busy parent → the turn is enqueued (drained post-turn, never
      //     preempting) → it runs when the current turn finishes → `delivered`.
      // The watch stays at `merge-observed` only for the window between enqueue
      // and the turn actually running. A restart inside that window drops the
      // in-memory queued turn, leaving the watch at `merge-observed` for
      // `reconcilePending` to re-fire on the next startup — the genuine
      // recovery case. This closes two failure modes: (1) stamping `delivered`
      // at enqueue stranded the parent when a restart lost the queued turn
      // before it ran; (2) leaving the busy path's callback unwired left the
      // watch at `merge-observed` FOREVER, so reconcile re-fired a DUPLICATE
      // wake-turn on every restart. A `deliverWakeTurn` that THROWS (parent
      // container boot failure, credential refresh failure, unreachable worker)
      // also leaves the watch at `merge-observed` — `attemptDelivery` records
      // the attempt and hands it to the retry supervisor, which re-attempts it
      // in-process on a backoff (SHI-258); before that fix only a restart could
      // recover it.
      await this.attemptDelivery(parent, child, info);
      return;
    }

    // Closed-without-merge — terminal in one step. Surface the (distinct) card
    // and mark the watch terminal before delivering so a re-poll can't re-fire.
    // The wake-turn is best-effort and deliberately NOT retried: the watch is
    // already terminal, which is what makes the close path fire-once. A failure
    // is surfaced as a delivery-failure card instead of vanishing into a log, so
    // the human still learns the session wasn't woken (SHI-258).
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

  /**
   * docs/239 — the SELF-merge entry point, fired from the poller's
   * `onMergeDetectedCb` **after `markMergedAndPruneExcess` has resolved**.
   *
   * That position is the whole point. The earlier hook (`onPrTerminalState`)
   * runs before `setMergedHeadSha` and before the merged session's remote head
   * branch is deleted, so a wake dispatched from there races its own
   * preconditions: the agent could reset and push a branch that is about to be
   * removed, and the reset's safety anchor might not be recorded yet. By the
   * time this runs, both `setPrStatus` and `setMergedHeadSha` have already been
   * written — which is why the PR facts are read back from the persisted
   * snapshot here rather than widening the sessionId-only callback signature.
   *
   * Three outcomes:
   *   - **anchor mismatch** — the merged PR is not the one this watch was armed
   *     for, i.e. a docs/202 re-arm replaced the work before the merge landed.
   *     Append a note, clear the watch, wake nothing. (This one comparison
   *     replaces both a `superseded` watch state and an eager hook in
   *     `pr-rearm.ts`.)
   *   - **archived** — the user deliberately froze this transcript; clear the
   *     watch silently, exactly as the parent→child path does.
   *   - **match** — advance to `merge-observed` and deliver, inheriting the
   *     retry supervisor, the attempt budget and the restart reconcile whole.
   *
   * No card here: the wake turn itself is the visible signal.
   */
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
    // Not (yet) visible as merged in the persisted snapshot — nothing to act on.
    // The startup reconcile and the retry supervisor both re-ask this question.
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
    // parent === child === this session: the watch points back at its own row,
    // which is what lets every downstream piece stay unchanged.
    await this.attemptDelivery(session, session, info);
  }

  /**
   * docs/239 — a self-watched PR closed WITHOUT merging. Terminal in one step
   * and deliberately quiet: a note, the watch cleared, no turn. There is nothing
   * to reset to (the commits were rejected, not shipped), so a follow-up turn
   * would stack work on a branch the user just abandoned.
   */
  private handleSelfPrClosed(info: PrTerminalStateInfo, watch: SessionMergeWatch): void {
    const sessionId = info.sessionId;
    if (watch.prNumber !== undefined && info.prNumber !== watch.prNumber) {
      // A different PR closed; the watch's own PR is still open.
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

  /**
   * docs/239 — a plain persisted note for a self-watch's terminal outcomes
   * (closed-without-merge, anchor mismatch, delivery failure). Deliberately a
   * note and not a card family: nothing here has a lifecycle to render.
   *
   * Fires outside any turn, so the live emit is best-effort (no runner attached
   * ⇒ nobody to broadcast to) while the `append` is what makes it survive.
   */
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

  /**
   * Drop a watch and every trace of it, including the in-memory retry state.
   * Public counterpart of {@link clearWatch} for the arm/cancel service
   * (docs/239): cancelling from the card, and re-arming (which replaces the row),
   * must not leave a stale in-flight marker keyed by this session id — it would
   * suppress the NEW watch's first retry.
   */
  forgetWatch(sessionId: string): void {
    this.clearWatch(sessionId);
  }

  /**
   * One wake-turn delivery attempt for a `merge-observed` watch, with the
   * bookkeeping the retry supervisor reads.
   *
   * Order matters: the attempt is *recorded before it runs*, so a delivery that
   * throws — or a process that dies mid-attempt — still leaves a durable
   * `deliveryAttempts` / `lastAttemptAt` trail. The in-memory `inFlight` marker
   * is set for the same reason in reverse: it exists only while this process
   * holds a dispatch that hasn't run, and it is cleared the instant the dispatch
   * throws, so `retryStalledDeliveries` sees "failed" rather than "pending".
   *
   * A throw is handled, not propagated: the failure is recorded, the retry loop
   * is armed, and the caller (the PR poller's fire-and-forget hook, the register
   * route, the startup reconcile) sees an ordinary return. Reaching the attempt
   * cap here fails the watch immediately rather than waiting a full backoff for
   * the supervisor to notice.
   */
  private async attemptDelivery(
    parent: SessionInfo,
    child: SessionInfo,
    info: PrTerminalStateInfo,
  ): Promise<void> {
    const childId = child.id;
    const watch = this.deps.sessionManager.getMergeWatch(childId);
    if (watch?.state !== "merge-observed") return;

    const attempts = (watch.deliveryAttempts ?? 0) + 1;
    const observedAt = watch.observedAt ?? new Date().toISOString();
    this.deps.sessionManager.setMergeWatch(childId, {
      ...watch,
      deliveryAttempts: attempts,
      lastAttemptAt: new Date().toISOString(),
    });
    this.lastTerminalInfo.set(childId, info);
    this.inFlight.add(childId);
    this.ensureRetryLoop();

    // docs/239 — the identity this attempt belongs to. A self-watch is re-armed
    // by the wake turn ITSELF, i.e. before that turn settles, so without this
    // check the OLD turn's settlement would mark the NEW watch delivered (or
    // record a failed attempt against it). Deliberately one expected-identity
    // check on settlement rather than a full compare-and-set. Undefined for a
    // docs/196 parent→child watch, where re-arming is a human act between
    // deliveries and the check is a no-op.
    const expectedWatchId = watch.watchId;
    const isCurrentWatch = (): boolean => {
      if (expectedWatchId === undefined) return true;
      return this.deps.sessionManager.getMergeWatch(childId)?.watchId === expectedWatchId;
    };

    try {
      await this.deliverWakeTurn(parent, child, info, "merged", (outcome) => {
        if (!isCurrentWatch()) return;
        // docs/240 — `delivered` means the turn RAN CLEANLY, not merely that it
        // reached a terminal state. The pre-docs/240 callback discarded the
        // outcome, so a wake-turn that crashed, exited without ever producing a
        // result (SHI-260), or was dropped when the parent's queue was cleared
        // still stamped `delivered` — a watch that looked healthy and was not.
        // Anything but `completed` releases the in-flight marker so SHI-258's
        // supervisor re-attempts it on a backoff (or fails it once the budget
        // is spent).
        if (outcome.status === "completed") {
          this.markDelivered(childId, observedAt);
          return;
        }
        this.recordDeliveryOutcomeFailure(
          childId,
          attempts,
          outcome.detail ?? `wake-turn ended as "${outcome.status}"`,
        );
      });
    } catch (err) {
      // The dispatch never landed, so nothing is queued in the parent — drop the
      // in-flight marker so the supervisor treats this watch as retryable.
      this.inFlight.delete(childId);
      const message = errorMessage(err);
      console.error(
        `[merge-watch] wake-turn delivery failed for ${childId} `
        + `(attempt ${attempts}/${MAX_DELIVERY_ATTEMPTS}):`,
        err,
      );
      if (!isCurrentWatch()) return;
      const current = this.deps.sessionManager.getMergeWatch(childId);
      if (current?.state !== "merge-observed") return;
      this.deps.sessionManager.setMergeWatch(childId, { ...current, lastDeliveryError: message });
      if (attempts >= MAX_DELIVERY_ATTEMPTS) this.failWatch(childId, message);
    }
  }

  /**
   * The retry supervisor's pass: re-attempt every `merge-observed` watch whose
   * delivery is genuinely stalled, and give up on the ones that have exhausted
   * their attempt budget.
   *
   * Every `continue` below is a duplicate-wake guard, in increasing order of
   * cost:
   *   1. **In-flight** — a dispatch from this process is still pending in the
   *      parent's queue (or running). Never re-fired, however long the parent
   *      stays busy. This is the guard that makes "retry on a timer" safe at
   *      all; a naive per-poll reconcile without it spams duplicate turns at
   *      exactly the busiest parents.
   *   2. **Backoff** — the last attempt is too recent. Spaces out retries
   *      against a parent whose container keeps failing to boot.
   *   3. **Budget** — the attempt cap is spent, so the watch fails terminally
   *      (surfacing a card) instead of being retried forever.
   *
   * Public so tests — and any future caller that wants an immediate pass — can
   * drive it without waiting on the interval.
   */
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
      if (this.isDeliveryInFlight(childSessionId, watch.parentSessionId)) continue;

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

  /**
   * True while a dispatch issued by THIS process is still pending for the watch.
   *
   * The marker alone isn't enough: if the parent's runner has since been
   * disposed (idle reap, container death, an explicit teardown), the queued turn
   * and its completion callback went with it, so the delivery is lost rather
   * than pending. Detecting that here is what lets a wake-turn stranded by a
   * vanished runner be re-delivered without waiting for a restart.
   */
  private isDeliveryInFlight(childSessionId: string, parentSessionId: string): boolean {
    if (!this.inFlight.has(childSessionId)) return false;
    const runner = this.deps.runnerRegistry.get(parentSessionId);
    if (runner && !runner.disposed) return true;
    this.inFlight.delete(childSessionId);
    return false;
  }

  /**
   * Re-attempt one stalled watch. Rebuilds the terminal PR facts from the
   * observation that fired it (preferred — it carries the merge SHA) or from the
   * persisted PR snapshot. With neither there is nothing to build a
   * self-describing prompt from, so the pass leaves the watch alone rather than
   * dispatching a turn that can't say what merged.
   */
  private async retryDelivery(childSessionId: string, watch: SessionMergeWatch): Promise<void> {
    const child = this.deps.sessionManager.get(childSessionId);
    if (!child) return;
    const parent = this.deps.sessionManager.get(watch.parentSessionId);
    if (!parent || parent.archived || parent.userArchived) {
      // Same invariant as the fire path: an archived parent receives nothing.
      this.clearWatch(childSessionId);
      return;
    }
    const info = this.lastTerminalInfo.get(childSessionId)
      ?? this.infoFromPersistedStatus(childSessionId);
    if (info?.outcome !== "merged") return;
    await this.attemptDelivery(parent, child, info);
  }

  /**
   * Give up on a watch whose delivery exhausted its attempt budget: stamp the
   * terminal `delivery-failed` state and surface a persisted failure card into
   * the parent's transcript.
   *
   * Terminal matters twice over — it stops the retry loop, and it drops the
   * watch out of `listPendingMergeWatches`, which is what the polling global
   * gate reads. Without that, a permanently-failed watch would hold the PR poll
   * loop open forever burning polls on a wake that will never happen.
   */
  private failWatch(childSessionId: string, error: string): void {
    const watch = this.deps.sessionManager.getMergeWatch(childSessionId);
    if (watch?.state !== "merge-observed") return;
    this.deps.sessionManager.setMergeWatch(childSessionId, {
      ...watch,
      state: "delivery-failed",
      failedAt: new Date().toISOString(),
      lastDeliveryError: error,
    });
    this.inFlight.delete(childSessionId);
    const info = this.lastTerminalInfo.get(childSessionId)
      ?? this.infoFromPersistedStatus(childSessionId);
    this.lastTerminalInfo.delete(childSessionId);

    const child = this.deps.sessionManager.get(childSessionId);
    const parent = this.deps.sessionManager.get(watch.parentSessionId);
    const attempts = watch.deliveryAttempts ?? MAX_DELIVERY_ATTEMPTS;
    if (watch.kind === "self") {
      // docs/239 — a note, not a card. The self flow surfaces exactly one card
      // (the arm); its terminal outcomes are plain persisted notes.
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

  /** Drop a watch entirely (parent archived / gone) and forget its retry state. */
  private clearWatch(childSessionId: string): void {
    this.deps.sessionManager.setMergeWatch(childSessionId, null);
    this.inFlight.delete(childSessionId);
    this.lastTerminalInfo.delete(childSessionId);
    this.stopRetryLoopIfIdle();
  }

  /** Arm the retry supervisor if it isn't already running. */
  private ensureRetryLoop(): void {
    if (this.retryTimer) return;
    this.retryTimer = setInterval(() => {
      void this.retryStalledDeliveries().catch((err: unknown) => {
        console.error("[merge-watch] retry pass errored:", err);
      });
    }, RETRY_TICK_MS);
    this.retryTimer.unref?.();
  }

  /** Stop the supervisor once no watch is in the retryable `merge-observed` state. */
  private stopRetryLoopIfIdle(): void {
    if (!this.retryTimer) return;
    const anyPending = this.deps.sessionManager
      .listPendingMergeWatches()
      .some(({ watch }) => watch.state === "merge-observed");
    if (!anyPending) this.stopRetryLoop();
  }

  /**
   * Startup re-derivation. For every persisted watch still in a non-terminal
   * state, ask `getStatus` for the child's last-known PR snapshot; if it's
   * already terminal, fire as if the poller had just observed it. This is what
   * makes delivery survive a crash between merge-detection and delivery — the
   * poller is in-process and may have archived the merged child, so we re-derive
   * from durable state rather than relying on the live poll re-observing it.
   *
   * Best-effort: one watch failing doesn't block the rest.
   *
   * Clears the in-memory in-flight set first. This runs at bootstrap, where by
   * definition no dispatch from this process can be pending — and the whole
   * point of the reconcile is that the *previous* process's queued turns died
   * with it. (Tests that simulate a restart by re-running the reconcile on the
   * same instance get the same semantics for free.)
   */
  async reconcilePending(): Promise<void> {
    if (!this.prStatusLookup) return;
    this.inFlight.clear();
    const pending = this.deps.sessionManager.listPendingMergeWatches();
    for (const { childSessionId, watch } of pending) {
      try {
        // docs/239 — a self-watch re-derives from the same persisted snapshot,
        // just through its own entry point: `handleChildPrTerminal` deliberately
        // ignores the merged case for a self-watch (it belongs after the merge
        // bookkeeping), so routing a reconcile through it would silently
        // resurrect nothing.
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

  /**
   * Advance a merge-watch from `merge-observed` to the terminal `delivered`
   * state. Fired from the wake-turn's SETTLEMENT and only for a `completed`
   * outcome (docs/240), so it runs only after the turn has genuinely executed
   * and finished cleanly — that is the whole point of the fix (`delivered` must
   * mean "ran", not "queued", and not "ended somehow"). Idempotent and
   * fire-once: a
   * watch that is already terminal (`delivered` / `closed-unmerged` /
   * `delivery-failed`) or has since been cleared (parent archived) is left
   * untouched, so a re-delivery or a late callback can never double-stamp or
   * resurrect a dropped watch.
   *
   * Also the retry supervisor's exit: the watch is terminal, so the in-flight
   * marker is dropped and the supervisor stops once nothing else is pending.
   */
  /**
   * docs/240 — the wake-turn reached a terminal outcome that is NOT a clean
   * completion. The turn is over, so nothing is in flight any more; record why
   * and let the retry supervisor re-attempt on a backoff, or fail the watch
   * terminally (surfacing a card) once the attempt budget is spent.
   *
   * Mirrors the `catch` in `attemptDelivery` — the difference is only *when* the
   * failure became visible: that one is "the dispatch never landed", this one is
   * "the dispatch landed and the turn then failed".
   */
  private recordDeliveryOutcomeFailure(childSessionId: string, attempts: number, reason: string): void {
    this.inFlight.delete(childSessionId);
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
    this.inFlight.delete(childSessionId);
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

  /**
   * Append the persisted merge card to the parent's chat history and broadcast
   * it live to any attached viewer. Fires outside any turn, so it's an `append`
   * (durable, sorts at the current end of history) rather than `emitChatCard`.
   *
   * With `deliveryFailure` set this surfaces the SHI-258 failure variant instead
   * — a *second* card, appended when the watch gives up, telling the human the
   * merge they were already shown could not wake this session. It goes through
   * the same persisted-append path for the same reason: a card the user expects
   * to still be there tomorrow must live in chat history, not only on the wire.
   */
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

  /**
   * Enqueue the self-describing wake-turn into the parent's message queue. The
   * prompt carries every fact (child id, branch, PR ref, merge SHA, intent) so
   * it stands alone even if it runs many turns — or a restart — later. Mirrors
   * `sendChildMessage`'s resume dance so an idle / idle-reaped parent is woken.
   *
   * `runner.dispatch` is the only mutation: when the parent is mid-turn it
   * enqueues (drained post-turn); when idle it starts the turn. It NEVER
   * preempts a running turn — exactly the "poller events must not kill running
   * agents" invariant.
   *
   * `onSettled` (when supplied) fires once the turn reaches a TERMINAL OUTCOME —
   * wired through the dispatch settlement, which `dispatch` honors on the idle
   * path (it starts the turn now) AND, since the docs/196 fix, on the busy path:
   * the signal rides the in-memory queue and fires when the enqueued turn later
   * drains and runs. docs/240 passes the OUTCOME through rather than flattening
   * it, so the caller can distinguish a clean `completed` (⇒ `delivered`) from
   * `errored` / `no-result` / `dropped` (⇒ a recorded failed attempt for the
   * retry supervisor). The watch therefore reaches `delivered` in-process on
   * both paths; it stays `merge-observed` while the turn is still queued, across
   * a restart that loses that queued turn (re-fired by `reconcilePending`), or
   * after a delivery that threw or ended badly (re-fired by
   * `retryStalledDeliveries`).
   *
   * Throws on a boot failure rather than reporting a wake that will never
   * happen — `attemptDelivery` owns what that means for the watch.
   */
  private async deliverWakeTurn(
    parent: SessionInfo,
    child: SessionInfo,
    info: PrTerminalStateInfo,
    outcome: "merged" | "closed-unmerged",
    onSettled?: (turnOutcome: TurnOutcome) => void,
  ): Promise<void> {
    // docs/239 — a self-wake is the same delivery with a different prompt: the
    // session is being told about its OWN merge, so it must reset its branch
    // before it does anything else. `parent === child` identifies it.
    const isSelf = parent.id === child.id;
    const text = isSelf ? buildSelfWakeTurnPrompt(info) : buildWakeTurnPrompt(child, info, outcome);
    const activity = isSelf
      ? "Resuming after your PR merged…"
      : outcome === "merged" ? "Resuming after child PR merged…" : "Reassessing after child PR closed…";

    // `wakeSessionWithTurn` owns the stale-runner teardown, container resume,
    // credential refresh, and the truthful "did a live worker take it?" check —
    // shared with the docs/233 report delivery so both paths resume a reaped
    // container identically. It throws on a boot failure; the caller
    // (`attemptDelivery`) records the failed attempt and leaves the watch at
    // `merge-observed` for the retry supervisor to re-attempt on a backoff.
    //
    // Wire the completion callback on BOTH the busy and idle paths. `dispatch`
    // enqueues when the parent is mid-turn (drained post-turn, never preempting)
    // and starts the turn now when idle; the completion settlement now rides the
    // in-memory queue (docs/196 fix), so it fires when the wake-turn ACTUALLY
    // reaches a terminal outcome in either case. `markDelivered` is therefore
    // reached in-process for a busy parent too — no restart required — and, since
    // docs/240, only when that outcome is a clean `completed`.
    //
    // This closes the duplicate-notification bug: previously the busy path left
    // the completion signal unwired, so a busy-parent watch stayed `merge-observed`
    // forever (the queue dropped the callback at enqueue), and
    // `reconcilePending` re-fired the wake-turn on EVERY orchestrator restart.
    // Now the watch advances to `delivered` once the enqueued turn drains, and
    // reconcile re-fires ONLY when a restart happened before that turn ran (the
    // queue is in-memory, so the un-run turn was genuinely lost) — the real
    // in-flight recovery case the design intended.
    await wakeSessionWithTurn(this.deps, parent, {
      text,
      activity,
      ...(onSettled ? { onSettled } : {}),
    });
  }
}

/**
 * The fire-once guard, in one place. `delivery-failed` joins the terminal set
 * (SHI-258): the watch gave up and told the human, so a later re-observation
 * must not silently resurrect it — re-arming is the user's / agent's call.
 */
function isTerminalWatchState(state: SessionMergeWatch["state"]): boolean {
  return state === "delivered" || state === "closed-unmerged" || state === "delivery-failed";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The self-describing wake-turn prompt — carries everything; depends on no in-memory state. */
function buildWakeTurnPrompt(
  child: SessionInfo,
  info: PrTerminalStateInfo,
  outcome: "merged" | "closed-unmerged",
): string {
  const lines: string[] = [];
  const id = `${child.title} (${child.id})`;
  if (outcome === "merged") {
    lines.push(
      `A child session you registered a merge-watch on has had its pull request MERGED.`,
      ``,
      `Child session: ${id}`,
      ...(child.branch ? [`Branch:        ${child.branch}`] : []),
      `Merged PR:     #${info.prNumber}${info.prTitle ? ` — ${info.prTitle}` : ""}`,
      `PR URL:        ${info.prUrl}`,
      ...(info.mergeSha ? [`Merge commit:  ${info.mergeSha}`] : []),
      ``,
      `You registered this watch because your own work depends on the child's. The merged change is now on the base branch. Proceed with the planned rebase / integration of it unless the user has since redirected you. If you're unsure what you were waiting on, review this session's earlier messages for why you spawned the child.`,
    );
  } else {
    lines.push(
      `A child session you registered a merge-watch on had its pull request CLOSED WITHOUT MERGING.`,
      ``,
      `Child session: ${id}`,
      ...(child.branch ? [`Branch:        ${child.branch}`] : []),
      `Closed PR:     #${info.prNumber}${info.prTitle ? ` — ${info.prTitle}` : ""}`,
      `PR URL:        ${info.prUrl}`,
      ``,
      `The child's work did NOT ship — do NOT proceed as if it had merged. The change you were depending on is not on the base branch. Reassess: tell the user, and decide whether to redo the work here, reopen / redo the child, or take a different path.`,
    );
  }
  return lines.join("\n");
}

/**
 * docs/239 — the SELF-merge wake prompt. Prose lives in the co-located
 * `prompts/self-merge-wake.md` (CLAUDE.md › Prompts: text is data, composition
 * is code); only the PR facts are filled in here.
 *
 * Self-describing like its parent→child sibling: it may run many turns — or a
 * restart — after the merge, so every fact it needs is in the text.
 */
function buildSelfWakeTurnPrompt(info: PrTerminalStateInfo): string {
  return fillPromptTokens(SELF_MERGE_WAKE_PROMPT, {
    PR_NUMBER: String(info.prNumber),
    PR_TITLE_SUFFIX: info.prTitle ? ` — ${info.prTitle}` : "",
    PR_URL: info.prUrl,
    BRANCH_LINE: info.branch ? `\nBranch:        ${info.branch}` : "",
  });
}
