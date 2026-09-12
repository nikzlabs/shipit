import { useSessionStore } from "../stores/session-store.js";
import { usePrStore } from "../stores/pr-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { isTerminalPrResolved } from "../../server/shared/session-resolution.js";
import type { PrCardState } from "../stores/pr-store.js";
import type { PrStatusSummary } from "../../server/shared/types/github-types.js";
import type { WorkspaceBlockKind } from "../../server/shared/types.js";

/**
 * docs/298-broken-workspace-visibility req 3 — what to say about a workspace
 * ShipIt cannot put into a safe state. Exhaustive by construction: a new
 * `WorkspaceBlockKind` fails to compile until it has a sentence here.
 */
const WORKSPACE_BLOCK_REASON: Record<WorkspaceBlockKind, string> = {
  conflict: "Workspace has an unresolved merge or rebase",
  secret: "Workspace holds a secret that can't be committed",
  unreadable: "Workspace has a file ShipIt can't read",
  "no-repository": "Workspace is no longer a git repository",
  unknown: "Workspace has changes ShipIt can't commit",
};

export interface AttentionInputs {
  card: PrCardState | undefined;
  status: PrStatusSummary | undefined;
  isAgentRunning: boolean;

  awaitingPermission: boolean;

  hasBackgroundTasks: boolean;

  autoFixEnabled: boolean;

  autoResolveEnabled: boolean;
  /**
   * The session's PR has reached a terminal state — merged or
   * closed-without-merge — and hasn't been reopened (worked in) since. This is
   * the SAME signal that demotes the row into the sidebar's "Recently resolved"
   * group (keyed on `SessionInfo.mergedAt`/`closedAt`). It
   * is passed in — rather than re-derived from the pr-store `status.prState` —
   * so the grouping and the attention marker can never disagree: a just-merged
   * row whose pr-store status still reads `open` (or carries a stale CI
   * `failure`) would otherwise wear the amber "needs attention" bar in the very
   * group that means "done".
   */
  resolved: boolean;

  muted: boolean;
  /**
   * docs/298 — `SessionInfo.workspaceBlock`, or undefined when nothing blocks
   * the checkout. Unlike every other reason here, nothing in the session
   * resolves this one on its own.
   */
  workspaceBlockKind: WorkspaceBlockKind | undefined;
}

/**
 * Pure derivation of a session's attention reason from store snapshots.
 * Returns the highest-priority reason string, or `null` if no attention
 * is needed. This is the single source of truth for "session needs
 * attention" — the sidebar border, the tooltip, and notifications all
 * derive from this function so they can never disagree.
 *
 * Auto-behaviors (auto-fix, auto-resolve, auto-merge) move the ball out of
 * the user's court: when one is enabled and still has a path forward
 * (queued, running, cooling down, or with retry budget left), this returns
 * `null` so we stay silent. We only surface a reason at the *terminal*
 * state — the loop exhausted its attempts, hit a config blocker it can't
 * pass, or no automation covers the stop at all.
 */
export function computeAttentionReason({
  card,
  status,
  isAgentRunning,
  awaitingPermission,
  hasBackgroundTasks,
  autoFixEnabled,
  autoResolveEnabled,
  resolved,
  muted,
  workspaceBlockKind,
}: AttentionInputs): string | null {

  // count, and the notification watcher all go quiet together precisely because

  if (muted) return null;

  const checks = card?.checks;
  const autoFix = card?.autoFix;
  const autoResolve = card?.autoResolve;
  const autoMerge = card?.autoMerge;
  const prState = status?.prState;
  const mergeable = status?.mergeable;

  // other reason — including the `isAgentRunning` short-circuit below, because

  if (awaitingPermission) return "Needs your approval to continue";

  // docs/298-broken-workspace-visibility reqs 3-5 — a workspace ShipIt cannot
  // put into a safe state. It sits above the two short-circuits below because
  // neither premise holds for it: no turn repairs a stuck rebase by finishing,
  // and a merged PR does not make an uncommittable checkout stop needing the
  // user. Below the permission prompt, which is the more immediate block.
  if (workspaceBlockKind) return WORKSPACE_BLOCK_REASON[workspaceBlockKind];

  if (isAgentRunning || hasBackgroundTasks) return null;

  // resolve signal, so a row in "Recently resolved" never wears the bar.
  if (resolved) return null;

  // merged PR whose row hasn't been regrouped yet must still be silent. This

  if (prState === "merged" || prState === "closed") return null;
  if (card?.phase === "merged" || card?.phase === "closed") return null;

  if (checks?.state === "failure") {
    if (autoFix?.status === "exhausted") return "CI fix failed after 3 attempts";
    if (autoFix?.status === "running") return null;
    if (autoFixEnabled) return null;                                     
    return "CI checks failed";
  }

  if (prState === "open" && mergeable === "conflicting") {
    if (autoResolve?.status === "exhausted") return "Conflict resolution failed after 3 attempts";
    if (autoResolve?.status === "running") return null;
    if (autoResolveEnabled) return null;                                     
    return "PR has merge conflicts";
  }

  if (autoMerge?.error) {
    return "Auto-merge needs repo configuration";
  }

  if (checks?.state === "pending") return null;

  if (autoMerge?.enabled) return null;

  return "Waiting for your input";
}

/**
 * `muted` and `workspaceBlockKind` are passed in rather than looked up: the
 * caller is a session ROW, whose `SessionInfo` may come from a list the store
 * has not caught up with, and a stale lookup would contradict the row itself.
 */
export function useAttentionInfo(
  sessionId: string,
  muted = false,
  workspaceBlockKind?: WorkspaceBlockKind,
): string | null {
  const card = usePrStore((s) => s.cardBySession[sessionId]);
  const status = usePrStore((s) => s.statusBySession[sessionId]);
  const isAgentRunning = useSessionStore((s) => s.activeRunnerSessions.has(sessionId));
  const awaitingPermission = useSessionStore((s) => s.awaitingPermissionSessions.has(sessionId));
  const hasBackgroundTasks = useSessionStore((s) => s.backgroundTaskSessions.has(sessionId));
  const autoFixEnabled = useSettingsStore((s) => s.autoFixCi);
  const autoResolveEnabled = useSettingsStore((s) => s.autoResolveConflicts);
  const resolved = useSessionStore((s) => {
    const session = s.sessions.find((sess) => sess.id === sessionId);
    return session ? isTerminalPrResolved(session) : false;
  });
  return computeAttentionReason({ card, status, isAgentRunning, awaitingPermission, hasBackgroundTasks, autoFixEnabled, autoResolveEnabled, resolved, muted, workspaceBlockKind });
}
