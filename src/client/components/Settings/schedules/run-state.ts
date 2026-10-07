import type { ScheduleRunView, SessionListRow } from "../../../../server/shared/types.js";

/**
 * docs/324-scheduled-sessions req 24 — a run's state in its schedule's history. Starting,
 * Skipped and Failed come from the run's row; the rest from its session, whose saved
 * "finished" (req 22) is the one the sidebar and Delete read too.
 */

export type RunStateKind =
  | "starting"
  | "running"
  | "needs-you"
  | "finished"
  | "stopping"
  | "stopped"
  | "skipped"
  | "failed"
  | "deleted";

export interface RunState {
  kind: RunStateKind;
  label: string;
  /** Req 33 — Stop is offered while the run is not finished and not already stopped. */
  stoppable: boolean;
}

const LABELS: Record<RunStateKind, string> = {
  starting: "Starting",
  running: "Running",
  "needs-you": "Needs you",
  finished: "Finished",
  stopping: "Stopping",
  stopped: "Stopped",
  skipped: "Skipped",
  failed: "Failed",
  deleted: "Session deleted",
};

/**
 * `session` is the run's session row, the live one when the session lists hold it;
 * `attention` is what "needs you" says of it (`useAttentionInfo`).
 */
export function runState(
  run: Pick<ScheduleRunView, "outcome" | "sessionDeleted">,
  session: Pick<SessionListRow, "runFinishedAt" | "runStoppedAt"> | undefined,
  attention: string | null,
): RunState {
  const state = (kind: RunStateKind, stoppable = false): RunState => ({ kind, label: LABELS[kind], stoppable });
  if (run.outcome === "skipped") return state("skipped");
  if (run.outcome === "starting") return state("starting", true);
  if (run.sessionDeleted) return state("deleted");
  // A failed start may leave a session behind; until it is finished, it holds back Delete.
  const open = !!session && !session.runFinishedAt && !session.runStoppedAt;
  if (run.outcome === "failed") return state("failed", open);
  // Only a run started since the history was read has no row yet; the lists catch up.
  if (!session) return state("running", true);
  if (session.runStoppedAt) return state(session.runFinishedAt ? "stopped" : "stopping");
  if (session.runFinishedAt) return state("finished");
  return state(attention ? "needs-you" : "running", true);
}
