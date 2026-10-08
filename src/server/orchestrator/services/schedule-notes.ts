import { randomUUID } from "node:crypto";
import type {
  Schedule,
  ScheduleNoteContent,
  ScheduleNotesAccessCard,
  ScheduleNotesRun,
  ScheduleRun,
  ScheduleRunNotes,
} from "../../shared/types.js";
import type { PersistedMessage } from "../chat-history.js";
import { emitChatCard } from "../chat-card-persistence.js";
import type { ScheduleNotes } from "../schedule-notes.js";
import type { ScheduleNotesRequest, ScheduleNotesRequestStore } from "../schedule-notes-request-store.js";
import type { ScheduleStore } from "../schedule-store.js";
import type { SessionManager } from "../sessions.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import {
  claimDecisionCardWith,
  currentDecisionCard,
  loadDecisionCard,
  type CardClaimDeps,
  type DecisionCardKind,
  type DecisionCardPersister,
} from "./card-claim.js";
import { ServiceError } from "./types.js";

/**
 * docs/324-scheduled-sessions → "Seeing the notes" (reqs 13, 27, 28, 30). The user reads any
 * run's notes through browser-only routes. An agent reads through `shipit schedule notes`: a run
 * of the schedule always may (req 13), any other session only after the user allowed it for that
 * one schedule (reqs 28, 30). Every read goes through `ScheduleNotes`' safe read.
 */

/** How many runs `shipit schedule notes <schedule>` lists, newest first. */
const NOTES_RUNS_LISTED = 100;

export interface ScheduleNotesReadDeps {
  store: Pick<ScheduleStore, "get" | "getRun">;
  notes: ScheduleNotes;
}

export interface ScheduleNotesAccessDeps extends ScheduleNotesReadDeps {
  requests: ScheduleNotesRequestStore;
  chatHistoryManager: DecisionCardPersister;
  sessionManager: Pick<SessionManager, "get" | "grantScheduleNotes">;
  getRunnerRegistry: () => SessionRunnerRegistry | undefined;
}

export const SCHEDULE_NOTES_ACCESS_CARD: DecisionCardKind<"scheduleNotesAccess"> = {
  field: "scheduleNotesAccess",
  noun: "notes access request",
  updated: (sessionId, cardId, card) => ({ type: "schedule_notes_access_update", sessionId, cardId, card }),
};

/** The agent may not read these notes yet; the card that asks the user is in the chat. */
export class NotesAccessNeeded extends ServiceError {
  constructor(readonly cardId: string, readonly approval: "requested" | "pending", message: string) {
    super(403, message);
  }
}

function runAt(run: ScheduleRun): string {
  return run.slotAt ?? run.createdAt;
}

function scheduleOf(deps: ScheduleNotesReadDeps, scheduleId: string): Schedule {
  const schedule = deps.store.get(scheduleId);
  if (!schedule) {
    throw new ServiceError(404, `No schedule has the id ${JSON.stringify(scheduleId)}. \`shipit schedule list\` shows the ids.`);
  }
  return schedule;
}

function runOf(deps: ScheduleNotesReadDeps, scheduleId: string, runId: string): { schedule: Schedule; run: ScheduleRun } {
  const schedule = scheduleOf(deps, scheduleId);
  const run = deps.store.getRun(runId);
  if (run?.scheduleId !== scheduleId) throw new ServiceError(404, `Schedule ${scheduleId} has no run ${JSON.stringify(runId)}.`);
  return { schedule, run };
}

/** Req 27 — one run's files, for the viewer and the agent. */
export function readRunNotes(deps: ScheduleNotesReadDeps, scheduleId: string, runId: string): ScheduleRunNotes {
  const { schedule, run } = runOf(deps, scheduleId, runId);
  const listed = deps.notes.listFiles(scheduleId, runId);
  if (!listed) throw new ServiceError(404, "This run has no notes folder.");
  return {
    scheduleId,
    scheduleName: schedule.name,
    runId,
    runAt: runAt(run),
    files: listed.files,
    ...(listed.truncated ? { truncated: true as const } : {}),
  };
}

export function readRunNoteFile(
  deps: ScheduleNotesReadDeps,
  scheduleId: string,
  runId: string,
  relPath: unknown,
): ScheduleNoteContent {
  runOf(deps, scheduleId, runId);
  if (typeof relPath !== "string" || relPath === "") throw new ServiceError(400, "Name the file to read.");
  return deps.notes.read(scheduleId, runId, relPath);
}

/**
 * The runs that have a notes folder, newest first — read from the folders, so runs that were
 * skipped or failed before a session existed never push one out of the list.
 */
export function listNotesRuns(
  deps: ScheduleNotesReadDeps,
  scheduleId: string,
): { runs: ScheduleNotesRun[]; olderRuns: number } {
  scheduleOf(deps, scheduleId);
  const runs = deps.notes.runIds(scheduleId).flatMap((runId) => {
    const run = deps.store.getRun(runId);
    return run?.scheduleId === scheduleId ? [{ runId, runAt: runAt(run), outcome: run.outcome }] : [];
  });
  runs.sort((a, b) => b.runAt.localeCompare(a.runAt));
  return { runs: runs.slice(0, NOTES_RUNS_LISTED), olderRuns: Math.max(0, runs.length - NOTES_RUNS_LISTED) };
}

export type AgentNotesRead =
  | { schedule: { id: string; name: string }; runs: ScheduleNotesRun[]; olderRuns: number }
  | { notes: ScheduleRunNotes }
  | { file: ScheduleNoteContent; scheduleName: string };

function optionalString(value: unknown, what: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new ServiceError(400, `${what} must be text.`);
  return value;
}

/**
 * `shipit schedule notes <schedule> [<run> [<file>]]`. Without an approval the user is asked on
 * a card, once per pending request, and the command returns at once: it never waits.
 */
export function readNotesForAgent(
  deps: ScheduleNotesAccessDeps,
  sessionId: string,
  query: { schedule?: unknown; run?: unknown; file?: unknown },
): AgentNotesRead {
  const session = deps.sessionManager.get(sessionId);
  if (!session) throw new ServiceError(404, "Session not found");
  const scheduleId = optionalString(query.schedule, "The schedule");
  if (!scheduleId) {
    throw new ServiceError(400, "Name the schedule: `shipit schedule notes <schedule-id>`. `shipit schedule list` shows the ids.");
  }
  const runId = optionalString(query.run, "The run");
  const file = optionalString(query.file, "The file");
  const schedule = scheduleOf(deps, scheduleId);
  const allowed = session.scheduleId === scheduleId || (session.scheduleNotesGrants ?? []).includes(scheduleId);
  if (!allowed) requestAccess(deps, sessionId, schedule);

  if (!runId) return { schedule: { id: schedule.id, name: schedule.name }, ...listNotesRuns(deps, scheduleId) };
  if (!file) return { notes: readRunNotes(deps, scheduleId, runId) };
  return { file: readRunNoteFile(deps, scheduleId, runId, file), scheduleName: schedule.name };
}

function requestAccess(deps: ScheduleNotesAccessDeps, sessionId: string, schedule: Schedule): never {
  let pending = deps.requests.pending(sessionId, schedule.id);
  // A card the user can no longer see — rewound away, or never persisted — asks nobody.
  if (pending && !deps.chatHistoryManager.getDecisionCard("scheduleNotesAccess", sessionId, pending.cardId)) {
    deps.requests.delete(pending.cardId);
    pending = null;
  }
  if (pending) {
    throw new NotesAccessNeeded(
      pending.cardId,
      "pending",
      "The user has not decided yet on the card that asks to read this schedule's notes.",
    );
  }
  const runner = deps.getRunnerRegistry()?.get(sessionId);
  if (!runner) throw new ServiceError(409, "This session is not running, so the user cannot be asked.");
  const card: ScheduleNotesAccessCard = {
    cardId: `snr-${randomUUID()}`,
    scheduleId: schedule.id,
    scheduleName: schedule.name,
    phase: "pending",
    createdAt: new Date().toISOString(),
  };
  // The record first, so a click never finds a card without one.
  deps.requests.create({
    cardId: card.cardId,
    sessionId,
    scheduleId: schedule.id,
    phase: "pending",
    createdAt: card.createdAt,
  });
  const persisted: PersistedMessage = { role: "assistant", text: "", scheduleNotesAccess: card };
  emitChatCard(
    runner,
    { type: "schedule_notes_access_card", sessionId, card },
    persisted,
    { chatHistoryManager: deps.chatHistoryManager, sessionId },
  );
  throw new NotesAccessNeeded(
    card.cardId,
    "requested",
    "Reading this schedule's notes needs the user's approval for this session. A card that asks them is in the chat.",
  );
}

function claimDeps(deps: ScheduleNotesAccessDeps): CardClaimDeps<"scheduleNotesAccess", ScheduleNotesRequest> {
  return { chatHistoryManager: deps.chatHistoryManager, records: deps.requests, getRunnerRegistry: deps.getRunnerRegistry };
}

/**
 * The user's Allow or Deny, from the browser only. Allow writes the grant for the card's one
 * schedule in the claim's transaction (req 30); a second click finds the card decided.
 */
export function decideNotesAccess(
  deps: ScheduleNotesAccessDeps,
  sessionId: string,
  cardId: string,
  action: "allow" | "deny",
): { card: ScheduleNotesAccessCard; acted: boolean } {
  const { record } = loadDecisionCard(SCHEDULE_NOTES_ACCESS_CARD, claimDeps(deps), sessionId, cardId);
  const unchanged = () => ({
    card: currentDecisionCard(SCHEDULE_NOTES_ACCESS_CARD, deps, sessionId, cardId),
    acted: false,
  });
  if (record.phase !== "pending") return unchanged();
  const card = claimDecisionCardWith(
    SCHEDULE_NOTES_ACCESS_CARD,
    claimDeps(deps),
    sessionId,
    cardId,
    "pending",
    { phase: action === "allow" ? "allowed" : "denied", resolvedAt: new Date().toISOString() },
    () => {
      if (action === "allow") deps.sessionManager.grantScheduleNotes(sessionId, record.scheduleId);
      return {};
    },
  );
  return card ? { card, acted: true } : unchanged();
}
