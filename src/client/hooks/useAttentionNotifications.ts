// eslint-disable-next-line no-restricted-imports -- useEffect: reacts to store snapshots to fire notifications on transition
import { useEffect, useRef } from "react";
import { useSessionStore } from "../stores/session-store.js";
import { usePrStore } from "../stores/pr-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { parseRepoLabel } from "../utils/repo-label.js";
import { computeAttentionReason } from "./useAttentionInfo.js";
import { isRecentlyResolved } from "../components/SessionSidebar/useSessionGrouping.js";
import type { NotifyContext } from "./useNotification.js";

/**
 * How long an attention reason must hold before it is worth interrupting the
 * user for.
 *
 * "Needs attention" is a claim that the session has come to rest, but the state
 * it is derived from moves in steps that are briefly inconsistent — and every
 * one of those blips reads as `null → "Waiting for your input"`:
 *
 *  - the CLI drains its background-task list ~1ms *before* the self-wake that
 *    starts the next turn (docs/235), so the session is momentarily neither
 *    running nor waiting on a task;
 *  - a turn ends with a queued message behind it: `running` goes false, then
 *    true again when the drain starts the next turn;
 *  - a message is sent while the orchestrator is still setting the turn up.
 *
 * In every case the agent is working and the chime is simply wrong. Requiring
 * the reason to survive a settle window suppresses all of them without any
 * per-case special-casing; a session that genuinely stopped keeps its reason and
 * notifies a beat later, which no one can perceive in a notification.
 */
const ATTENTION_SETTLE_MS = 2500;

interface PendingNotification {
  timer: ReturnType<typeof setTimeout>;
  reason: string;
  title: string;
  remoteUrl?: string;
}

/**
 * Watches every (non-archived) session's attention state and fires
 * `notify` whenever a session transitions from "no attention" to a
 * non-null reason **and stays there** for {@link ATTENTION_SETTLE_MS}. The
 * trigger is the same `computeAttentionReason` derivation that drives the
 * sidebar's amber border — so the user is notified about exactly the same
 * conditions they'd otherwise spot by scanning the sidebar.
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
  const awaitingPermissionSessions = useSessionStore((s) => s.awaitingPermissionSessions);
  const backgroundTaskSessions = useSessionStore((s) => s.backgroundTaskSessions);
  const cardBySession = usePrStore((s) => s.cardBySession);
  const statusBySession = usePrStore((s) => s.statusBySession);
  const autoFixEnabled = useSettingsStore((s) => s.autoFixCi);
  const autoResolveEnabled = useSettingsStore((s) => s.autoResolveConflicts);

  const prevReasonsRef = useRef<Map<string, string | null>>(new Map());
  const pendingRef = useRef<Map<string, PendingNotification>>(new Map());

  // eslint-disable-next-line no-restricted-syntax -- store-driven dispatch
  useEffect(() => {
    const pending = pendingRef.current;
    const cancel = (sessionId: string): void => {
      const entry = pending.get(sessionId);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(sessionId);
    };

    const next = new Map<string, string | null>();
    for (const session of sessions) {
      if (session.archived) continue;
      const reason = computeAttentionReason({
        card: cardBySession[session.id],
        status: statusBySession[session.id],
        isAgentRunning: activeRunnerSessions.has(session.id),
        awaitingPermission: awaitingPermissionSessions.has(session.id),
        hasBackgroundTasks: backgroundTaskSessions.has(session.id),
        autoFixEnabled,
        autoResolveEnabled,
        resolved: isRecentlyResolved(session),
      });
      next.set(session.id, reason);

      // Back to "nothing to do" — whatever was waiting to be announced never
      // settled, so it was a blip and must not fire.
      if (reason === null) {
        cancel(session.id);
        continue;
      }

      const inFlight = pending.get(session.id);
      if (inFlight) {
        // Still needs attention. Keep the original clock running (so flapping
        // reasons can't defer the notification forever) but announce whatever
        // the reason has become by the time it fires.
        inFlight.reason = reason;
        inFlight.title = session.title;
        if (session.remoteUrl) inFlight.remoteUrl = session.remoteUrl;
        continue;
      }

      const prev = prevReasonsRef.current.get(session.id);
      // `prev === undefined` means this is the first time we see the
      // session — seed it silently so reloads don't re-fire alerts for
      // sessions that were already in an attention state.
      if (prev !== undefined && prev === null) {
        const sessionId = session.id;
        const timer = setTimeout(() => {
          const entry = pending.get(sessionId);
          pending.delete(sessionId);
          if (!entry) return;
          notify(entry.reason, {
            sessionName: entry.title,
            repoLabel: entry.remoteUrl ? parseRepoLabel(entry.remoteUrl) : undefined,
          });
        }, ATTENTION_SETTLE_MS);
        pending.set(sessionId, {
          timer,
          reason,
          title: session.title,
          ...(session.remoteUrl ? { remoteUrl: session.remoteUrl } : {}),
        });
      }
    }

    // A session that was archived or removed while its notification was still
    // settling has nothing left to announce.
    for (const sessionId of [...pending.keys()]) {
      if (!next.has(sessionId)) cancel(sessionId);
    }

    prevReasonsRef.current = next;
  }, [sessions, activeRunnerSessions, awaitingPermissionSessions, backgroundTaskSessions, cardBySession, statusBySession, autoFixEnabled, autoResolveEnabled, notify]);

  // Unmount only — deliberately a separate effect with no deps. Folding this
  // into the effect above would clear every pending timer on each store change,
  // which is exactly the settle window we're trying to observe.
  // eslint-disable-next-line no-restricted-syntax -- lifecycle cleanup
  useEffect(() => {
    const pending = pendingRef.current;
    return () => {
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
    };
  }, []);
}
