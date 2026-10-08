import type { PersistedMessage } from "./chat-history.js";
import type { SessionInfo } from "../shared/types.js";

/**
 * docs/324-scheduled-sessions → Finished runs. The requirement's "finished" (reqs 22, 31,
 * 33): Delete, Run now's warning and the sidebar all read the decision saved from this.
 */

export interface RunFinishedInputs {
  run: Pick<SessionInfo, "runStoppedAt" | "awaitingAnswer" | "manualStepCount" | "lastTurnOutcome">;
  /** Its row is still `starting`: the session exists, but its prompt has not gone out. */
  starting: boolean;
  prOpen: boolean;
  /** With the status card off, a run has no manual steps to show (`advanced.sessionStatusCard`). */
  statusCardOn: boolean;
}

export function isRunFinished({ run, starting, prOpen, statusCardOn }: RunFinishedInputs): boolean {
  // A user turn after the stop clears `run_stopped_at`, so a stop counts until then (req 33).
  if (run.runStoppedAt) return true;
  if (starting) return false;
  if (run.awaitingAnswer) return false;
  if (statusCardOn && (run.manualStepCount ?? 0) > 0) return false;
  if (prOpen) return false;
  return run.lastTurnOutcome !== "errored" && run.lastTurnOutcome !== "quota-refused";
}

const MAX_RESULT_CHARS = 200;

function firstLine(text: string): string | undefined {
  const line = text.split("\n").map((l) => l.replace(/^#+\s+/, "").trim()).find((l) => l.length > 0);
  if (!line) return undefined;
  return line.length > MAX_RESULT_CHARS ? `${line.slice(0, MAX_RESULT_CHARS - 1)}…` : line;
}

/**
 * The run history's one-line result (req 24): the status card's `lastTurn` when the card is
 * on and has one, or else the first line of the run's last agent message.
 */
export function runResult(
  session: Pick<SessionInfo, "sessionStatus">,
  statusCardOn: boolean,
  messages: readonly PersistedMessage[],
): string | undefined {
  const lastTurn = statusCardOn ? session.sessionStatus?.lastTurn : undefined;
  const fromCard = lastTurn ? firstLine(lastTurn) : undefined;
  if (fromCard) return fromCard;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant" || message.notice || message.isError) continue;
    const line = firstLine(message.text);
    if (line) return line;
  }
  return undefined;
}
