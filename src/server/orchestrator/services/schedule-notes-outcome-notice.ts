import type { ScheduleNotesAccessPhase } from "../../shared/types.js";
import { renderOwn } from "../../shared/settings-catalogue/index.js";
import type { ScheduleNotesRequestStore } from "../schedule-notes-request-store.js";
import { prepareCardOutcomeNotice, type CardOutcomeKind, type CardOutcomeNotice } from "./card-outcome-notice.js";

/**
 * Tells the agent, at the start of its next turn, what the user decided on its requests to read
 * a schedule's notes (docs/324-scheduled-sessions reqs 28, 30). Ids and phases only.
 */

export interface ResolvedNotesAccess {
  cardId: string;
  scheduleId: string;
  phase: ScheduleNotesAccessPhase;
}

export interface ScheduleNotesOutcomeNoticeDeps {
  requests: Pick<ScheduleNotesRequestStore, "listUnnotifiedResolved" | "markAgentNotified">;
}

function describe(outcome: ResolvedNotesAccess): string {
  const result = outcome.phase === "allowed"
    ? `allowed for this session: \`shipit schedule notes ${outcome.scheduleId}\` reads them now.`
    : "denied. Do not ask again unless the user asks you to.";
  return renderOwn(`- Reading the notes of schedule \`${outcome.scheduleId}\` (card ${outcome.cardId}) — ${result}`);
}

export const SCHEDULE_NOTES_OUTCOME: CardOutcomeKind<ResolvedNotesAccess, ScheduleNotesOutcomeNoticeDeps> = {
  tag: "schedule-notes-outcome",
  pending: (deps, sessionId) =>
    deps.requests.listUnnotifiedResolved(sessionId).map((record) => ({
      cardId: record.cardId,
      scheduleId: record.scheduleId,
      phase: record.phase,
    })),
  markNotified: (deps, sessionId, cardIds) => deps.requests.markAgentNotified(sessionId, cardIds),
  opener: (count) =>
    count === 1
      ? "[ShipIt] Since your last turn, the user decided on your request to read a schedule's notes:"
      : "[ShipIt] Since your last turn, the user decided on your requests to read schedules' notes:",
  describe,
  nextStep:
    "This is a status line from ShipIt, not part of the user's message. No acknowledgement is needed"
    + " unless it changes what you were about to do.",
};

export function prepareScheduleNotesOutcomeNotice(
  deps: ScheduleNotesOutcomeNoticeDeps,
  sessionId: string,
): CardOutcomeNotice | null {
  return prepareCardOutcomeNotice(SCHEDULE_NOTES_OUTCOME, deps, sessionId);
}
