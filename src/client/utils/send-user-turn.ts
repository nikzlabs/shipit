/**
 * The only place a `send_message` frame is built.
 *
 * docs/218 + docs/295. The per-send intent for the two post-merge controls used
 * to be spread by hand at each producer, and exactly one producer did it — so
 * the five in `App.tsx` (the action-card button, both release-card buttons, the
 * review-comments submit and "ask the agent to review this file") sent neither
 * flag, and a user who unticked "Compact the context" and then pressed a button
 * on a card was compacted anyway while their untick sat on screen untouched.
 *
 * Routing every producer through a shared *builder* was the first fix and it
 * was not enough: the action-card path then read the opt-out, sent it, and
 * never spent it, so one untick governed every later message — requirement 5
 * says it applies to that one message. Reading and consuming have to be the
 * same act, which means they have to be the same function.
 *
 * So: `sendUserTurn` owns the frame, the intent and its consumption, and a
 * guard test fails the build if the frame literal appears anywhere else. A
 * producer cannot opt out by forgetting; it opts out by calling
 * `sendControlFrame` instead, which says in its name that it starts no turn.
 */

import { sendUserMessage } from "./send-user-message.js";
import {
  consumeMergeContinueIntent,
  mergeContinueFrameFields,
  type MergeContinueFrameFields,
} from "./merge-continue-intent.js";
import type { ChatMessage } from "../components/MessageList.js";

/** Everything a producer supplies; `type`, `requestId` and the intent are ours. */
export interface UserTurnFrame {
  text: string;
  sessionId?: string | undefined;
  [field: string]: unknown;
}

export interface SendUserTurnOptions {
  /** The session the turn belongs to, and whose opt-out this send spends. */
  sessionId: string | undefined;
  frame: UserTurnFrame;
  bubble: ChatMessage;
  activity: string;
  /**
   * The composer's own answer, when it has one. Only it knows whether it
   * actually SHOWED the controls, so only it can say `true` rather than leave
   * the field off. Every other producer omits this and gets the stored opt-out.
   */
  intent?: MergeContinueFrameFields;
  /**
   * Put the finished frame on the wire, reporting whether it was accepted.
   * Defaults to a plain `send`; the composer passes one that stashes an
   * undeliverable frame for flush on reconnect.
   */
  dispatch: (frame: Record<string, unknown>) => boolean;
}

export function sendUserTurn(opts: SendUserTurnOptions): boolean {
  const { sessionId, frame, bubble, activity, intent, dispatch } = opts;
  const sent = sendUserMessage({
    bubble,
    activity,
    dispatch: (requestId) =>
      dispatch({
        type: "send_message",
        requestId,
        ...frame,
        ...mergeContinueFrameFields(sessionId, intent),
      }),
  });
  // Only a send that reached the wire spends the untick. A refused or dropped
  // one leaves the user's choice where it was, for the retry they can see.
  if (sent) consumeMergeContinueIntent(sessionId);
  return sent;
}

/**
 * A `send_message` frame that starts NO turn, so no reset and no compaction can
 * apply to it and there is no intent to carry or spend.
 *
 * The only case today is a control-mode `/goal`. Verify it at
 * `src/server/orchestrator/ws-handlers/send-message.ts:54` (docs/154, on `main`
 * since 35719d01 — absent from older builds, so check the branch you are
 * reading): `handleSendMessage` opens with
 *
 *     if (goalCommand && (caps?.supportsGoals ?? false) && mode !== "turn")
 *
 * which calls `handleGoalCommand` and returns, ahead of the queue, the branch
 * reset and `decideCompactBeforeTurn`. A `/goal` whose action IS a "turn" falls
 * through that branch and takes the ordinary path above, which carries the
 * intent.
 *
 * Deliberately a separate export rather than a flag or a comment: a reviewer
 * can enumerate its call sites, and a new producer that reaches for it has to
 * name it.
 */
export function sendControlFrame(
  frame: UserTurnFrame,
  dispatch: (frame: Record<string, unknown>) => boolean,
): boolean {
  return dispatch({ type: "send_message", ...frame });
}
