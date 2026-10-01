// The agent asks for its own agent container to restart; ShipIt restarts it once the turn is
// over and gives the agent its note back as a turn on the new container
// (docs/321-agent-requested-restart). The user's "Restart after turn" uses the same step,
// without a note and without a follow-up turn (docs/242-stale-session-container-indicator req 9).
import type { SessionManager } from "../sessions.js";
import type { SessionContainerManager } from "../session-container.js";
import type { SessionRunnerInterface, SessionRunnerRegistry } from "../session-runner.js";
import { releaseQueuedTurn } from "../queue-drain.js";
import { wakeSessionWithTurn, type WakeSessionDeps } from "../wake-session.js";
import { loadPrompt, fillPromptTokens } from "../load-prompt.js";
import { getErrorMessage } from "../validation.js";
import { restartAgent, takeQueueHold, type QueueHold } from "./recovery.js";
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

export interface UserRestartDeps {
  sessionManager: Pick<SessionManager, "setPendingUserRestart">;
  containerManager: SessionContainerManager | null;
  runnerRegistry: Pick<SessionRunnerRegistry, "get">;
}

/**
 * The user's "Restart after turn". True when a turn runs and the restart now waits for its
 * end; false when nothing runs, and the caller restarts at once.
 */
export function deferRestartToTurnEnd(deps: UserRestartDeps, sessionId: string): boolean {
  if (!deps.containerManager || !deps.runnerRegistry.get(sessionId)?.running) return false;
  deps.sessionManager.setPendingUserRestart(sessionId, true);
  return true;
}

/** What the ending turn tells the step about itself. */
export interface RequestedRestartTurn {
  sessionId: string;
  runner: SessionRunnerInterface;
  turnIsCurrent: () => boolean;
  /** This turn took the runner's system hold and still owns it. */
  ownsSystemHold: () => boolean;
  /**
   * Settles the turn with its real outcome. Without it the restart's dispose settles a
   * finished dispatched turn as interrupted, and the executor then settles it again.
   */
  settle: () => void;
}

export function buildRestartFollowupPrompt(note: string): string {
  return fillPromptTokens(FOLLOWUP_PROMPT, { NOTE: note });
}

/**
 * Runs at the end of every turn's commit-and-PR step. Does nothing unless the agent or the
 * user asked for a restart; leaves the request pending while another turn or flow has the
 * session, so the next turn's end retries it. Resolves once the container is replaced, without
 * waiting for the follow-up turn. Throws only if the request cannot be cleared, before
 * anything is held.
 */
export async function runRequestedRestart(
  deps: WakeSessionDeps,
  turn: RequestedRestartTurn,
): Promise<void> {
  const { sessionId, runner } = turn;
  const note = deps.sessionManager.getPendingRestartNote(sessionId);
  if (!note && !deps.sessionManager.hasPendingUserRestart(sessionId)) return;
  // A late terminal callback from an older turn sees a disposed runner that looks idle.
  if (deps.runnerRegistry.get(sessionId) !== runner || !turn.turnIsCurrent()) return;
  const heldByOther = runner.systemTurnInProgress && !turn.ownsSystemHold();
  if (runner.running || runner.mergeHold || heldByOther) {
    console.log(
      `[agent-restart] ${sessionId} is busy; the requested restart waits for the next turn's end`,
    );
    return;
  }
  // The agent knows what its own request ends; the user's must not end work the agent left
  // running. The turn that this work wakes retries.
  if (!note && (runner.backgroundTaskCount > 0 || runner.subAgentSpawnsInFlight > 0)) {
    console.log(
      `[agent-restart] ${sessionId} has background work; the user's restart waits for the next turn's end`,
    );
    return;
  }

  // Before the hold: if this write throws, nothing is held and the next turn's end retries.
  deps.sessionManager.clearPendingRestart(sessionId);
  // In the same synchronous step as the checks: from here new messages queue, and the
  // restart carries them to the new runner. Taking the hold also ends this turn's own.
  const oldHold = takeQueueHold(runner, { lease: false });
  console.log(
    `[agent-restart] restarting the agent container of ${sessionId}, as the ${note ? "agent" : "user"} asked`,
  );

  let held: QueueHold | undefined;
  try {
    try {
      turn.settle();
    } catch (err) {
      console.error(`[agent-restart] settling the ending turn of ${sessionId} threw:`, getErrorMessage(err));
    }
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
  if (!note) {
    releaseHold(held);
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
  note: string | undefined,
  err: unknown,
  holds: (QueueHold | undefined)[],
): void {
  const reason = getErrorMessage(err);
  console.error(`[agent-restart] the requested restart of ${sessionId} failed: ${reason}`);
  // The user's request has no note to give back; the health strip shows the failure.
  if (note) {
    parkNotice(
      deps,
      sessionId,
      "[System] The agent container restart you asked for with `shipit session restart` did not "
      + `complete (${reason}). Your note for after the restart was:\n\n${note}`,
    );
  }
  for (const hold of holds) releaseHold(hold);
}

function releaseHold(hold: QueueHold | undefined): void {
  if (!hold) return;
  hold.release();
  if (!hold.runner.disposed) releaseQueuedTurn(hold.runner);
}

// Append, never set: a branch notice recorded meanwhile must survive this.
function parkNotice(deps: WakeSessionDeps, sessionId: string, notice: string): void {
  try {
    deps.sessionManager.appendPendingAgentNotice(sessionId, notice);
  } catch (err) {
    console.error("[agent-restart] parking the restart note failed:", getErrorMessage(err));
  }
}
