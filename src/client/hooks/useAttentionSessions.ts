import { useMemo } from "react";
import { useSessionStore } from "../stores/session-store.js";
import { usePrStore } from "../stores/pr-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { isTerminalPrResolved } from "../../server/shared/session-resolution.js";
import { computeAttentionReason } from "./useAttentionInfo.js";
import type { SessionInfo } from "../../server/shared/types.js";

/**
 * docs/260 — every session that needs the user's attention right now, as a set
 * of ids.
 *
 * `useAttentionInfo` answers the same question for ONE session and is what each
 * row calls; this is the whole-list pass the sidebar's "Needs you" view and its
 * count need. Both funnel through the same `computeAttentionReason`, so the
 * view, the row marker, the tooltip and notifications can never disagree
 * (req 9) — there is deliberately no second predicate here.
 *
 * Archived sessions are excluded, matching `SessionItem`, which suppresses the
 * marker on an archived row: a row with no marker must never be in a view whose
 * membership IS the marker.
 */
export function useAttentionSessions(sessions: SessionInfo[]): Set<string> {
  const activeRunnerSessions = useSessionStore((s) => s.activeRunnerSessions);
  const awaitingPermissionSessions = useSessionStore((s) => s.awaitingPermissionSessions);
  const backgroundTaskSessions = useSessionStore((s) => s.backgroundTaskSessions);
  const cardBySession = usePrStore((s) => s.cardBySession);
  const statusBySession = usePrStore((s) => s.statusBySession);
  const autoFixEnabled = useSettingsStore((s) => s.autoFixCi);
  const autoResolveEnabled = useSettingsStore((s) => s.autoResolveConflicts);

  return useMemo(() => {
    const ids = new Set<string>();
    for (const session of sessions) {
      if (session.archived || session.userArchived || session.warm) continue;
      const reason = computeAttentionReason({
        card: cardBySession[session.id],
        status: statusBySession[session.id],
        isAgentRunning: activeRunnerSessions.has(session.id),
        awaitingPermission: awaitingPermissionSessions.has(session.id),
        hasBackgroundTasks: backgroundTaskSessions.has(session.id),
        autoFixEnabled,
        autoResolveEnabled,
        resolved: isTerminalPrResolved(session),
      });
      if (reason !== null) ids.add(session.id);
    }
    return ids;
  }, [sessions, activeRunnerSessions, awaitingPermissionSessions, backgroundTaskSessions, cardBySession, statusBySession, autoFixEnabled, autoResolveEnabled]);
}
