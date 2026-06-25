import { useSessionStore } from "../stores/session-store.js";
import { usePrStore } from "../stores/pr-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { isRecentlyResolved } from "../components/SessionSidebar/useSessionGrouping.js";
import type { PrCardState } from "../stores/pr-store.js";
import type { PrStatusSummary } from "../../server/shared/types/github-types.js";

export interface AttentionInputs {
  card: PrCardState | undefined;
  status: PrStatusSummary | undefined;
  isAgentRunning: boolean;
  /** docs/193 (Thread C) — the session is blocked awaiting a permission answer. */
  awaitingPermission: boolean;
  /** Global `autoFixCi` setting — when on, a CI failure has a fix loop coming. */
  autoFixEnabled: boolean;
  /** Global `autoResolveConflicts` setting — when on, a conflict has a resolve loop coming. */
  autoResolveEnabled: boolean;
  /**
   * The session's PR has reached a terminal state — merged or
   * closed-without-merge — and hasn't been reopened (worked in) since. This is
   * the SAME signal that demotes the row into the sidebar's "Recently resolved"
   * group (`isRecentlyResolved`, keyed on `SessionInfo.mergedAt`/`closedAt`). It
   * is passed in — rather than re-derived from the pr-store `status.prState` —
   * so the grouping and the attention marker can never disagree: a just-merged
   * row whose pr-store status still reads `open` (or carries a stale CI
   * `failure`) would otherwise wear the amber "needs attention" bar in the very
   * group that means "done".
   */
  resolved: boolean;
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
  autoFixEnabled,
  autoResolveEnabled,
  resolved,
}: AttentionInputs): string | null {
  const checks = card?.checks;
  const autoFix = card?.autoFix;
  const autoResolve = card?.autoResolve;
  const autoMerge = card?.autoMerge;
  const prState = status?.prState;
  const mergeable = status?.mergeable;

  // A blocked permission prompt is the user's to answer and outranks every
  // other reason — including the `isAgentRunning` short-circuit below, because
  // the agent IS "running" (held inside the gated tool call) while it waits.
  // This is what makes a permission prompt visible from another session.
  if (awaitingPermission) return "Needs your approval to continue";

  if (isAgentRunning) return null;

  // Terminal PR — merged or closed-without-merge, and not reopened since. There
  // is nothing left for the user to do, so no stale CI/conflict/auto-merge state
  // on the now-historical PR card should raise a flag. This short-circuits ABOVE
  // those branches (a merged PR can still carry a `failure` checks state that
  // would otherwise read as "CI checks failed") and uses the grouping's own
  // resolve signal, so a row in "Recently resolved" never wears the bar.
  if (resolved) return null;

  // CI failure — stay silent while a fix is in flight or queued; speak only
  // when the loop gives up (exhausted) or auto-fix is off entirely.
  if (checks?.state === "failure") {
    if (autoFix?.status === "exhausted") return "CI fix failed after 3 attempts";
    if (autoFix?.status === "running") return null;
    if (autoFixEnabled) return null; // idle/deferred → a retry is coming
    return "CI checks failed";
  }

  // Merge conflict — same shape for the auto-resolve loop.
  if (prState === "open" && mergeable === "conflicting") {
    if (autoResolve?.status === "exhausted") return "Conflict resolution failed after 3 attempts";
    if (autoResolve?.status === "running") return null;
    if (autoResolveEnabled) return null; // idle/deferred → a retry is coming
    return "PR has merge conflicts";
  }

  // A config blocker auto-merge can't get past is genuinely the user's to fix.
  if (autoMerge?.error) {
    return "Auto-merge needs repo configuration";
  }

  if (checks?.state === "pending") return null;

  if (prState === "merged" || prState === "closed") return null;

  // Agent idle on an open PR with nothing blocking: if auto-merge owns the
  // merge, the user delegated it and has nothing to do until it merges (→
  // closed, silent) or hits a blocker (→ the autoMerge.error branch above).
  if (autoMerge?.enabled) return null;

  return "Waiting for your input";
}

/** Returns the highest-priority attention reason for a session, or null if no attention needed. */
export function useAttentionInfo(sessionId: string): string | null {
  const card = usePrStore((s) => s.cardBySession[sessionId]);
  const status = usePrStore((s) => s.statusBySession[sessionId]);
  const isAgentRunning = useSessionStore((s) => s.activeRunnerSessions.has(sessionId));
  const awaitingPermission = useSessionStore((s) => s.awaitingPermissionSessions.has(sessionId));
  const autoFixEnabled = useSettingsStore((s) => s.autoFixCi);
  const autoResolveEnabled = useSettingsStore((s) => s.autoResolveConflicts);
  const resolved = useSessionStore((s) => {
    const session = s.sessions.find((sess) => sess.id === sessionId);
    return session ? isRecentlyResolved(session) : false;
  });
  return computeAttentionReason({ card, status, isAgentRunning, awaitingPermission, autoFixEnabled, autoResolveEnabled, resolved });
}
