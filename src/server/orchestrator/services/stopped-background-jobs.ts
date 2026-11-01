// A one-shot CLI stops the background jobs that still run when its turn ends, and raises no
// completion notice for them, so ShipIt tells the agent (docs/235-agent-self-wake-liveness §9).

import { randomUUID } from "node:crypto";
import {
  emitNoticeInTurn,
  persistNoticeUnattached,
  type InProgressPersister,
} from "../chat-card-persistence.js";
import { loadPrompt, fillPromptTokens } from "../load-prompt.js";
import { listBackgroundJobs } from "../background-job-list.js";
import { informingWakeMissed, type TurnAdmission } from "../turn-settlement.js";
import { getErrorMessage } from "../validation.js";
import { wakeSessionWithTurn, type WakeSessionDeps } from "../wake-session.js";
import type { QuotaResumeRecorder } from "./quota-continuation.js";

const WAKE_PROMPT = loadPrompt(import.meta.url, "../prompts/stopped-background-jobs-wake.md");
const WAKE_ACTIVITY = "Continuing after background work was stopped…";

// Names the wake's own turn at its end, also after a restart: that turn starts no second wake.
const WAKE_DELIVERY_PREFIX = "stopped-background-jobs:";

export interface StoppedBackgroundJobsDeps extends WakeSessionDeps {
  chatHistoryManager: InProgressPersister;
  quotaContinuation?: QuotaResumeRecorder | undefined;
}

export interface StoppedBackgroundJobsReport {
  sessionId: string;
  /** The CLI's description of each job: the agent's own label, or the command when it gave none. */
  jobs: readonly string[];
  /** The delivery id of the turn that ended. */
  deliveryId?: string | undefined;
  /** False when the process was displaced: its work can be uncommitted, so no turn may start. */
  mayWake: boolean;
}

export type StoppedBackgroundJobsDecision =
  | { woken: true; admitted: TurnAdmission }
  | {
      woken: false;
      reason:
        | "no-jobs"
        | "no-session"
        | "own-wake"
        | "consult-wake-delivers"
        | "displaced"
        | "wake-failed";
    };

export function buildStoppedBackgroundJobsPrompt(jobs: readonly string[]): string {
  return fillPromptTokens(WAKE_PROMPT, {
    JOBS: listBackgroundJobs(jobs).map((job) => `- ${job}`).join("\n"),
  }).trimEnd();
}

/** Never throws: the caller is the end of a turn's terminal sequence. */
export async function reportStoppedBackgroundJobs(
  deps: StoppedBackgroundJobsDeps,
  report: StoppedBackgroundJobsReport,
): Promise<StoppedBackgroundJobsDecision> {
  const { sessionId, jobs } = report;
  if (jobs.length === 0) return { woken: false, reason: "no-jobs" };
  try {
    const session = deps.sessionManager.get(sessionId);
    if (!session || session.archived === true || session.userArchived === true) {
      return { woken: false, reason: "no-session" };
    }
    const text = buildStoppedBackgroundJobsPrompt(jobs);

    // The wake told the agent not to do this. A second wake could repeat without end.
    if (report.deliveryId?.startsWith(WAKE_DELIVERY_PREFIX)) {
      parkForNextTurn(deps, sessionId, text);
      tellUser(
        deps,
        sessionId,
        `${userSummary(jobs)} ShipIt already started one turn to tell the agent, and starts no `
        + "second one. The agent gets the same note with your next message.",
      );
      console.warn(
        `[stopped-jobs] the wake turn of ${sessionId} left ${jobs.length} job(s) running too; `
        + "parked the note for the next turn instead of a second wake",
      );
      return { woken: false, reason: "own-wake" };
    }

    // The job list does not say which entry is a consult's command. A consult's result
    // starts a turn (docs/287-consult-result-delivery), and the note rides that turn. A
    // consult that ended a moment ago is not counted, and then both start a turn.
    if ((deps.runnerRegistry.get(sessionId)?.subAgentSpawnsInFlight ?? 0) > 0) {
      parkForNextTurn(deps, sessionId, text);
      console.log(
        `[stopped-jobs] ${sessionId} has a consult in flight; parked the note about `
        + `${jobs.length} stopped job(s) for the turn its result starts`,
      );
      return { woken: false, reason: "consult-wake-delivers" };
    }

    if (!report.mayWake) {
      parkForNextTurn(deps, sessionId, text);
      tellUser(deps, sessionId, `${userSummary(jobs)} The agent gets a note about it with its next turn.`);
      console.log(
        `[stopped-jobs] the process of ${sessionId} was displaced; parked the note about `
        + `${jobs.length} job(s) for the next turn`,
      );
      return { woken: false, reason: "displaced" };
    }

    try {
      const handle = await wakeSessionWithTurn(deps, session, {
        text,
        activity: WAKE_ACTIVITY,
        deliveryId: `${WAKE_DELIVERY_PREFIX}${randomUUID()}`,
        onSettled: (outcome) => {
          if (!informingWakeMissed(outcome)) return;
          console.warn(
            `[stopped-jobs] the wake turn for ${sessionId} ended as "${outcome.status}"; `
            + "parking the note for the next turn",
          );
          parkForNextTurn(deps, sessionId, text);
          // docs/306-quota-continuation — and that turn comes by itself once quota allows it.
          if (outcome.quotaRefused) {
            deps.quotaContinuation?.recordRefusedWake({ sessionId, resetsAt: outcome.quotaRefused.resetsAt });
          }
        },
      });
      const what = handle.admitted === "started" ? "woke" : `${handle.admitted} a wake for`;
      console.log(`[stopped-jobs] ${what} ${sessionId} about ${jobs.length} stopped job(s)`);
      return { woken: true, admitted: handle.admitted };
    } catch (err) {
      const detail = getErrorMessage(err);
      console.error(`[stopped-jobs] wake-turn not delivered to ${sessionId}: ${detail}`);
      parkForNextTurn(deps, sessionId, text);
      tellUser(
        deps,
        sessionId,
        `${userSummary(jobs)} ShipIt could not start a turn to tell the agent (${detail}). `
        + "The agent gets the note with your next message.",
      );
      return { woken: false, reason: "wake-failed" };
    }
  } catch (err) {
    console.error(`[stopped-jobs] reporting the stopped jobs of ${sessionId} failed:`, err);
    return { woken: false, reason: "wake-failed" };
  }
}

function userSummary(jobs: readonly string[]): string {
  return "Background work that the agent started was still running when its message ended, and "
    + `most probably did not finish: ${listBackgroundJobs(jobs).join("; ")}.`;
}

// Append, never set: a notice recorded meanwhile must survive this.
function parkForNextTurn(deps: StoppedBackgroundJobsDeps, sessionId: string, text: string): void {
  try {
    deps.sessionManager.appendPendingAgentNotice(sessionId, `[System] ${text}`);
  } catch (err) {
    console.error(`[stopped-jobs] parking the note for ${sessionId} failed:`, getErrorMessage(err));
  }
}

function tellUser(deps: StoppedBackgroundJobsDeps, sessionId: string, message: string): void {
  try {
    const runner = deps.runnerRegistry.get(sessionId);
    if (runner) emitNoticeInTurn(runner, sessionId, message, deps.chatHistoryManager, "warn");
    else persistNoticeUnattached(deps.chatHistoryManager, sessionId, message, "warn");
  } catch (err) {
    console.error(`[stopped-jobs] the notice for ${sessionId} failed:`, getErrorMessage(err));
  }
}
