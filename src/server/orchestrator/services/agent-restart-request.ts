// The agent asks for its own agent container to restart; ShipIt restarts it once the turn is
// over and gives the agent its note back as a turn on the new container
// (docs/321-agent-requested-restart).
import type { SessionManager } from "../sessions.js";
import type { SessionContainerManager } from "../session-container.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import { releaseQueuedTurn } from "../queue-drain.js";
import { wakeSessionWithTurn, type WakeSessionDeps } from "../wake-session.js";
import { loadPrompt, fillPromptTokens } from "../load-prompt.js";
import { getErrorMessage } from "../validation.js";
import { restartAgent, type QueueHold } from "./recovery.js";
import { shouldRepark } from "./rebase-followup.js";
import { ServiceError } from "./types.js";

const FOLLOWUP_PROMPT = loadPrompt(import.meta.url, "../prompts/post-restart-followup.md");
const FOLLOWUP_ACTIVITY = "Continuing after the restart…";
const MAX_NOTE_CHARS = 4000;

export interface RestartRequestDeps {
  sessionManager: Pick<SessionManager, "get" | "setPendingRestartNote">;
  containerManager: SessionContainerManager | null;
}

export function recordRestartRequest(
  deps: RestartRequestDeps,
  sessionId: string,
  note: unknown,
): { requested: true } {
  const text = typeof note === "string" ? note.trim() : "";
  if (!text) {
    throw new ServiceError(
      400,
      "A note is required: ShipIt gives it back to you as the first turn on the new container, "
      + "so without one there is nothing to continue from.",
    );
  }
  if (text.length > MAX_NOTE_CHARS) {
    throw new ServiceError(400, `The note is longer than ${MAX_NOTE_CHARS} characters.`);
  }
  if (!deps.sessionManager.get(sessionId)) throw new ServiceError(404, "Session not found");
  if (!deps.containerManager) {
    throw new ServiceError(
      503,
      "This ShipIt runs sessions without containers, so there is no agent container to restart.",
    );
  }
  deps.sessionManager.setPendingRestartNote(sessionId, text);
  return { requested: true };
}

/** What the ending turn tells the step about itself. */
export interface RequestedRestartTurn {
  sessionId: string;
  runner: SessionRunnerInterface;
  turnIsCurrent: () => boolean;
  /** This turn took the runner's system hold and still owns it. */
  ownsSystemHold: () => boolean;
}

export function buildRestartFollowupPrompt(note: string): string {
  return fillPromptTokens(FOLLOWUP_PROMPT, { NOTE: note });
}

/**
 * Runs at the end of every turn's commit-and-PR step. Does nothing unless the agent asked for
 * a restart; leaves the request pending while another turn or flow has the session, so the
 * next turn's end retries it. Resolves once the container is replaced, without waiting for
 * the follow-up turn. Never throws.
 */
export async function runRequestedRestart(
  deps: WakeSessionDeps,
  turn: RequestedRestartTurn,
): Promise<void> {
  const { sessionId, runner } = turn;
  const note = deps.sessionManager.getPendingRestartNote(sessionId);
  if (!note) return;
  // A late terminal callback from an older turn sees a disposed runner that looks idle.
  if (deps.runnerRegistry.get(sessionId) !== runner || !turn.turnIsCurrent()) return;
  const heldByOther = runner.systemTurnInProgress && !turn.ownsSystemHold();
  if (runner.running || runner.mergeHold || heldByOther) {
    console.log(
      `[agent-restart] ${sessionId} is busy; the requested restart waits for the next turn's end`,
    );
    return;
  }

  // In the same synchronous step as the checks: from here new messages queue, and the
  // restart carries them to the new runner. Taking the hold also ends this turn's own.
  runner.systemTurnInProgress = true;
  const oldHold: QueueHold = { runner, seq: runner.systemHoldSeq };
  deps.sessionManager.setPendingRestartNote(sessionId, null);
  console.log(`[agent-restart] restarting the agent container of ${sessionId}, as the agent asked`);

  let held: QueueHold | undefined;
  try {
    // No OOM breaker or loop detector: a restart the agent asked for must not reset them.
    const result = await restartAgent(
      {
        sessionManager: deps.sessionManager,
        containerManager: deps.containerManager ?? null,
        runnerRegistry: deps.runnerRegistry,
        defaultAgentId: deps.defaultAgentId,
      },
      sessionId,
      { carryQueue: true },
    );
    held = result.held;
    if (result.newContainerState === "missing") {
      throw new Error(result.error ?? "the new agent container could not be created");
    }
  } catch (err) {
    failRestart(deps, sessionId, note, err, [oldHold, held]);
    return;
  }
  void wakeAfterRestart(deps, sessionId, note, held);
}

async function wakeAfterRestart(
  deps: WakeSessionDeps,
  sessionId: string,
  note: string,
  held: QueueHold | undefined,
): Promise<void> {
  try {
    const session = deps.sessionManager.get(sessionId);
    if (!session) throw new Error("the session no longer exists");
    const text = buildRestartFollowupPrompt(note);
    await wakeSessionWithTurn(deps, session, {
      text,
      activity: FOLLOWUP_ACTIVITY,
      ...(held ? { releaseHold: held } : {}),
      onSettled: (outcome) => {
        if (!shouldRepark(outcome)) return;
        console.warn(
          `[agent-restart] the follow-up turn for ${sessionId} ended as "${outcome.status}"; `
          + "parking the note for the next turn",
        );
        parkNotice(deps, sessionId, `[System] ${text}`);
      },
    });
  } catch (err) {
    failRestart(deps, sessionId, note, err, [held]);
  }
}

function failRestart(
  deps: WakeSessionDeps,
  sessionId: string,
  note: string,
  err: unknown,
  holds: (QueueHold | undefined)[],
): void {
  const reason = getErrorMessage(err);
  console.error(`[agent-restart] the requested restart of ${sessionId} failed: ${reason}`);
  parkNotice(
    deps,
    sessionId,
    "[System] The agent container restart you asked for with `shipit session restart` did not "
    + `complete (${reason}). Your note for after the restart was:\n\n${note}`,
  );
  for (const hold of holds) releaseHold(hold);
}

function releaseHold(hold: QueueHold | undefined): void {
  if (!hold || hold.runner.disposed || hold.runner.systemHoldSeq !== hold.seq) return;
  hold.runner.systemTurnInProgress = false;
  releaseQueuedTurn(hold.runner);
}

// Append, never set: a branch notice recorded meanwhile must survive this.
function parkNotice(deps: WakeSessionDeps, sessionId: string, notice: string): void {
  try {
    deps.sessionManager.appendPendingAgentNotice(sessionId, notice);
  } catch (err) {
    console.error("[agent-restart] parking the restart note failed:", getErrorMessage(err));
  }
}
