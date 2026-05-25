/**
 * sendUserMessage — single client entry point for "user is sending something
 * to the agent over the WebSocket."
 *
 * Every WS send_message / send_review_message / answer_question callsite
 * funnels through this helper so the optimistic state setup (chat bubble,
 * loading flag, activity label) lives in exactly one place. Previously each
 * callsite inlined the same three setters; one ("send doc comments") forgot
 * to inline them at all, so the agent silently kicked off with no UI signal.
 *
 * The helper deliberately does not own the WS frame itself — callsites pass a
 * `dispatch` closure that either calls `send(frame)` directly or stashes the
 * frame on `setPendingWsMessage` when the socket isn't open yet (the
 * /{slug}/new path). Keeping that decision at the callsite means
 * `send_review_message` vs `send_message` vs `answer_question` all share the
 * same optimistic-state code without us building a typed union of WS frames
 * here.
 *
 * The HTTP-dispatch helper (`dispatch-agent-message.ts`) is a separate
 * counterpart for the POST /agent/dispatch flow — it can't fold into this one
 * because it owns its own error-rollback semantics.
 */

import type { ChatMessage } from "../components/MessageList.js";
import { useSessionStore } from "../stores/session-store.js";

export interface SendUserMessageOptions {
  /**
   * Optimistic user bubble to append to the chat. Composed by the caller so
   * each surface can attach its own metadata (files, uploads, images, the
   * `userReview` card payload for doc/diff comment submissions, etc.).
   */
  bubble: ChatMessage;
  /** Activity label shown next to the spinner ("Thinking...", "Reviewing..."). */
  activity: string;
  /**
   * Closure that actually puts the message on the wire. Typically a thin
   * wrapper around `send({ type: "send_message", ... })`, but can also
   * call `setPendingWsMessage` when the socket isn't open yet.
   */
  dispatch: () => void;
}

export function sendUserMessage({ bubble, activity, dispatch }: SendUserMessageOptions): void {
  const session = useSessionStore.getState();
  session.setMessages((prev) => [...prev, bubble]);
  session.setIsLoading(true);
  session.setActivity({ label: activity });
  dispatch();
}
