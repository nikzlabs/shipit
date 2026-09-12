/**
 * sendUserMessage — single client entry point for "user is sending something
 * to the agent over the WebSocket."
 *
 * Every WS send_message / answer_question callsite
 * funnels through this helper so the optimistic state setup (chat bubble,
 * loading flag, activity label) lives in exactly one place. Previously each
 * callsite inlined the same three setters; one ("send doc comments") forgot
 * to inline them at all, so the agent silently kicked off with no UI signal.
 *
 * The helper deliberately does not own the WS frame itself — callsites pass a
 * `dispatch` closure that either calls `send(frame)` directly or stashes the
 * frame on `setPendingWsMessage` when the socket isn't open yet (the
 * /{slug}/new path). Keeping that decision at the callsite means
 * `send_message` vs `answer_question` all share the same optimistic-state code
 * without us building a typed union of WS frames here.
 *
 * The HTTP-dispatch helper (`dispatch-agent-message.ts`) is a separate
 * counterpart for the POST /agent/dispatch flow — it can't fold into this one
 * because it owns its own error-rollback semantics.
 *
 * Optimistic state is only optimistic about the SERVER's reply, never about the
 * send itself: `dispatch` reports whether the frame reached the wire, and a
 * `false` rolls the bubble, the spinner and the active-runner mark straight back
 * out. Without that, a `send()` dropped on a non-OPEN socket left the user with
 * a permanent "Thinking..." and no message — and let callers (the action
 * checklist card) render a "Submitted" ack for a frame that never left the tab.
 */

import type { ChatMessage } from "../components/MessageList.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { randomId } from "./random-id.js";

export interface SendUserMessageOptions {

  bubble: ChatMessage;

  activity: string;
  /**
   * Closure that actually puts the message on the wire. Typically a thin
   * wrapper around `send({ type: "send_message", ... })`, but can also
   * call `setPendingWsMessage` when the socket isn't open yet.
   *
   * MUST report whether the message was accepted for delivery: `true` when the
   * frame was written to an open socket OR deliberately stashed for flush on
   * reconnect, `false` when it was dropped. Returning `true` unconditionally
   * re-introduces the silent-drop bug.
   */
  dispatch: (requestId: string) => boolean;
}

export function sendUserMessage({ bubble, activity, dispatch }: SendUserMessageOptions): boolean {
  const session = useSessionStore.getState();

  // earlier: this one never even reached `dispatch`.
  const requestId = randomId();

  const priorIsLoading = session.isLoading;
  const priorActivity = session.activity;
  session.setMessages((prev) => [...prev, { ...bubble, clientRequestId: requestId }]);
  session.setIsLoading(true);
  session.setActivity({ label: activity });

  // optimistic add self-heals if the turn never actually starts.
  const activeSessionId = session.sessionId;

  // may remove it — a session that was already running must keep its mark.
  const markedActiveRunner = !!activeSessionId && !session.activeRunnerSessions.has(activeSessionId);
  if (activeSessionId) {
    session.setActiveRunnerSessions((prev) => {
      if (prev.has(activeSessionId)) return prev;
      const next = new Set(prev);
      next.add(activeSessionId);
      return next;
    });
  }
  if (dispatch(requestId)) return true;

  // The frame never left the browser. Undo the optimistic state in the same

  // sit there forever waiting for a turn that was never started.
  session.setMessages((prev) => prev.filter((m) => m.clientRequestId !== requestId));
  session.setIsLoading(priorIsLoading);
  session.setActivity(priorActivity);
  if (activeSessionId && markedActiveRunner) {
    session.setActiveRunnerSessions((prev) => {
      if (!prev.has(activeSessionId)) return prev;
      const next = new Set(prev);
      next.delete(activeSessionId);
      return next;
    });
  }
  useUiStore.getState().setToast({
    message: "Not connected — your message wasn't sent. Reconnecting; try again in a moment.",
  });
  return false;
}
