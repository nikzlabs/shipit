// eslint-disable-next-line no-restricted-imports -- useEffect: read the run history when it is shown, and again when a run's session changes (external system sync)
import { useEffect, useState } from "react";
import { Badge } from "../../ui/badge.js";
import { useSessionStore } from "../../../stores/session-store.js";
import { useUiStore } from "../../../stores/ui-store.js";
import { RUNS_PAGE, stopScheduleRun, useScheduleStore } from "../../../stores/schedule-store.js";
import { useAttentionInfo } from "../../../hooks/useAttentionInfo.js";
import { formatRunTime } from "./schedule-format.js";
import { runState, type RunState, type RunStateKind } from "./run-state.js";
import type { ScheduleRunView, SessionListRow } from "../../../../server/shared/types.js";

const STATE_VARIANT: Record<RunStateKind, "default" | "success" | "error" | "warning" | "info"> = {
  starting: "info",
  running: "info",
  "needs-you": "warning",
  finished: "success",
  stopping: "default",
  stopped: "default",
  skipped: "default",
  failed: "error",
  deleted: "default",
};

/**
 * docs/324-scheduled-sessions req 24 — one schedule's runs, newest first: time, state,
 * one-line result, and Stop (req 33) and Open while there is something to stop or open.
 */
export function ScheduleRuns({
  scheduleId,
  onOpenSession,
}: {
  scheduleId: string;
  onOpenSession?: (sessionId: string) => void;
}) {
  const runs = useScheduleStore((s) => s.runsBySchedule[scheduleId]);
  const limit = useScheduleStore((s) => s.runLimits[scheduleId] ?? RUNS_PAGE);
  // A run's result line is read from its session while it is not finished, so the history is
  // read again when one of them changes.
  const changes = useRunSessionChanges(scheduleId);

  // eslint-disable-next-line no-restricted-syntax -- external system sync: the run history lives on the server
  useEffect(() => {
    void useScheduleStore.getState().loadRuns(scheduleId);
  }, [scheduleId, changes]);

  if (!runs) {
    return <p className="px-3 py-2 text-xs text-(--color-text-tertiary)">Reading the runs…</p>;
  }
  if (runs.length === 0) {
    return (
      <p className="px-3 py-2 text-xs text-(--color-text-tertiary)" data-testid={`schedule-runs-empty-${scheduleId}`}>
        No runs yet.
      </p>
    );
  }
  return (
    <div>
      <ul className="divide-y divide-(--color-border-secondary)" data-testid={`schedule-runs-${scheduleId}`}>
        {runs.map((run) => (
          <RunRow key={run.id} run={run} onOpenSession={onOpenSession} />
        ))}
      </ul>
      {runs.length >= limit && (
        <button
          type="button"
          onClick={() => void useScheduleStore.getState().loadRuns(scheduleId, limit + RUNS_PAGE)}
          className="w-full border-t border-(--color-border-secondary) px-3 py-1.5 text-left text-xs text-(--color-text-link) hover:underline"
          data-testid={`schedule-runs-older-${scheduleId}`}
        >
          Show older runs
        </button>
      )}
    </div>
  );
}

/** Changes when one of the schedule's run sessions in the session list moves: a turn ends, a question waits, it finishes or stops. */
export function useRunSessionChanges(scheduleId: string): string {
  return useSessionStore((s) =>
    s.sessions
      .filter((session) => session.scheduleId === scheduleId)
      .map((session) =>
        [
          session.id,
          session.runFinishedAt,
          session.runStoppedAt,
          session.awaitingAnswer,
          session.lastTurnOutcome,
          s.activeRunnerSessions.has(session.id),
        ].join("|"),
      )
      .join(","),
  );
}

function RunRow({ run, onOpenSession }: { run: ScheduleRunView; onOpenSession?: (sessionId: string) => void }) {
  const live = useSessionStore((s) => (run.sessionId ? s.sessions.find((x) => x.id === run.sessionId) : undefined));
  const session = live ?? run.session;
  return session
    ? <RunRowWithSession run={run} session={session} onOpenSession={onOpenSession} />
    : <RunRowBody run={run} state={runState(run, undefined, null)} onOpenSession={onOpenSession} />;
}

function RunRowWithSession({
  run,
  session,
  onOpenSession,
}: {
  run: ScheduleRunView;
  session: SessionListRow;
  onOpenSession?: (sessionId: string) => void;
}) {
  const attention = useAttentionInfo(session);
  return (
    <RunRowBody
      run={run}
      state={runState(run, session, attention)}
      attention={attention}
      archived={!!(session.userArchived || session.archived)}
      onOpenSession={onOpenSession}
    />
  );
}

function RunRowBody({
  run,
  state,
  attention,
  archived,
  onOpenSession,
}: {
  run: ScheduleRunView;
  state: RunState;
  attention?: string | null;
  archived?: boolean;
  onOpenSession?: (sessionId: string) => void;
}) {
  const [stopping, setStopping] = useState(false);
  const shownResult = run.outcome === "skipped" || run.outcome === "failed" ? run.reason : run.result;
  const openId = run.sessionDeleted ? undefined : run.sessionId;

  const stop = async () => {
    setStopping(true);
    try {
      await stopScheduleRun(run.scheduleId, run.id);
    } catch (err) {
      useUiStore.getState().setToast({ message: err instanceof Error ? err.message : "Failed to stop the run" });
    } finally {
      setStopping(false);
    }
  };

  return (
    <li
      className="grid grid-cols-[8.5rem_6.5rem_minmax(0,1fr)_auto] items-center gap-2 px-3 py-1.5 text-xs"
      data-testid={`schedule-run-${run.id}`}
    >
      <span className="text-(--color-text-secondary)">{formatRunTime(run.slotAt ?? run.createdAt)}</span>
      <span className="flex items-center gap-1">
        <Badge
          variant={STATE_VARIANT[state.kind]}
          className="px-1.5 text-[10px]"
          title={state.kind === "needs-you" ? (attention ?? undefined) : undefined}
          data-testid={`schedule-run-state-${run.id}`}
        >
          {state.label}
        </Badge>
        {archived && <span className="text-[10px] text-(--color-text-tertiary)">archived</span>}
      </span>
      <span className="truncate text-(--color-text-secondary)" title={shownResult}>
        {shownResult ?? "—"}
      </span>
      <span className="flex items-center gap-2">
        {state.stoppable && (
          <button
            type="button"
            onClick={() => void stop()}
            disabled={stopping}
            className="text-(--color-text-link) hover:underline disabled:opacity-50"
            data-testid={`schedule-run-stop-${run.id}`}
          >
            {stopping ? "Stopping…" : "Stop"}
          </button>
        )}
        {openId && onOpenSession && (
          <button
            type="button"
            onClick={() => onOpenSession(openId)}
            className="text-(--color-text-link) hover:underline"
            data-testid={`schedule-run-open-${run.id}`}
          >
            Open
          </button>
        )}
      </span>
    </li>
  );
}
