// eslint-disable-next-line no-restricted-imports -- useEffect: read the schedules if no connection has yet, and Delete's list of unfinished runs (external system sync)
import { useCallback, useEffect, useState } from "react";
import {
  ClockIcon,
  CaretDownIcon,
  CaretRightIcon,
  PauseIcon,
  PencilSimpleIcon,
  PlayCircleIcon,
  PlayIcon,
  TrashIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../../../design-tokens.js";
import { Badge } from "../../ui/badge.js";
import { Button } from "../../ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../ui/dialog.js";
import { DropdownMenuItem } from "../../ui/dropdown-menu.js";
import { OverflowMenu } from "../../ui/overflow-menu.js";
import { useUiStore } from "../../../stores/ui-store.js";
import {
  deleteSchedule,
  fetchUnfinishedRuns,
  runScheduleNow,
  ScheduleRequestError,
  setSchedulePaused,
  stopScheduleRun,
  useScheduleStore,
} from "../../../stores/schedule-store.js";
import { START_PARAM_LABELS } from "../../../../server/shared/session-start-labels.js";
import { nextRuns } from "../../../../server/shared/schedule-timing.js";
import type { ScheduleView, SessionStartParams, UnfinishedScheduleRun } from "../../../../server/shared/types.js";
import { ScheduleEditor } from "./ScheduleEditor.js";
import { ScheduleRuns, useRunSessionChanges } from "./ScheduleRuns.js";
import { browserTimeZone, formatRunTime, targetInWords } from "./schedule-format.js";
import { describeTiming } from "../../../../server/shared/schedule-describe.js";

const STOPPING_RECHECK_MS = 3000;

/**
 * docs/324-scheduled-sessions — Settings → Schedules (reqs 10, 11, 19, 24, 26, 32, 33): every
 * schedule, its runs, and Run now, Pause, Edit and Delete. Schedules are made by asking the
 * agent in chat (req 8), so this view has no "New" control.
 */
export function SchedulesSettings({ onOpenSession }: { onOpenSession?: (sessionId: string) => void }) {
  const schedules = useScheduleStore((s) => s.schedules);
  const loaded = useScheduleStore((s) => s.loaded);
  const focusId = useUiStore((s) => s.settingsScheduleId);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(focusId ? [focusId] : []));
  const [editing, setEditing] = useState<ScheduleView | null>(null);
  const [warning, setWarning] = useState<{ schedule: ScheduleView; runs: UnfinishedScheduleRun[] } | null>(null);
  const [deleting, setDeleting] = useState<ScheduleView | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // eslint-disable-next-line no-restricted-syntax -- external system sync: the server connection reads them, but may not have yet
  useEffect(() => {
    if (!useScheduleStore.getState().loaded) void useScheduleStore.getState().load();
  }, []);

  const focusRef = useCallback((el: HTMLElement | null) => { el?.scrollIntoView?.({ block: "nearest" }); }, []);

  const expand = (id: string, open = true) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });

  const act = async (schedule: ScheduleView, what: string, fn: () => Promise<void>) => {
    setBusyId(schedule.id);
    try {
      await fn();
    } catch (err) {
      useUiStore.getState().setToast({ message: err instanceof Error ? err.message : `Failed to ${what}` });
    } finally {
      setBusyId(null);
    }
  };

  const startRun = async (schedule: ScheduleView) => {
    await runScheduleNow(schedule.id);
    expand(schedule.id);
  };

  // Req 26 — no restriction, but a warning while any run is not finished.
  const runNow = (schedule: ScheduleView) =>
    act(schedule, "start the run", async () => {
      const runs = await fetchUnfinishedRuns(schedule.id);
      if (runs.length > 0) setWarning({ schedule, runs });
      else await startRun(schedule);
    });

  return (
    <div className="flex flex-col gap-3" data-testid="schedules-settings">
      <div>
        <h3 className="flex items-center gap-1.5 text-sm font-medium text-(--color-text-primary)">
          <ClockIcon size={ICON_SIZE.SM} className="shrink-0 text-(--color-text-tertiary)" aria-hidden />
          Schedules
        </h3>
        <p className="mt-0.5 text-xs text-(--color-text-tertiary)">
          Sessions ShipIt starts by itself at set times, each with its own target, model and prompt.
          To set one up or change one, ask the agent in any session; you confirm it on a card.
        </p>
      </div>

      {!loaded ? (
        <p className="text-xs text-(--color-text-tertiary)">Reading the schedules…</p>
      ) : schedules.length === 0 ? (
        <p
          className="rounded-md border border-dashed border-(--color-border-secondary) p-6 text-center text-sm text-(--color-text-secondary)"
          data-testid="schedules-empty"
        >
          No schedules yet. Ask the agent in a session — for example, &ldquo;Every weekday at 9, check the
          open security PRs and merge the ones that pass CI.&rdquo;
        </p>
      ) : (
        schedules.map((schedule) => (
          <ScheduleCard
            key={schedule.id}
            ref={schedule.id === focusId ? focusRef : undefined}
            schedule={schedule}
            focused={schedule.id === focusId}
            expanded={expanded.has(schedule.id)}
            busy={busyId === schedule.id}
            onToggle={() => expand(schedule.id, !expanded.has(schedule.id))}
            onRunNow={() => void runNow(schedule)}
            onPause={() => void act(schedule, schedule.enabled ? "pause the schedule" : "resume the schedule",
              () => setSchedulePaused(schedule.id, schedule.enabled))}
            onEdit={() => setEditing(schedule)}
            onDelete={() => setDeleting(schedule)}
            onOpenSession={onOpenSession}
          />
        ))
      )}

      {editing && <ScheduleEditor key={editing.id} schedule={editing} onClose={() => setEditing(null)} />}

      {warning && (
        <RunNowWarning
          schedule={warning.schedule}
          runs={warning.runs}
          onCancel={() => setWarning(null)}
          onRunAnyway={() => {
            const { schedule } = warning;
            setWarning(null);
            void act(schedule, "start the run", () => startRun(schedule));
          }}
        />
      )}

      {deleting && <DeleteScheduleDialog key={deleting.id} schedule={deleting} onClose={() => setDeleting(null)} />}
    </div>
  );
}

/** Worked out here: the list's copy is from when the schedule last changed, and runs have passed since. */
function nextRunOf(schedule: ScheduleView): Date | string | undefined {
  if (!schedule.enabled) return undefined;
  try {
    return nextRuns(schedule.timing, schedule.timeZone, 1)[0];
  } catch {
    return schedule.nextRuns[0];
  }
}

/** What the run starts on, in the words `START_PARAM_LABELS` gives the cards. */
function startParamsInWords(params: SessionStartParams): string {
  if (params.role) return `Role ${START_PARAM_LABELS.role.describe(params.role)}`;
  const parts = [
    params.model ? START_PARAM_LABELS.model.describe(params.model) : params.agent ? START_PARAM_LABELS.agent.describe(params.agent) : null,
    params.reasoning ? START_PARAM_LABELS.reasoning.describe(params.reasoning) : null,
    params.permissionMode ? START_PARAM_LABELS.permissionMode.describe(params.permissionMode) : null,
  ].filter((part): part is string => !!part);
  return parts.length > 0 ? parts.join(" · ") : "Default model";
}

function ScheduleCard({
  ref,
  schedule,
  focused,
  expanded,
  busy,
  onToggle,
  onRunNow,
  onPause,
  onEdit,
  onDelete,
  onOpenSession,
}: {
  ref?: (el: HTMLElement | null) => void;
  schedule: ScheduleView;
  focused: boolean;
  expanded: boolean;
  busy: boolean;
  onToggle: () => void;
  onRunNow: () => void;
  onPause: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const next = nextRunOf(schedule);
  const zone = schedule.timeZone === browserTimeZone() ? "" : ` (${schedule.timeZone})`;
  const Caret = expanded ? CaretDownIcon : CaretRightIcon;
  return (
    <section
      ref={ref}
      className={`shrink-0 overflow-hidden rounded-md border ${
        focused ? "border-(--color-border-focus)" : "border-(--color-border-secondary)"
      }`}
      data-testid={`schedule-${schedule.id}`}
    >
      <div className="flex items-start gap-2 p-3">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? `Hide the runs of ${schedule.name}` : `Show the runs of ${schedule.name}`}
          className="mt-0.5 shrink-0 rounded text-(--color-text-tertiary) hover:text-(--color-text-primary)"
          data-testid={`schedule-toggle-${schedule.id}`}
        >
          <Caret size={ICON_SIZE.SM} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="truncate text-sm font-medium text-(--color-text-primary)">{schedule.name}</h4>
            {!schedule.enabled && (
              <Badge className="px-1.5 text-[10px]" data-testid={`schedule-paused-${schedule.id}`}>Paused</Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs text-(--color-text-secondary)">
            {describeTiming(schedule.timing)}{zone}
            {next && (
              <span className="text-(--color-text-tertiary)"> · next {formatRunTime(next)}{zone && " your time"}</span>
            )}
          </p>
          <p className="mt-0.5 truncate text-xs text-(--color-text-tertiary)">
            {schedule.spec
              ? `${targetInWords(schedule.spec.target)} · ${startParamsInWords(schedule.spec.params)}`
              : "ShipIt cannot read what this schedule starts. Edit it to set it again."}
          </p>
          {schedule.needsUserReason && (
            <p
              className="mt-1 flex items-start gap-1.5 text-xs text-(--color-warning)"
              data-testid={`schedule-needs-user-${schedule.id}`}
            >
              <WarningIcon size={ICON_SIZE.XS} className="mt-0.5 shrink-0" />
              <span>Could not start: {schedule.needsUserReason}</span>
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onRunNow} disabled={busy} data-testid={`schedule-run-now-${schedule.id}`}>
            <PlayIcon size={ICON_SIZE.XS} />
            Run now
          </Button>
          <Button variant="ghost" size="sm" onClick={onPause} disabled={busy} data-testid={`schedule-pause-${schedule.id}`}>
            {schedule.enabled ? <PauseIcon size={ICON_SIZE.XS} /> : <PlayCircleIcon size={ICON_SIZE.XS} />}
            {schedule.enabled ? "Pause" : "Resume"}
          </Button>
          <OverflowMenu label={`More for ${schedule.name}`} portaled={false}>
            <DropdownMenuItem onSelect={onEdit} data-testid={`schedule-edit-${schedule.id}`}>
              <PencilSimpleIcon size={ICON_SIZE.XS} />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onDelete} data-testid={`schedule-delete-${schedule.id}`}>
              <TrashIcon size={ICON_SIZE.XS} />
              Delete
            </DropdownMenuItem>
          </OverflowMenu>
        </div>
      </div>
      {expanded && (
        <div className="border-t border-(--color-border-secondary) bg-(--color-bg-secondary)">
          <ScheduleRuns scheduleId={schedule.id} onOpenSession={onOpenSession} />
        </div>
      )}
    </section>
  );
}

function RunList({ runs, onStop }: { runs: UnfinishedScheduleRun[]; onStop?: (run: UnfinishedScheduleRun) => void }) {
  return (
    <ul className="flex flex-col gap-1 text-xs" data-testid="schedule-unfinished-runs">
      {runs.map((run) => (
        <li key={run.runId} className="flex items-center gap-2 rounded-md bg-(--color-bg-secondary) px-2.5 py-1.5">
          <span className="min-w-0 flex-1 truncate text-(--color-text-primary)">{run.title}</span>
          {run.archived && <span className="text-(--color-text-tertiary)">archived</span>}
          {run.stopping ? (
            <span className="text-(--color-text-tertiary)">stopping…</span>
          ) : onStop && (
            <button
              type="button"
              onClick={() => onStop(run)}
              className="text-(--color-text-link) hover:underline"
              data-testid={`schedule-unfinished-stop-${run.runId}`}
            >
              Stop
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Req 26 — Run now is never refused, but the user hears first that earlier runs are not finished. */
function RunNowWarning({
  schedule,
  runs,
  onCancel,
  onRunAnyway,
}: {
  schedule: ScheduleView;
  runs: UnfinishedScheduleRun[];
  onCancel: () => void;
  onRunAnyway: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="max-w-md w-full" data-testid="schedule-run-now-warning">
        <DialogHeader>
          <DialogTitle>Start another run of {schedule.name}?</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 px-5 py-4">
          <DialogDescription>
            {runs.length === 1 ? "This run is" : `These ${runs.length} runs are`} not finished yet.
            Run now starts a new run anyway.
          </DialogDescription>
          <RunList runs={runs} />
        </div>
        <DialogFooter className="gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} data-testid="schedule-run-now-cancel">Cancel</Button>
          <Button variant="primary" size="sm" onClick={onRunAnyway} data-testid="schedule-run-anyway">Run anyway</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Req 32 — refused, with each run to stop, while any run is not finished. */
function DeleteScheduleDialog({ schedule, onClose }: { schedule: ScheduleView; onClose: () => void }) {
  const [runs, setRuns] = useState<UnfinishedScheduleRun[] | null>(null);
  const [busy, setBusy] = useState(false);

  const reread = useCallback(async () => {
    try {
      setRuns(await fetchUnfinishedRuns(schedule.id));
    } catch (err) {
      // Delete stays disabled: the dialog cannot say whether a run holds it back.
      useUiStore.getState().setToast({ message: err instanceof Error ? err.message : "Failed to read the runs" });
    }
  }, [schedule.id]);

  const changes = useRunSessionChanges(schedule.id);
  // eslint-disable-next-line no-restricted-syntax -- external system sync: which runs hold back Delete is the server's to say
  useEffect(() => { void reread(); }, [reread, changes]);

  // A stopped run winds down without a change the browser follows when it is archived.
  const windingDown = !!runs?.some((run) => run.stopping);
  // eslint-disable-next-line no-restricted-syntax -- external system sync: ask again until the stopped runs have wound down
  useEffect(() => {
    if (!windingDown) return;
    const timer = setInterval(() => { void reread(); }, STOPPING_RECHECK_MS);
    return () => clearInterval(timer);
  }, [windingDown, reread]);

  const stop = async (run: UnfinishedScheduleRun) => {
    try {
      await stopScheduleRun(schedule.id, run.runId);
    } catch (err) {
      useUiStore.getState().setToast({ message: err instanceof Error ? err.message : "Failed to stop the run" });
    }
    await reread();
  };

  const remove = async () => {
    setBusy(true);
    try {
      await deleteSchedule(schedule.id);
      onClose();
    } catch (err) {
      if (err instanceof ScheduleRequestError && err.runs) setRuns(err.runs);
      else useUiStore.getState().setToast({ message: err instanceof Error ? err.message : "Failed to delete the schedule" });
    } finally {
      setBusy(false);
    }
  };

  const refused = !!runs && runs.length > 0;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md w-full" data-testid="schedule-delete-dialog">
        <DialogHeader>
          <DialogTitle>Delete {schedule.name}?</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 px-5 py-4">
          <DialogDescription>
            {runs === null
              ? "Checking its runs…"
              : refused
                ? "This schedule still has runs that are not finished. Stop them to delete it."
                : "The schedule and its run history are removed. Its run sessions stay, and say that their schedule was deleted."}
          </DialogDescription>
          {refused && (
            <div data-testid="schedule-delete-refused">
              <RunList runs={runs} onStop={(run) => void stop(run)} />
            </div>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} data-testid="schedule-delete-cancel">Cancel</Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={busy || runs === null || refused}
            onClick={() => void remove()}
            data-testid="schedule-delete-confirm"
          >
            {busy ? "Deleting…" : "Delete schedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
