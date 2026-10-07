// docs/324-agent-requested-compaction req 10 — Stop keeps a requested compaction and ends the
// agent's own continuation of it. A leaf module, so the Stop paths do not import the step.
import type { SessionManager } from "../sessions.js";
import type { QueuedMessage, SessionRunnerInterface } from "../session-runner.js";

const continuations = new WeakSet<QueuedMessage>();

export function markCompactionContinuation(entry: QueuedMessage): QueuedMessage {
  continuations.add(entry);
  return entry;
}

/**
 * Drops the note of a pending request, and a continuation already queued behind a running
 * compaction. Never throws: Stop must work.
 */
export function stopCompactionContinuation(
  sessionManager: Pick<SessionManager, "dropPendingCompactionNote">,
  runner: Pick<SessionRunnerInterface, "sessionId" | "messageQueue" | "emitMessage" | "getQueueSnapshot">,
): void {
  try {
    sessionManager.dropPendingCompactionNote(runner.sessionId);
  } catch (err) {
    console.error(
      `[agent-compaction] dropping the note on Stop for ${runner.sessionId} failed:`,
      err instanceof Error ? err.message : String(err),
    );
  }
  const queue = runner.messageQueue;
  const before = queue.length;
  for (let i = queue.length - 1; i >= 0; i--) {
    if (continuations.has(queue[i])) queue.splice(i, 1);
  }
  if (queue.length !== before) runner.emitMessage({ type: "queue_updated", queue: runner.getQueueSnapshot() });
}
