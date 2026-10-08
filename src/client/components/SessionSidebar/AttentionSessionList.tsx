import { useMemo, useState } from "react";
import { ClockIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import { parseRepoName } from "../../utils/repo-label.js";
import { scheduleNeedsYou } from "../../stores/schedule-store.js";
import { ATTENTION_MARKER_STYLE, SessionItem } from "./SessionItem.js";
import type { ScheduleView, SessionInfo } from "../../../server/shared/types.js";

interface AttentionSessionListProps {

  sessions: SessionInfo[];

  attentionIds: Set<string>;
  /** Every schedule: one whose start failed is a row of its own (docs/324-scheduled-sessions req 31). */
  schedules: ScheduleView[];
  onOpenSchedule: (scheduleId: string) => void;
  currentSessionId: string | undefined;
  onResume: (sessionId: string) => void;
  onSelectCurrent?: () => void;
  onArchive?: (sessionId: string) => void;
  isTouch?: boolean;
}

type AttentionRow =
  | { kind: "session"; key: string; session: SessionInfo }
  | { kind: "schedule"; key: string; schedule: ScheduleView };

/** Schedule ids and session ids share the order list, so a schedule's key says what it is. */
const scheduleKey = (scheduleId: string) => `schedule:${scheduleId}`;

/**
 * docs/260 — the sidebar's second view: one flat list of the sessions that need
 * the user, with no repository grouping and no headers (reqs 2, 3, 6).
 *
 * **The rows are not new.** Each is the same `SessionItem` the first view
 * renders, with `repoLabel` set — the identical call `AllSessionsDialog` already
 * makes for its cross-repo list. So the reason a session needs attention is
 * shown exactly the way it is shown today (the status dot, the docs/187 marker
 * and the row tooltip) and is not restated as text (req 11), and the repository
 * name comes for free (req 12). The one other row is a schedule whose start
 * failed (docs/324-scheduled-sessions req 31): it has no row in the first view,
 * so it shows its name and the reason, and opens Settings → Schedules at it.
 *
 * **Order is arrival order, and it is append-only** (req 7). The rows present
 * when the view opens are seeded by `createdAt` descending — the only key in the
 * session model that never changes, and already the first view's within-repo
 * order. A session that starts needing attention later is **appended**, never
 * inserted, so no row on screen ever moves. A `createdAt` sort alone would not
 * give that: a newly-qualifying session lands in its date slot and pushes every
 * row below it down, which is exactly the motion req 7 forbids. (Sorting by
 * urgency was rejected for the same reason, one step worse: it re-orders on
 * every reason change.) Schedule rows share the one order, by their own `createdAt`.
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
 * you, not about outliving the session itself. A deleted schedule is dropped the same way.
 */
export function AttentionSessionList({
  sessions,
  attentionIds,
  schedules,
  onOpenSchedule,
  currentSessionId,
  onResume,
  onSelectCurrent,
  onArchive,
  isTouch,
}: AttentionSessionListProps) {

  // Adjusted during render, not in a ref or an effect: an abandoned render's `setOrder` is
  // discarded with it, and an effect would paint the list once without a row that qualifies.
  const [order, setOrder] = useState<string[]>([]);
  const needing = useMemo(
    () => new Set([...attentionIds, ...schedules.filter(scheduleNeedsYou).map((s) => scheduleKey(s.id))]),
    [attentionIds, schedules],
  );
  const arrived = [...needing].filter((key) => !order.includes(key));
  if (arrived.length > 0) {
    const createdAt = new Map([
      ...sessions.map((s) => [s.id, s.createdAt ?? ""] as const),
      ...schedules.map((s) => [scheduleKey(s.id), s.createdAt] as const),
    ]);

    arrived.sort((a, b) => (createdAt.get(b) ?? "").localeCompare(createdAt.get(a) ?? ""));
    setOrder([...order, ...arrived]);
  }

  const listed = useMemo(() => {
    const byKey = new Map<string, AttentionRow>([
      ...sessions.map((session) => [session.id, { kind: "session", key: session.id, session }] as const),
      ...schedules.map((schedule) => {
        const key = scheduleKey(schedule.id);
        return [key, { kind: "schedule", key, schedule }] as const;
      }),
    ]);
    return order.map((key) => byKey.get(key)).filter((row): row is AttentionRow => row !== undefined);
  }, [sessions, schedules, order]);

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
      {listed.map((row) => (
        <div key={row.key} className={needing.has(row.key) ? "" : "opacity-60"}>
          {row.kind === "session" ? (
            <SessionItem
              session={row.session}
              isCurrent={row.session.id === currentSessionId}
              onResume={onResume}
              onSelectCurrent={onSelectCurrent}
              onArchive={onArchive}

              repoLabel={row.session.remoteUrl ? parseRepoName(row.session.remoteUrl) : undefined}
              isTouch={isTouch}
            />
          ) : (
            <ScheduleAttentionItem schedule={row.schedule} onOpen={onOpenSchedule} />
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * A schedule whose start failed, in the shape of a `SessionItem` row: the same two lines, the
 * marker while it needs the user. The second line keeps its tag after the reason clears, so a
 * settled row keeps its height and no row below it moves (req 7).
 */
function ScheduleAttentionItem({ schedule, onOpen }: { schedule: ScheduleView; onOpen: (scheduleId: string) => void }) {
  const reason = schedule.needsUserReason;
  return (
    <button
      type="button"
      onClick={() => onOpen(schedule.id)}
      className="flex w-[calc(100%-0.5rem)] items-start gap-1.5 rounded mx-1 px-2 py-1.5 text-left text-xs text-(--color-text-secondary) transition-colors hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)"
      style={reason ? ATTENTION_MARKER_STYLE : undefined}
      title={reason ? `Could not start: ${reason}` : undefined}
      data-testid="schedule-attention-item"
    >
      <span
        className={`w-5 h-5 rounded-md flex items-center justify-center shrink-0 border border-(--color-border-secondary) ${
          reason ? "bg-(--color-warning-subtle) text-(--color-warning)" : "bg-(--color-bg-tertiary) text-(--color-text-tertiary)"
        }`}
      >
        <ClockIcon size={ICON_SIZE.SM} />
      </span>
      <span className="flex-1 min-w-0">
        <p className="truncate leading-snug">{schedule.name}</p>
        <span className="flex items-center gap-1.5 mt-0.5">
          <span className="text-[9px] font-semibold uppercase tracking-wide text-(--color-text-tertiary) border border-(--color-border-secondary) rounded px-1 leading-tight shrink-0">
            schedule
          </span>
          {reason && <span className="truncate text-[10px] text-(--color-text-tertiary)">{reason}</span>}
        </span>
      </span>
    </button>
  );
}
