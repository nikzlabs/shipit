import type { ScheduleProposalPhase } from "../../shared/types.js";
import { renderOwn } from "../../shared/settings-catalogue/index.js";
import type { ScheduleProposalStore } from "../schedule-proposal-store.js";
import { prepareCardOutcomeNotice, type CardOutcomeKind, type CardOutcomeNotice } from "./card-outcome-notice.js";

/**
 * Tells the agent, at the start of its next turn, what the user decided on its schedule proposals
 * (docs/324-scheduled-sessions req 9), through the shared at-least-once notice. It carries ids and
 * phases only: the name and the values are text the agent supplied, and `shipit schedule list` is
 * the authority for what a schedule is now.
 */

export interface ResolvedScheduleOutcome {
  cardId: string;
  kind: "create" | "update";
  phase: ScheduleProposalPhase;
  scheduleId?: string;
}

export interface ScheduleOutcomeNoticeDeps {
  proposals: Pick<ScheduleProposalStore, "listUnnotifiedResolved" | "markAgentNotified">;
}

function describe(outcome: ResolvedScheduleOutcome): string {
  const id = outcome.scheduleId ? ` \`${outcome.scheduleId}\`` : "";
  const what = outcome.kind === "create" ? "A new schedule" : `A change to schedule${id}`;
  let result: string;
  switch (outcome.phase) {
    case "confirmed":
      result = outcome.kind === "create" ? `confirmed; ShipIt created schedule${id}.` : "confirmed and saved.";
      break;
    case "cancelled":
      result = "cancelled by the user. Nothing was saved.";
      break;
    case "stale":
      result = "not saved: the schedule changed after the card was written.";
      break;
    case "refused":
      result = "not saved: ShipIt could no longer accept it. The card shows the user why.";
      break;
    default:
      result = "resolved.";
  }
  return renderOwn(`- ${what} (card ${outcome.cardId}) — ${result}`);
}

export const SCHEDULE_OUTCOME: CardOutcomeKind<ResolvedScheduleOutcome, ScheduleOutcomeNoticeDeps> = {
  tag: "schedule-outcome",
  pending: (deps, sessionId) =>
    deps.proposals.listUnnotifiedResolved(sessionId).map((record) => ({
      cardId: record.cardId,
      kind: record.proposal.kind,
      phase: record.phase,
      ...(record.scheduleId ? { scheduleId: record.scheduleId } : {}),
    })),
  markNotified: (deps, sessionId, cardIds) => deps.proposals.markAgentNotified(sessionId, cardIds),
  opener: (count) =>
    count === 1
      ? "[ShipIt] Since your last turn, the user resolved a schedule proposal you posted:"
      : "[ShipIt] Since your last turn, the user resolved schedule proposals you posted:",
  describe,
  nextStep:
    "This is a status line from ShipIt, not part of the user's message. `shipit schedule list` is the"
    + " authority for what each schedule is now: read it before you act on this, and do not post the same"
    + " proposal again unless the user asks. No acknowledgement is needed unless it changes what you were"
    + " about to do.",
};

export function prepareScheduleOutcomeNotice(
  deps: ScheduleOutcomeNoticeDeps,
  sessionId: string,
): CardOutcomeNotice | null {
  return prepareCardOutcomeNotice(SCHEDULE_OUTCOME, deps, sessionId);
}
