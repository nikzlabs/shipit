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
 * `closed-unmerged`). Persistence is what makes the firing survive an
 * orchestrator restart: `reconcilePending` re-derives "child PR terminal + watch
 * un-delivered → fire" from the persisted PR snapshot on startup, so a crash
 * between merge-detection and delivery doesn't strand the parent.
 *
 * The card-surfacing + wake-turn delivery mirror `issue-lifecycle.ts`: both fire
 * **outside any turn**, so the card is appended directly to chat history
 * (durable, rehydrates on reload) and broadcast live only when a runner is still
 * attached. The wake-turn delivery mirrors `sendChildMessage`'s container-resume
 * dance so an idle/idle-reaped parent is woken, not silently dropped.
 */

import { randomUUID } from "node:crypto";
import type { SessionManager } from "./sessions.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { ChatHistoryManager } from "./chat-history.js";
import type { CredentialStore } from "./credential-store.js";
import type { ProviderAccountManager } from "./provider-account-manager.js";
import type { SessionContainerManager } from "./session-container.js";
import type { AgentId, ChildMergedCard, SessionInfo, WsServerMessage } from "../shared/types.js";
import type { PrStatusSummary } from "../shared/types/github-types.js";
import { ContainerSessionRunner } from "./container-session-runner.js";
import { prepareSessionAgentEnvironment } from "./session-agent-env.js";
import type { PrTerminalStateInfo } from "./pr-status-poller.js";

/** Collaborators the deliverer needs — all orchestrator-side. */
export interface MergeWatchDeps {
  sessionManager: SessionManager;
  runnerRegistry: SessionRunnerRegistry;
  chatHistoryManager: ChatHistoryManager;
  defaultAgentId: AgentId;
  credentialsDir?: string | undefined;
  credentialStore?: CredentialStore | undefined;
  providerAccountManager?: ProviderAccountManager | undefined;
  containerManager?: SessionContainerManager | null | undefined;
}

/**
 * How long to wait for a freshly-booted parent container's worker before
 * dispatching the wake-turn anyway. Mirrors `sendChildMessage`'s backstop — the
 * dispatched turn's own startup also awaits readiness, so a slow boot isn't a
 * lost turn; the wait only makes a boot *failure* observable here.
 */
const PARENT_WAKE_WORKER_READY_TIMEOUT_MS = 30_000;

export class MergeWatchManager {
  /**
   * Late-bound lookup of a session's last-known PR snapshot (the poller's
   * `getStatus`). Bound after construction because the poller is built *after*
   * this manager (the poller's `onPrTerminalState` references it). Used by the
   * startup reconcile and the register-time "already resolved?" check.
   */
  private prStatusLookup?: (sessionId: string) => PrStatusSummary | undefined;

  constructor(private readonly deps: MergeWatchDeps) {}

  /** Bind the PR-status lookup (the poller's `getStatus`). Called once at wiring. */
  setPrStatusLookup(fn: (sessionId: string) => PrStatusSummary | undefined): void {
    this.prStatusLookup = fn;
  }

  /**
   * Register-time backstop for the rare race where a watch is armed AFTER the
   * child's PR already reached a terminal state — the poller won't re-observe a
   * session it has already promoted, so without this the watch would never fire.
   * Checks the child's last-known PR snapshot and fires immediately if terminal.
   * No-op (and harmless) for the common case where the PR is still open / absent.
   */
  async checkAndFireNow(childSessionId: string): Promise<void> {
    const status = this.prStatusLookup?.(childSessionId);
    if (!status || (status.prState !== "merged" && status.prState !== "closed")) return;
    await this.handleChildPrTerminal({
      sessionId: childSessionId,
      outcome: status.prState === "merged" ? "merged" : "closed",
      prNumber: status.prNumber ?? 0,
      prUrl: status.prUrl ?? "",
      prTitle: status.prTitle ?? "",
      branch: status.headBranch ?? "",
    });
  }

  /**
   * PR-poller hook: a tracked session's PR reached a terminal state. No-ops
   * unless THIS session carries an armed merge-watch. Idempotent — a watch that
   * is already `delivered` / `closed-unmerged` is skipped (fire-once), so a
   * re-poll or a restart re-observation never double-fires.
   */
  async handleChildPrTerminal(info: PrTerminalStateInfo): Promise<void> {
    const child = this.deps.sessionManager.get(info.sessionId);
    const watch = child?.mergeWatch;
    if (!child || !watch) return;
    // Fire-once: terminal states are never re-delivered.
    if (watch.state === "delivered" || watch.state === "closed-unmerged") return;

    const parent = this.deps.sessionManager.get(watch.parentSessionId);
    // Parent archived/gone before the merge → drop the watch silently (docs/196
    // edge case). userArchived implies archived via `fromRow`, but check both.
    if (!parent || parent.archived || parent.userArchived) {
      this.deps.sessionManager.setMergeWatch(info.sessionId, null);
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
      // actually RUN to completion — surfaced via the `onTurnComplete`-backed
      // `markDelivered` callback, NOT the instant the turn is enqueued:
      //   • idle parent → the turn starts now → it completes → `delivered`.
      //   • busy parent → the turn is enqueued (drained post-turn, never
      //     preempting) → no completion signal → the watch stays
      //     `merge-observed`.
      // The watch therefore remains at `merge-observed` for the whole window
      // between enqueue and execution. A restart anywhere in that window leaves
      // it at `merge-observed`, which `reconcilePending` re-fires on the next
      // startup. This closes the bug where the watch was stamped `delivered` the
      // instant the turn was queued: the queued turn lives only in memory, so an
      // orchestrator restart lost it while the persisted watch already read
      // `delivered` and was skipped by reconcile — stranding the parent. A live
      // re-poll can't recover it (the PR is `alreadyTerminal`), so
      // reconcile-on-restart is the sole recovery path. `deliverWakeTurn` still
      // throws on a parent container boot failure — that too leaves the watch at
      // `merge-observed` for the next poll / reconcile to retry.
      await this.deliverWakeTurn(parent, child, info, cardOutcome, () => {
        this.markDelivered(info.sessionId, now);
      });
      return;
    }

    // Closed-without-merge — terminal in one step. Surface the (distinct) card
    // and mark the watch terminal before delivering so a re-poll can't re-fire;
    // the wake-turn is best-effort (a boot failure here is logged, not retried).
    this.surfaceCard(parent.id, child, info, cardOutcome);
    this.deps.sessionManager.setMergeWatch(info.sessionId, {
      parentSessionId: watch.parentSessionId,
      state: "closed-unmerged",
      registeredAt: watch.registeredAt,
      observedAt: now,
      deliveredAt: now,
    });
    await this.deliverWakeTurn(parent, child, info, cardOutcome);
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
   */
  async reconcilePending(): Promise<void> {
    const getStatus = this.prStatusLookup;
    if (!getStatus) return;
    const pending = this.deps.sessionManager.listPendingMergeWatches();
    for (const { childSessionId } of pending) {
      const status = getStatus(childSessionId);
      if (!status) continue;
      if (status.prState !== "merged" && status.prState !== "closed") continue;
      const info: PrTerminalStateInfo = {
        sessionId: childSessionId,
        outcome: status.prState === "merged" ? "merged" : "closed",
        prNumber: status.prNumber ?? 0,
        prUrl: status.prUrl ?? "",
        prTitle: status.prTitle ?? "",
        branch: status.headBranch ?? "",
      };
      try {
        await this.handleChildPrTerminal(info);
      } catch (err) {
        console.error(`[merge-watch] reconcile delivery failed for ${childSessionId}:`, err);
      }
    }
  }

  /**
   * Advance a merge-watch from `merge-observed` to the terminal `delivered`
   * state. Fired from the wake-turn's `onTurnComplete`, so it runs only after
   * the turn has genuinely executed — that is the whole point of the fix
   * (`delivered` must mean "ran", not "queued"). Idempotent and fire-once: a
   * watch that is already terminal (`delivered` / `closed-unmerged`) or has
   * since been cleared (parent archived) is left untouched, so a re-delivery or
   * a late callback can never double-stamp or resurrect a dropped watch.
   */
  private markDelivered(childSessionId: string, fallbackObservedAt: string): void {
    const watch = this.deps.sessionManager.getMergeWatch(childSessionId);
    if (!watch || watch.state === "delivered" || watch.state === "closed-unmerged") return;
    this.deps.sessionManager.setMergeWatch(childSessionId, {
      parentSessionId: watch.parentSessionId,
      state: "delivered",
      registeredAt: watch.registeredAt,
      observedAt: watch.observedAt ?? fallbackObservedAt,
      deliveredAt: new Date().toISOString(),
    });
  }

  /**
   * Append the persisted merge card to the parent's chat history and broadcast
   * it live to any attached viewer. Fires outside any turn, so it's an `append`
   * (durable, sorts at the current end of history) rather than `emitChatCard`.
   */
  private surfaceCard(
    parentId: string,
    child: SessionInfo,
    info: PrTerminalStateInfo,
    outcome: "merged" | "closed-unmerged",
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
   * `onExecuted` (when supplied) fires only once the turn has actually RUN to
   * completion — wired through `onTurnComplete`, which `dispatch` honors only on
   * the idle path where it starts the turn now. When the parent is mid-turn the
   * turn is enqueued and `onExecuted` is intentionally NOT wired (a queued turn
   * carries no completion signal, and `onTurnComplete` is dispatch-only — it
   * does not survive the queue), so the caller leaves the watch recoverable for
   * the post-restart reconcile rather than prematurely marking it delivered.
   */
  private async deliverWakeTurn(
    parent: SessionInfo,
    child: SessionInfo,
    info: PrTerminalStateInfo,
    outcome: "merged" | "closed-unmerged",
    onExecuted?: () => void,
  ): Promise<void> {
    if (!parent.workspaceDir) {
      throw new Error(`parent ${parent.id} has no workspace`);
    }
    const { sessionManager, runnerRegistry, containerManager, credentialsDir, credentialStore, providerAccountManager, defaultAgentId } = this.deps;

    // A runner lingering in the registry whose container has been reaped points
    // at a dead worker — dispatching into it silently fails. Tear it down so the
    // `getOrCreate` below boots a fresh container.
    if (containerManager) {
      const stale = runnerRegistry.get(parent.id);
      const sc = containerManager.get(parent.id);
      const live = !!sc && (sc.status === "running" || sc.status === "starting");
      if (stale && !live) runnerRegistry.dispose(parent.id, { force: true });
    }

    const runner = runnerRegistry.getOrCreate(parent.id, parent.workspaceDir, parent.agentId ?? defaultAgentId);

    // Refresh credentials/OAuth/MCP before the turn fires (idempotent). Skipped
    // while the agent is already running — the next-starting turn's env-prep
    // covers it, and we must not race a live turn's environment.
    if (!runner.running && credentialsDir && credentialStore) {
      await prepareSessionAgentEnvironment(runner, {
        sessionId: parent.id,
        agentId: runner.agentId,
        deps: {
          credentialsDir,
          credentialStore,
          sessionManager,
          ...(providerAccountManager ? { providerAccountManager } : {}),
        },
      });
    }

    if (runner instanceof ContainerSessionRunner) {
      await Promise.race([
        runner.whenWorkerReady(),
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, PARENT_WAKE_WORKER_READY_TIMEOUT_MS);
          t.unref?.();
        }),
      ]);
    }
    if (runner.disposed) {
      throw new Error(`parent ${parent.id} container could not be resumed; wake-turn not delivered`);
    }

    const text = buildWakeTurnPrompt(child, info, outcome);
    const activity =
      outcome === "merged" ? "Resuming after child PR merged…" : "Reassessing after child PR closed…";

    // Mid-turn parent: `dispatch` enqueues the wake-turn (drained post-turn,
    // never preempting) and there is no completion signal to await — leave
    // `onExecuted` unwired so the watch stays `merge-observed`, recoverable by
    // `reconcilePending` after a restart. Idle parent: `dispatch` starts the
    // turn now, so wiring `onTurnComplete` lets us mark `delivered` only once it
    // has genuinely run.
    if (runner.running) {
      runner.dispatch({ text, activity, systemTurn: true });
      return;
    }
    runner.dispatch({
      text,
      activity,
      systemTurn: true,
      onTurnComplete: () => onExecuted?.(),
    });
  }
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
