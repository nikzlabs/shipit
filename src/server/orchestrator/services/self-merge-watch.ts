/**
 * docs/239 — arming and cancelling a SELF merge-watch.
 *
 * `shipit session notify-on-merge --self` is docs/196's merge-watch pointed back
 * at the same session: the row is the existing `SessionMergeWatch` with
 * `kind: "self"` and `parentSessionId === sessionId`, so the state machine, the
 * planning#260 retry supervisor, the polling gate and `reconcilePending` all come by
 * inheritance rather than being rebuilt here. This module owns only the two
 * things that ARE new: resolving the anchor PR, and the arm card.
 *
 * Two decisions are load-bearing and easy to "simplify" back into bugs:
 *
 *  1. **The PR is resolved by a LIVE lookup** (`resolveSessionPr` →
 *     `findPullRequest`), never from the persisted `pr_status` snapshot. At a
 *     chain boundary the agent arms seconds after opening the NEXT PR while the
 *     session is still in the poller's `mergedSessions` set — which the poller
 *     skips — so the snapshot still describes the previous, just-merged PR, and
 *     `gh pr create` returns before awaiting its own refresh. Anchoring on the
 *     snapshot would arm every chain link against the PR that already merged.
 *
 *  2. **Arming always REPLACES an existing self-watch**, including one already
 *     at `merge-observed`. The wake turn re-arms for the next PR *during* the
 *     turn the watch is delivering, so an idempotent "already armed → no-op"
 *     would make chaining impossible: the second link could never be armed.
 *
 * There is deliberately no captured follow-up payload — the session's own
 * transcript already holds the plan — and no "already merged → fire now" branch:
 * the live lookup simply finds nothing and says so, and the agent continues in
 * the turn it is already running.
 */

import { randomUUID } from "node:crypto";
import type { SelfMergeWatchCard, SessionMergeWatch } from "../../shared/types.js";
import type { SessionManager } from "../sessions.js";
import type { GitManager } from "../../shared/git.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { ChatHistoryManager } from "../chat-history.js";
import { emitChatCard } from "../chat-card-persistence.js";
import { resolveSessionPr } from "./github.js";
import { ServiceError } from "./types.js";

export interface SelfMergeWatchDeps {
  sessionManager: SessionManager;
  githubAuthManager: GitHubAuthManager;
  createGitManager: (dir: string) => GitManager;
  runnerRegistry: SessionRunnerRegistry;
  chatHistoryManager: ChatHistoryManager;
  /**
   * The deliverer, when wired. Cancelling goes through it so its in-memory retry
   * state (in-flight markers, last-observed PR facts, the supervisor timer) is
   * dropped with the row rather than left pointing at a watch that no longer
   * exists.
   */
  mergeWatchManager?: { forgetWatch(sessionId: string): void } | undefined;
}

export interface ArmSelfMergeWatchResult {
  watchId: string;
  prNumber: number;
  prUrl: string;
  prTitle?: string;
  /** True when this arm replaced a previous self-watch (a chain re-arm). */
  replaced: boolean;
}

/** A watch that is genuinely someone else's parent→child watch on this session. */
function isForeignParentWatch(watch: SessionMergeWatch | undefined, sessionId: string): boolean {
  if (!watch || watch.kind === "self") return false;
  if (watch.parentSessionId === sessionId) return false;
  return watch.state === "armed" || watch.state === "merge-observed";
}

/**
 * Arm (or re-arm) the self merge-watch for `sessionId`, anchored to the session
 * branch's currently-open PR, and surface the cancellable arm card.
 *
 * Refuses in exactly two cases: the row already holds a live parent→child watch
 * (one row, one watch — the accepted limitation of reusing it), and there is no
 * open PR for the branch. A missing branch or an unparseable remote fails the
 * lookup on its own and surfaces through the same message.
 */
export async function armSelfMergeWatch(
  deps: SelfMergeWatchDeps,
  sessionId: string,
): Promise<ArmSelfMergeWatchResult> {
  const session = deps.sessionManager.get(sessionId);
  if (!session) throw new ServiceError(404, "Session not found");
  if (!session.workspaceDir) throw new ServiceError(400, "Session has no workspace");

  const existing = session.mergeWatch;
  if (isForeignParentWatch(existing, sessionId)) {
    throw new ServiceError(
      409,
      "This session is already being watched by its parent session, and a session can hold "
        + "only one merge-watch. Ask the parent to cancel its watch, or continue without "
        + "arming a self-watch.",
    );
  }

  const git = deps.createGitManager(session.workspaceDir);
  const { pr } = await resolveSessionPr(git, deps.githubAuthManager, session.remoteUrl);
  if (!pr) {
    throw new ServiceError(
      400,
      "No open pull request for this session's branch, so there is no merge to wait for. "
        + "Open a PR first (gh pr create), then arm the watch. If your PR has already merged, "
        + "just continue the work in this turn.",
    );
  }

  const watchId = randomUUID();
  const watch: SessionMergeWatch = {
    parentSessionId: sessionId,
    kind: "self",
    watchId,
    prNumber: pr.number,
    state: "armed",
    registeredAt: new Date().toISOString(),
  };
  // Replace unconditionally — see the module docblock. Drop the previous
  // watch's in-memory retry state FIRST (it is keyed by session id, so a stale
  // in-flight marker would otherwise suppress the new watch's first retry), then
  // write the new row. `setMergeWatch` is a whole-row write, so the old
  // bookkeeping (`deliveryAttempts`, `lastAttemptAt`) goes with it — right, since
  // a new anchor is a new watch.
  deps.mergeWatchManager?.forgetWatch(sessionId);
  deps.sessionManager.setMergeWatch(sessionId, watch);

  const card: SelfMergeWatchCard = {
    cardId: `self-merge-watch-${randomUUID()}`,
    watchId,
    prNumber: pr.number,
    prUrl: pr.url,
    ...(pr.title ? { prTitle: pr.title } : {}),
    ...(session.branch ? { branch: session.branch } : {}),
    createdAt: new Date().toISOString(),
  };
  // The arm happens MID-TURN (an agent tool call relayed over HTTP), i.e. off
  // the agent-event stream — the side-channel shape CLAUDE.md's persistence
  // invariant covers — so it must go through `emitChatCard`, which emits,
  // records in-band, and persists in one call. Skipped when no runner is
  // attached (the watch is armed either way; only the card is best-effort).
  const runner = deps.runnerRegistry.get(sessionId);
  if (runner) {
    emitChatCard(
      runner,
      { type: "self_merge_watch_card", sessionId, card },
      { role: "assistant", text: "", selfMergeWatch: card },
      { chatHistoryManager: deps.chatHistoryManager, sessionId },
    );
  }

  return {
    watchId,
    prNumber: pr.number,
    prUrl: pr.url,
    ...(pr.title ? { prTitle: pr.title } : {}),
    replaced: existing?.kind === "self",
  };
}

export interface CancelSelfMergeWatchResult {
  cancelled: boolean;
  /** Why nothing was cancelled — `not-armed` or `superseded`. */
  reason?: "not-armed" | "superseded";
}

/**
 * Cancel the armed self-watch, from the arm card's Cancel button.
 *
 * `watchId` is required and compared: a card left in the scrollback from an
 * earlier link of a chain names a watch that no longer exists, and must NOT
 * cancel the one armed for the CURRENT PR. Cancelling means no wake fires, so no
 * turn runs, so nothing re-arms — which is why cancel is genuinely terminal for
 * a chain even though ShipIt models no chain object. A turn already in flight
 * finishes (and may re-arm); the card's copy says so.
 */
export function cancelSelfMergeWatch(
  deps: Pick<SelfMergeWatchDeps, "sessionManager" | "mergeWatchManager">,
  sessionId: string,
  watchId: string,
): CancelSelfMergeWatchResult {
  const session = deps.sessionManager.get(sessionId);
  if (!session) throw new ServiceError(404, "Session not found");
  const watch = session.mergeWatch;
  if (watch?.kind !== "self") return { cancelled: false, reason: "not-armed" };
  if (watch.watchId !== watchId) return { cancelled: false, reason: "superseded" };
  if (deps.mergeWatchManager) deps.mergeWatchManager.forgetWatch(sessionId);
  else deps.sessionManager.setMergeWatch(sessionId, null);
  return { cancelled: true };
}
