import { useMemo, useState } from "react";
import { parseRepoName } from "../../utils/repo-label.js";
import { SessionItem } from "./SessionItem.js";
import type { SessionInfo } from "../../../server/shared/types.js";

interface AttentionSessionListProps {
  /** The sidebar's visible sessions — already filtered for hidden repos. */
  sessions: SessionInfo[];
  /** Ids needing attention right now, from `useAttentionSessions`. */
  attentionIds: Set<string>;
  currentSessionId: string | undefined;
  onResume: (sessionId: string) => void;
  onSelectCurrent?: () => void;
  onArchive?: (sessionId: string) => void;
  isTouch?: boolean;
}

/**
 * docs/260 — the sidebar's second view: one flat list of the sessions that need
 * the user, with no repository grouping and no headers (reqs 2, 3, 6).
 *
 * **The rows are not new.** Each is the same `SessionItem` the first view
 * renders, with `repoLabel` set — the identical call `AllSessionsDialog` already
 * makes for its cross-repo list. So the reason a session needs attention is
 * shown exactly the way it is shown today (the status dot, the docs/187 marker
 * and the row tooltip) and is not restated as text (req 11), and the repository
 * name comes for free (req 12).
 *
 * **Order is arrival order, and it is append-only** (req 7). The rows present
 * when the view opens are seeded by `createdAt` descending — the only key in the
 * session model that never changes, and already the first view's within-repo
 * order. A session that starts needing attention later is **appended**, never
 * inserted, so no row on screen ever moves. A `createdAt` sort alone would not
 * give that: a newly-qualifying session lands in its date slot and pushes every
 * row below it down, which is exactly the motion req 7 forbids. (Sorting by
 * urgency was rejected for the same reason, one step worse: it re-orders on
 * every reason change.)
 *
 * **Membership is sticky, for the same reason.** A session that stops needing
 * attention would otherwise vanish from under the pointer mid-click, so it keeps
 * its slot until the view is left and entered again (req 8) — the order list is
 * component state and the component unmounts on the way out, which is what makes
 * "entered again" the reset. A settled row needs no invented marker: it loses
 * the amber one, because `SessionItem` derives that itself, and dims like an
 * archived row, which is req 8's "marked as no longer needing attention".
 *
 * A session that leaves the sidebar entirely (archived, hidden, removed) is
 * dropped immediately — stickiness is about a session that stopped *needing*
 * you, not about outliving the session itself.
 */
export function AttentionSessionList({
  sessions,
  attentionIds,
  currentSessionId,
  onResume,
  onSelectCurrent,
  onArchive,
  isTouch,
}: AttentionSessionListProps) {
  // The rendered order, append-only for the lifetime of the view. This is state
  // adjusted DURING render rather than a ref mutated in a memo (or an effect):
  // React's documented "adjust state while rendering" path is concurrent-safe —
  // an abandoned render's `setOrder` is discarded with it — while a ref written
  // during render survives a render that never commits, and an effect would let
  // the list paint once without a row that already qualifies.
  const [order, setOrder] = useState<string[]>([]);
  const arrived = [...attentionIds].filter((id) => !order.includes(id));
  if (arrived.length > 0) {
    const createdAt = new Map(sessions.map((s) => [s.id, s.createdAt ?? ""]));
    // Only the newcomers are sorted, and only against each other: the rows
    // already on screen keep the indices they had.
    arrived.sort((a, b) => (createdAt.get(b) ?? "").localeCompare(createdAt.get(a) ?? ""));
    setOrder([...order, ...arrived]);
  }

  const listed = useMemo(() => {
    const byId = new Map(sessions.map((s) => [s.id, s]));
    return order.map((id) => byId.get(id)).filter((s): s is SessionInfo => s !== undefined);
  }, [sessions, order]);

  if (listed.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-1 px-4 py-8">
        <p className="text-xs text-(--color-text-tertiary) text-center">Nothing needs you.</p>
        <p className="text-[11px] text-(--color-text-tertiary) text-center opacity-70">
          Sessions appear here when the next move is yours.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      {listed.map((session) => (
        <div key={session.id} className={attentionIds.has(session.id) ? "" : "opacity-60"}>
          <SessionItem
            session={session}
            isCurrent={session.id === currentSessionId}
            onResume={onResume}
            onSelectCurrent={onSelectCurrent}
            onArchive={onArchive}
            // The repo NAME, not `owner/repo`: req 12 asks for the name, the
            // approved drawing shows the name, and `owner/repo` is wide enough
            // in a 240px rail to truncate itself and wrap the date beside it.
            // (`AllSessionsDialog` passes the fuller label — it has a dialog's
            // width to spend.)
            repoLabel={session.remoteUrl ? parseRepoName(session.remoteUrl) : undefined}
            isTouch={isTouch}
          />
        </div>
      ))}
    </div>
  );
}
