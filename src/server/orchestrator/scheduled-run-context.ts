import type { RuntimeMode } from "./app-di.js";
import type { ScheduleStore } from "./schedule-store.js";
import type { SessionManager } from "./sessions.js";
import { fillPromptTokens, loadPrompt } from "./load-prompt.js";
import { RUN_NOTES_CONTAINER_DIR, type ScheduleNotes } from "./schedule-notes.js";
import { formatInZone } from "../shared/schedule-timing.js";

/** docs/324-scheduled-sessions → "The run's first message and its notes" (req 13). */
const SCHEDULED_RUN_TEMPLATE = loadPrompt(import.meta.url, "./prompts/scheduled-run.md");

export interface ScheduledRunBlock {
  name: string;
  scheduleId: string;
  runAt: string;
  notesDir: string;
}

export function renderScheduledRunBlock(block: ScheduledRunBlock): string {
  return fillPromptTokens(SCHEDULED_RUN_TEMPLATE, {
    NAME: JSON.stringify(block.name),
    SCHEDULE_ID: block.scheduleId,
    RUN_AT: block.runAt,
    NOTES_DIR: block.notesDir,
  }).trim();
}

export interface ScheduledRunContextDeps {
  sessionManager: Pick<SessionManager, "get">;
  store: Pick<ScheduleStore, "get" | "getRun">;
  notes: Pick<ScheduleNotes, "runDir">;
  runtimeMode: RuntimeMode;
}

/**
 * The `<scheduled_run>` block for the run's first dispatch, which carries the run's id as its
 * delivery id — also when recovery sends that prompt again. It rides the prompt the way role
 * standing instructions do, so the system prompt stays byte-stable. Local mode has no container,
 * so the block names the folder's host path.
 */
export function scheduledRunContext(
  deps: ScheduledRunContextDeps,
  sessionId: string,
  deliveryId: string | undefined,
): string {
  if (deliveryId === undefined) return "";
  const session = deps.sessionManager.get(sessionId);
  if (!session?.scheduleId || session.scheduleRunId !== deliveryId) return "";
  const schedule = deps.store.get(session.scheduleId);
  const run = deps.store.getRun(deliveryId);
  if (!schedule || !run) return "";
  const timeZone = run.timeZone ?? schedule.timeZone;
  return renderScheduledRunBlock({
    name: schedule.name,
    scheduleId: schedule.id,
    runAt: `${formatInZone(new Date(run.slotAt ?? run.createdAt), timeZone)} (${timeZone})`,
    notesDir: deps.runtimeMode === "local" ? deps.notes.runDir(schedule.id, run.id) : RUN_NOTES_CONTAINER_DIR,
  });
}
