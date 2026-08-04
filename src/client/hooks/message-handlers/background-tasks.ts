import type { WsBackgroundTasks } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * docs/235 — chat status line for a session waiting on agent-initiated
 * background work. Names the task when there is exactly one (the common case,
 * and the only one where a name is unambiguous); falls back to a count
 * otherwise so the line never grows unbounded.
 */
export function backgroundTaskLabel(descriptions: string[]): string {
  const only = descriptions.length === 1 ? descriptions[0]?.trim() : undefined;
  if (only) {
    const short = only.length > 60 ? `${only.slice(0, 57)}…` : only;
    return `Waiting for: ${short}`;
  }
  if (descriptions.length > 1) {
    return `Waiting for ${descriptions.length} background tasks to finish`;
  }
  return "Waiting for a background task to finish";
}

/**
 * docs/235 — the backend's complete current background-task list.
 *
 * This handler owns the `backgroundTaskSessions` axis and NOTHING else. It must
 * never touch `activeRunnerSessions`: the two axes are deliberately separate
 * (`activeRunnerSessions` means "a turn is in flight" and gates PR actions), and
 * a task-list update carries no information about turn state — the CLI drains
 * the list a millisecond before it wakes itself for a new turn, so treating a
 * drain as "idle" is exactly the false-idle blip this split exists to prevent.
 *
 * The chat surfaces (spinner + status line) are only touched while NO turn is
 * running. Mid-turn, the turn owns them — clearing the label when a background
 * job drains would wipe the live tool activity, and re-labelling it when one
 * starts would replace "Running npm test" with "Waiting for: …" while the agent
 * is visibly working.
 */
export const handleBackgroundTasks: Handler<WsBackgroundTasks> = (_ctx, data) => {
  const session = useSessionStore.getState();
  const pending = data.count > 0;
  session.setBackgroundTaskSessions((prev) => {
    const next = new Map(prev);
    if (pending) { next.set(data.sessionId, data.descriptions); } else { next.delete(data.sessionId); }
    return next;
  });

  const store = useSessionStore.getState();
  if (data.sessionId !== store.sessionId) return;
  if (store.activeRunnerSessions.has(data.sessionId)) return;

  // Between turns the status bar stays up while background work is outstanding:
  // the session is not idle, it is waiting, and a cleared bar reads as
  // "finished". `tool` is deliberately left unset — no tool call is running, so
  // the tool spinner would be a lie.
  session.setIsLoading(pending);
  session.setActivity(pending ? { label: backgroundTaskLabel(data.descriptions) } : undefined);
};
