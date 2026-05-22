// eslint-disable-next-line no-restricted-imports -- useEffect: reacts to store snapshots to fire notifications on transition
import { useEffect, useRef } from "react";
import { useSessionStore } from "../stores/session-store.js";
import { usePrStore } from "../stores/pr-store.js";
import { parseRepoLabel } from "../utils/repo-label.js";
import { computeAttentionReason } from "./useAttentionInfo.js";
import type { NotifyContext } from "./useNotification.js";

/**
 * Watches every (non-archived) session's attention state and fires
 * `notify` whenever a session transitions from "no attention" to a
 * non-null reason. The trigger is the same `computeAttentionReason`
 * derivation that drives the sidebar's amber border — so the user is
 * notified about exactly the same conditions they'd otherwise spot by
 * scanning the sidebar.
 *
 * Per-session initialization: the first time we see a session we
 * record its current reason WITHOUT notifying, so reloading the page
 * (or discovering a pre-existing attention-needing session) never
 * fires a stale notification. Only true `null → reason` transitions
 * fire.
 */
export function useAttentionNotifications(
  notify: (msg: string, context?: NotifyContext) => void,
): void {
  const sessions = useSessionStore((s) => s.sessions);
  const activeRunnerSessions = useSessionStore((s) => s.activeRunnerSessions);
  const cardBySession = usePrStore((s) => s.cardBySession);
  const statusBySession = usePrStore((s) => s.statusBySession);

  const prevReasonsRef = useRef<Map<string, string | null>>(new Map());

  // eslint-disable-next-line no-restricted-syntax -- store-driven dispatch
  useEffect(() => {
    const next = new Map<string, string | null>();
    for (const session of sessions) {
      if (session.archived) continue;
      const reason = computeAttentionReason({
        card: cardBySession[session.id],
        status: statusBySession[session.id],
        isAgentRunning: activeRunnerSessions.has(session.id),
      });
      next.set(session.id, reason);

      const prev = prevReasonsRef.current.get(session.id);
      // `prev === undefined` means this is the first time we see the
      // session — seed it silently so reloads don't re-fire alerts for
      // sessions that were already in an attention state.
      if (prev !== undefined && prev === null && reason !== null) {
        notify(reason, {
          sessionName: session.title,
          repoLabel: session.remoteUrl ? parseRepoLabel(session.remoteUrl) : undefined,
        });
      }
    }
    prevReasonsRef.current = next;
  }, [sessions, activeRunnerSessions, cardBySession, statusBySession, notify]);
}
