// Carries a note the agent wrote during conflict resolution across the rest of the rebase,
// and plays it back as a turn once the rebase concludes (docs/303-post-rebase-followup).
import { randomUUID } from "node:crypto";
import { DISPATCH_SETUP_FAILURE, type SessionRunnerInterface } from "../session-runner.js";
import type { SessionManager } from "../sessions.js";
import type { TurnHandle, TurnOutcome } from "../turn-settlement.js";
import { loadPrompt, fillPromptTokens } from "../load-prompt.js";
import { prepareDispatch } from "../prepared-dispatch.js";
import { getErrorMessage } from "../validation.js";
import { ServiceError } from "./types.js";

const FOLLOWUP_PROMPT = loadPrompt(import.meta.url, "../prompts/post-rebase-followup.md");

export interface RebaseFollowup {
  notes: string[];
  baseBranch: string;
  headFrom: string | null;
  headTo: string | null;
  forcePushed: boolean;
}

export interface RebaseFollowupDeps {
  runner: SessionRunnerInterface;
  sessionManager: Pick<SessionManager, "appendPendingAgentNotice">;
}

interface FollowupWindow {
  attemptId: string;
  notes: string[];
}

/**
 * Process-lived and session-keyed, never stored on the runner: a rebase outlives the turns
 * inside it, and a runner a `dispose()` can take away cannot hold the arm
 * (`services/auto-push-scheduler.ts` is the precedent).
 */
const windows = new Map<string, FollowupWindow>();

export function openFollowupWindow(sessionId: string): string {
  const attemptId = randomUUID();
  windows.set(sessionId, { attemptId, notes: [] });
  return attemptId;
}

/**
 * Closing is by attempt id. The auto-resolve deadline does not cancel the flow it raced
 * (`rebase-driver.ts` `runAutoResolveAttempt`), so a timed-out flow can settle after a later
 * attempt opened its own window; a stale close must leave that newer window alone.
 */
export function closeFollowupWindow(sessionId: string, attemptId: string): string[] {
  const window = windows.get(sessionId);
  if (window?.attemptId !== attemptId) return [];
  windows.delete(sessionId);
  return window.notes;
}

export function followupWindowOpen(sessionId: string): boolean {
  return windows.has(sessionId);
}

export function armFollowupNote(sessionId: string, note: unknown): { notes: number } {
  const text = typeof note === "string" ? note.trim() : "";
  if (!text) {
    throw new ServiceError(
      400,
      "A note is required: ShipIt plays it back to you as the follow-up turn, so without one "
      + "there is nothing to deliver.",
    );
  }
  const window = windows.get(sessionId);
  if (!window) {
    throw new ServiceError(
      409,
      "No rebase is in progress for this session. ShipIt only carries a note across a rebase it "
      + "is driving — arm it during the conflict-resolution turn.",
    );
  }
  // A rebase can conflict several times; identical text would repeat in the prompt.
  if (!window.notes.includes(text)) window.notes.push(text);
  return { notes: window.notes.length };
}

export function buildFollowupPrompt(followup: RebaseFollowup): string {
  const shas = followup.headFrom && followup.headTo
    ? ` (was ${followup.headFrom.slice(0, 7)} → now ${followup.headTo.slice(0, 7)})`
    : "";
  return fillPromptTokens(FOLLOWUP_PROMPT, {
    BASE_BRANCH: followup.baseBranch,
    SHA_SUFFIX: shas,
    PUSH_SENTENCE: followup.forcePushed
      ? " The branch was force-pushed."
      : " The branch was NOT pushed, so the remote is still on the pre-rebase commits.",
    NOTES: followup.notes.map((n) => `- ${n}`).join("\n"),
  });
}

/**
 * Outcomes where the turn produced no result. `errored` is deliberately absent: an agent can
 * run the follow-up and only then emit an adapter error, and re-delivering that would repeat
 * work the agent already did. The one exception is the dispatch setup failure, which is
 * `errored` but means the prompt never reached the agent at all.
 */
const REPARK_STATUSES = new Set(["refused", "dropped"]);

function shouldRepark(outcome: TurnOutcome): boolean {
  if (REPARK_STATUSES.has(outcome.status)) return true;
  return outcome.status === "errored" && (outcome.detail?.startsWith(DISPATCH_SETUP_FAILURE) ?? false);
}

/**
 * Never throws and never awaits the turn: the caller is a rebase attempt, and holding it open
 * would put the auto-resolve deadline in charge of an unrelated turn.
 */
export function deliverRebaseFollowup(deps: RebaseFollowupDeps, followup: RebaseFollowup): void {
  const { runner } = deps;
  let text: string;
  try {
    text = buildFollowupPrompt(followup);
  } catch (err) {
    console.error("[rebase-followup] composing the follow-up prompt failed:", getErrorMessage(err));
    return;
  }

  let handle: TurnHandle;
  try {
    handle = runner.dispatch(prepareDispatch({
      text,
      agentInterface: undefined,
      activity: "Continuing after the rebase...",
      // Default post-turn handling on purpose: unlike the resolution turn, this turn writes
      // ordinary edits that must be committed and pushed.
      postTurn: undefined,
      systemTurn: true,
      execution: undefined,
      images: undefined,
      files: undefined,
      uploads: undefined,
      permissionMode: undefined,
      deliveryId: undefined,
      dictated: undefined,
      resetMergedBranch: undefined,
      compactContext: undefined,
      silent: undefined,
      statusNudge: undefined,
      onTurnComplete: undefined,
      // Answer a user message typed during the rebase first, then run the follow-up.
    }), { whenBusy: "queue" });
  } catch (err) {
    console.error("[rebase-followup] dispatching the follow-up turn failed:", getErrorMessage(err));
    reparkNotes(deps, text);
    return;
  }

  // dispatch() resolves with an outcome and never rejects, so a setup failure arrives here
  // rather than as a throw above.
  void (async () => {
    const outcome = await handle.settled;
    if (!shouldRepark(outcome)) return;
    console.warn(
      `[rebase-followup] the follow-up turn for ${runner.sessionId} ended as "${outcome.status}"`
      + `${outcome.detail ? ` — ${outcome.detail}` : ""}; parking the note for the next turn`,
    );
    reparkNotes(deps, text);
  })();
}

// Append, never set: a branch notice recorded by the same rebase must survive this.
function reparkNotes(deps: RebaseFollowupDeps, text: string): void {
  try {
    deps.sessionManager.appendPendingAgentNotice(deps.runner.sessionId, `[System] ${text}`);
  } catch (err) {
    console.error("[rebase-followup] parking the follow-up note failed:", getErrorMessage(err));
  }
}
