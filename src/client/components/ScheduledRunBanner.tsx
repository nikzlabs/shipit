// eslint-disable-next-line no-restricted-imports -- useEffect: read All sessions when the open session is in no list (external system sync)
import { useEffect, useState } from "react";
import { ClockIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { useUiStore } from "../stores/ui-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { openScheduleSettings, stopScheduleRun, useScheduleStore } from "../stores/schedule-store.js";
import { formatRunTime, formatScheduleRunTime } from "./Settings/schedules/schedule-format.js";
import type { SessionListRow } from "../../server/shared/types.js";

/**
 * docs/324-scheduled-sessions req 25 — which schedule started this run, with a way back to
 * it and Stop while the run is not finished (req 33). Derived chrome like `SandboxBanner`:
 * it renders from the session row, so nothing of it is in the transcript. After the
 * schedule is deleted it says so and has no controls (req 32).
 */
export function ScheduledRunLine({ session }: { session: SessionListRow }) {
  const loaded = useScheduleStore((s) => s.loaded);
  const schedule = useScheduleStore((s) => s.schedules.find((x) => x.id === session.scheduleId));
  const [stopping, setStopping] = useState(false);
  // Until the schedules are read, "deleted" cannot be told from "not read yet".
  if (!loaded || !session.scheduleId) return null;

  if (!schedule) {
    return (
      <div className="flex items-center gap-2 text-[12.5px] text-(--color-text-secondary)" data-testid="scheduled-run-banner">
        <ClockIcon size={ICON_SIZE.SM} className="shrink-0 text-(--color-text-tertiary)" />
        <span className="min-w-0">Started by a schedule that was deleted · {formatRunTime(session.createdAt)}</span>
      </div>
    );
  }

  const when = formatScheduleRunTime(session.createdAt, schedule.timeZone);
  const runId = session.scheduleRunId;
  const stop = async () => {
    if (!runId) return;
    setStopping(true);
    try {
      await stopScheduleRun(schedule.id, runId);
    } catch (err) {
      useUiStore.getState().setToast({ message: err instanceof Error ? err.message : "Failed to stop the run" });
    } finally {
      setStopping(false);
    }
  };

  return (
    <div className="flex items-center gap-2 text-[12.5px] text-(--color-text-secondary)" data-testid="scheduled-run-banner">
      <ClockIcon size={ICON_SIZE.SM} className="shrink-0 text-(--color-accent)" />
      <span className="min-w-0 flex-1">
        Started by schedule <span className="font-semibold text-(--color-text-primary)">{schedule.name}</span> · {when}
      </span>
      <button
        type="button"
        onClick={() => openScheduleSettings(schedule.id)}
        className="shrink-0 text-[11.5px] font-medium text-(--color-text-link) hover:underline"
        data-testid="scheduled-run-open-schedule"
      >
        Open schedule
      </button>
      {runId && !session.runFinishedAt && !session.runStoppedAt && (
        <button
          type="button"
          onClick={() => void stop()}
          disabled={stopping}
          className="shrink-0 text-[11.5px] font-medium text-(--color-text-link) hover:underline disabled:opacity-50"
          data-testid="scheduled-run-stop"
        >
          {stopping ? "Stopping…" : "Stop run"}
        </button>
      )}
    </div>
  );
}

/**
 * The open session's row from any list that has it. A finished run past the sidebar's cap, or
 * an archived one, is not in the session list; its banner still has to say where it came
 * from (req 25), so the history's copy of it, or All sessions, stands in.
 */
export function useAnyListSessionRow(sessionId: string | undefined): SessionListRow | undefined {
  const bootstrapLoaded = useUiStore((s) => s.bootstrapLoaded);
  const row = useSessionStore((s) =>
    sessionId
      ? s.sessions.find((x) => x.id === sessionId) ?? s.allSessions.find((x) => x.id === sessionId)
      : undefined,
  );
  const fromHistory = useScheduleStore((s) => {
    if (!sessionId || row) return undefined;
    for (const runs of Object.values(s.runsBySchedule)) {
      const run = runs.find((r) => r.sessionId === sessionId && r.session);
      if (run) return run.session;
    }
    return undefined;
  });
  const missing = !!sessionId && bootstrapLoaded && !row && !fromHistory;

  // eslint-disable-next-line no-restricted-syntax -- external system sync: All sessions is the server's list
  useEffect(() => {
    if (!missing) return;
    useSessionStore.getState().fetchAllSessions().catch((err: unknown) => {
      console.error("[sessions] failed to read All sessions:", err);
    });
  }, [missing, sessionId]);

  return row ?? fromHistory;
}

/** False until the schedules are read, when the line has nothing to say yet. */
export function useScheduledRunLineShown(session: SessionListRow | undefined): boolean {
  const loaded = useScheduleStore((s) => s.loaded);
  return loaded && !!session?.scheduleId;
}

/** The line on a bar of its own, for a run in a repository; a sandbox run puts it in `SandboxBanner`. */
export function ScheduledRunBanner({ session }: { session: SessionListRow }) {
  const shown = useScheduledRunLineShown(session);
  if (!shown) return null;
  return (
    <div className="px-3 pt-1.5 pb-1">
      <div className="rounded-lg border border-(--color-border-secondary) bg-(--color-accent-subtle) px-3.5 py-2">
        <ScheduledRunLine session={session} />
      </div>
    </div>
  );
}
