// The agent asks ShipIt to compact its context; ShipIt compacts once the turn is over, gives
// the agent its instructions back, and continues in a new turn when it left a note
// (docs/324-agent-requested-compaction).
import type { AgentId } from "../../shared/types.js";
import { getAgentCapabilities } from "../../shared/agent-registry.js";
import { GLOBAL_SETTINGS } from "../../shared/settings-catalogue/global-settings.js";
import { settingPath } from "../../shared/settings-catalogue/tabs.js";
import type { PendingCompaction, SessionManager } from "../sessions.js";
import type { PersistedMessage } from "../chat-history.js";
import type { SessionRunnerInterface, SessionRunnerRegistry } from "../session-runner.js";
import { DISPATCH_SETUP_FAILURE, toQueuedMessage } from "../session-runner.js";
import { prepareDispatch } from "../prepared-dispatch.js";
import type { TurnHandle, TurnOutcome } from "../turn-settlement.js";
import { systemTurnBlockedByResidentWork } from "../turn-admission.js";
import { stoppedByUser } from "../turn-stop-request.js";
import { reconcileRunnerAgent } from "../reconcile-runner-agent.js";
import { emitNoticePostTurn } from "../chat-card-persistence.js";
import { MISSED_COMPACTION_NOTICE } from "../compact-before-turn.js";
import { loadPrompt, fillPromptTokens } from "../load-prompt.js";
import { getErrorMessage } from "../validation.js";
import { shouldRepark } from "./rebase-followup.js";
import { markCompactionContinuation } from "./agent-compaction-stop.js";
import type { RequestedRestartTurn } from "./agent-restart-request.js";
import { ServiceError } from "./types.js";

const INSTRUCTIONS = loadPrompt(import.meta.url, "../prompts/agent-compaction-instructions.md").trim();
const NOTE = loadPrompt(import.meta.url, "../prompts/agent-compaction-note.md").trim();
const NOT_STARTED = loadPrompt(import.meta.url, "../prompts/agent-compaction-not-started.md").trim();
const COMPACTION_ACTIVITY = "Compacting context…";
const FOLLOWUP_ACTIVITY = "Continuing after the compaction…";
const MAX_CHARS = 4000;

const SETTING = GLOBAL_SETTINGS["advanced.agentCompaction"];

/** Named from the declaration: a hand-quoted label goes stale on the next reword (planning#580). */
export const AGENT_COMPACTION_OFF =
  `Compacting your own context is turned off: "${SETTING.label}" in ${settingPath(SETTING.tab)} is off. `
  + `To ask the user to turn it on, run \`shipit settings propose ${SETTING.key}=true --reason "..."\`.`;

export interface CompactionRequestDeps {
  sessionManager: Pick<SessionManager, "get" | "setPendingCompaction">;
  defaultAgentId: AgentId;
  /** docs/324-agent-requested-compaction req 11 — `advanced.agentCompaction`, off by default. */
  isEnabled: () => boolean;
}

export function recordCompactionRequest(
  deps: CompactionRequestDeps,
  sessionId: string,
  body: { instructions?: unknown; note?: unknown },
): { requested: true; continues: boolean } {
  const instructions = optionalText(body.instructions, "instructions");
  const note = optionalText(body.note, "note");
  const session = deps.sessionManager.get(sessionId);
  if (!session) throw new ServiceError(404, "Session not found");
  if (!deps.isEnabled()) throw new ServiceError(403, AGENT_COMPACTION_OFF);
  const agentId = session.agentId ?? deps.defaultAgentId;
  if (!canCompact(agentId)) {
    throw new ServiceError(
      409,
      `This session's agent (${agentId}) cannot compact its context, so no compaction was scheduled.`,
    );
  }
  deps.sessionManager.setPendingCompaction(sessionId, {
    ...(instructions !== undefined ? { instructions } : {}),
    ...(note !== undefined ? { note } : {}),
  });
  return { requested: true, continues: note !== undefined };
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ServiceError(400, `The ${label} must be text.`);
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > MAX_CHARS) {
    throw new ServiceError(400, `The ${label} is longer than ${MAX_CHARS} characters.`);
  }
  return text;
}

function canCompact(agentId: AgentId): boolean {
  return getAgentCapabilities(agentId)?.supportsCompaction ?? false;
}

export function buildInstructionsNotice(instructions: string): string {
  return `[System] ${fillPromptTokens(INSTRUCTIONS, { INSTRUCTIONS: instructions })}`;
}

export function buildContinuationPrompt(note: string): string {
  return fillPromptTokens(NOTE, { NOTE: note });
}

export interface CompactionStepDeps {
  sessionManager: Pick<
    SessionManager,
    "get" | "getPendingCompaction" | "setPendingCompaction" | "dropPendingCompactionNote" | "appendPendingCompactionNotice"
  >;
  runnerRegistry: Pick<SessionRunnerRegistry, "get">;
  chatHistoryManager: { append(sessionId: string, message: PersistedMessage): unknown };
  isEnabled: () => boolean;
}

/**
 * Runs at the end of every turn's commit-and-PR step, after the docs/321 restart step. Does
 * nothing unless the agent asked for a compaction; leaves the request pending while another
 * turn or flow has the session, so the next turn's end retries it.
 *
 * The compaction is the docs/295 silent system turn, and what follows it is fixed BEFORE it
 * starts: the instructions are parked as a notice, which the compaction does not consume and
 * the next turn does, and the continuation goes to the queue's head, which the compaction's
 * own drain takes. Neither waits for the compaction to settle — OpenCode's compaction never
 * reports a process exit, and queued work drains before settlement.
 */
export async function runRequestedCompaction(
  deps: CompactionStepDeps,
  turn: RequestedRestartTurn,
): Promise<void> {
  const { sessionId, runner } = turn;
  if (!deps.sessionManager.getPendingCompaction(sessionId)) return;
  // A late terminal callback from an older turn sees a runner that looks idle.
  if (deps.runnerRegistry.get(sessionId) !== runner || !turn.turnIsCurrent()) return;
  // req 10 — covers a request that landed after the Stop; the Stop handlers cover the rest.
  if (stoppedByUser(runner)) deps.sessionManager.dropPendingCompactionNote(sessionId);

  const busy = busyReason(runner, turn);
  if (busy) {
    console.log(`[agent-compaction] ${sessionId}: ${busy}; the compaction waits for the next turn's end`);
    return;
  }
  // Settle the ending turn while the runner still describes it: the compaction resets that
  // state, and a system turn's own hold would keep the compaction out.
  try {
    turn.settle();
  } catch (err) {
    console.error(`[agent-compaction] settling the ending turn of ${sessionId} threw:`, getErrorMessage(err));
  }
  if (runner.running || runner.systemTurnInProgress) {
    console.log(`[agent-compaction] ${sessionId}: queued work started; the compaction waits for its end`);
    return;
  }

  const request = deps.sessionManager.getPendingCompaction(sessionId);
  if (!request) return;
  // First: if this write throws, nothing has started and the next turn's end retries.
  deps.sessionManager.setPendingCompaction(sessionId, null);

  // req 11 — a request recorded before the user turned the setting off does not run.
  if (!deps.isEnabled()) {
    notStarted(deps, runner, request, `"${SETTING.label}" is off`);
    return;
  }
  const agentId = reconcileRunnerAgent(runner, deps.sessionManager.get(sessionId)?.agentId);
  // A harness switched since the request would read `/compact` as an ordinary prompt.
  if (!canCompact(agentId)) {
    notStarted(deps, runner, request, `this session's agent (${agentId}) cannot compact its context`);
    return;
  }
  if (!runner.canRunDispatchedTurn) {
    notStarted(deps, runner, request, "this session cannot start a turn of its own");
    return;
  }

  // req 9 — persisted, so it survives a restart, and taken by whichever turn comes next.
  if (request.instructions) parkNotice(deps, sessionId, buildInstructionsNotice(request.instructions));

  let handle: TurnHandle;
  try {
    handle = runner.dispatch(prepareDispatch({
      text: request.instructions ? `/compact ${request.instructions}` : "/compact",
      agentInterface: undefined,
      execution: undefined,
      activity: COMPACTION_ACTIVITY,
      images: undefined,
      files: undefined,
      uploads: undefined,
      permissionMode: undefined,
      postTurn: undefined,
      systemTurn: true,
      automatic: true,
      heldId: undefined,
      // A dispatch that fails in setup never reaches the compaction turn's own missed-card notice.
      onTurnComplete: (outcome: TurnOutcome) => {
        if (outcome.detail?.startsWith(DISPATCH_SETUP_FAILURE)) warnUser(deps, runner);
      },
      deliveryId: undefined,
      dictated: undefined,
      resetMergedBranch: undefined,
      compactContext: undefined,
      silent: true,
    }));
  } catch (err) {
    notStarted(deps, runner, { ...(request.note !== undefined ? { note: request.note } : {}) }, getErrorMessage(err));
    return;
  }
  console.log(`[agent-compaction] compacting the context of ${sessionId}, as the agent asked (${handle.admitted})`);
  // req 8 — right behind the compaction, so it runs next whether that completes, fails or is
  // cut short. A started compaction has left the queue; a queued one is at its tail.
  if (request.note !== undefined) {
    const entry = markCompactionContinuation(continuationEntry(deps, sessionId, request.note));
    if (handle.admitted === "started") runner.messageQueue.unshift(entry);
    else runner.messageQueue.push(entry);
    runner.emitMessage({ type: "queue_updated", queue: runner.getQueueSnapshot() });
  }
}

function busyReason(runner: SessionRunnerInterface, turn: RequestedRestartTurn): string | null {
  if (runner.running) return "a turn is running";
  if (runner.mergeHold) return "a merge holds the session";
  if (runner.systemTurnInProgress && !turn.ownsSystemHold()) return "another flow holds the session";
  // docs/322 — the user answers first.
  if (runner.awaitingUserAnswer || runner.answerHold) return "the agent waits for the user's answer";
  return systemTurnBlockedByResidentWork(runner, true);
}

function continuationEntry(deps: CompactionStepDeps, sessionId: string, note: string) {
  const text = buildContinuationPrompt(note);
  return toQueuedMessage(prepareDispatch({
    text,
    agentInterface: undefined,
    execution: undefined,
    activity: FOLLOWUP_ACTIVITY,
    images: undefined,
    files: undefined,
    uploads: undefined,
    permissionMode: undefined,
    postTurn: undefined,
    systemTurn: true,
    automatic: true,
    heldId: undefined,
    onTurnComplete: (outcome: TurnOutcome) => {
      if (!shouldRepark(outcome)) return;
      console.warn(
        `[agent-compaction] the follow-up turn for ${sessionId} ended as "${outcome.status}"; `
        + "parking the note for the next turn",
      );
      parkNotice(deps, sessionId, `[System] ${text}`);
    },
    deliveryId: undefined,
    dictated: undefined,
    resetMergedBranch: undefined,
    // The context was just compacted; a merged session must not compact it again (docs/295).
    compactContext: false,
    silent: undefined,
  }));
}

/** No compaction turn ran: tell the user, and leave the note for the next turn (req 6). */
function notStarted(
  deps: CompactionStepDeps,
  runner: SessionRunnerInterface,
  request: PendingCompaction,
  reason: string,
): void {
  console.error(`[agent-compaction] the requested compaction of ${runner.sessionId} did not start: ${reason}`);
  warnUser(deps, runner);
  const notice = [
    fillPromptTokens(NOT_STARTED, { REASON: reason }),
    request.note !== undefined ? buildContinuationPrompt(request.note) : null,
  ].filter(Boolean).join("\n\n");
  parkNotice(deps, runner.sessionId, `[System] ${notice}`);
}

function warnUser(deps: CompactionStepDeps, runner: SessionRunnerInterface): void {
  try {
    emitNoticePostTurn(
      (m) => runner.emitMessage(m), deps.chatHistoryManager, runner.sessionId, MISSED_COMPACTION_NOTICE, "warn",
    );
  } catch (err) {
    console.error("[agent-compaction] the missed-compaction notice failed:", getErrorMessage(err));
  }
}

// Its own column: a branch move overwrites the agent notice whole (req 9).
function parkNotice(deps: CompactionStepDeps, sessionId: string, notice: string): void {
  try {
    deps.sessionManager.appendPendingCompactionNotice(sessionId, notice);
  } catch (err) {
    console.error("[agent-compaction] parking the compaction notice failed:", getErrorMessage(err));
  }
}
