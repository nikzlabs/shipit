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
 * producer cannot opt out by forgetting; the only frame that starts no turn has
 * its own narrow export below, which cannot send an ordinary message.
 */

import { sendUserMessage } from "./send-user-message.js";
import { consumeMergeContinueIntent, mergeContinueFrameFields } from "./merge-continue-intent.js";
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
   * Put the finished frame on the wire, reporting whether it was accepted.
   * Defaults to a plain `send`; the composer passes one that stashes an
   * undeliverable frame for flush on reconnect.
   */
  dispatch: (frame: Record<string, unknown>) => boolean;
}

export function sendUserTurn(opts: SendUserTurnOptions): boolean {
  const { sessionId, frame, bubble, activity, dispatch } = opts;
  const carried = mergeContinueFrameFields(sessionId);
  const sent = sendUserMessage({
    bubble,
    activity,
    dispatch: (requestId) => dispatch({ type: "send_message", requestId, ...frame, ...carried }),
  });
  // The boundary is the FRAME LEAVING THE BROWSER, and only what this frame
  // carried is spent. A dispatch that reports failure changes nothing, so the
  // user's choice is still on screen for the retry.
  //
  // Two edges the boundary does not cover, stated rather than papered over. A
  // frame stashed for reconnect counts as gone, because it carries the flags
  // with it — but a session switch discards the stash (`session-actions.ts`),
  // and then the untick is spent for a message that never ran. And a server
  // that accepts the frame and then refuses the turn has already spent it. Both
  // lose the user's whole message too, which is the larger bug in each.
  if (sent) consumeMergeContinueIntent(sessionId, carried);
  return sent;
}

/**
 * The one frame that starts NO turn: a control-mode `/goal`. Nothing to carry,
 * nothing to spend.
 *
 * Deliberately narrow — it takes a goal command and a session, not an arbitrary
 * prompt. A general "send without the intent" helper is a bypass wearing a
 * name; this one cannot send an ordinary message at all, so the guard's single
 * exemption is enforced by its signature rather than by its documentation.
 *
 * Verify the server side at `ws-handlers/send-message.ts:54` (docs/154, on
 * `main` since 35719d01 — absent from older builds, so check the branch you are
 * reading): `handleSendMessage` opens with
 *
 *     if (goalCommand && (caps?.supportsGoals ?? false) && mode !== "turn")
 *
 * which calls `handleGoalCommand` and returns, ahead of the queue, the branch
 * reset and `decideCompactBeforeTurn`. A `/goal` whose action IS a "turn" falls
 * through that branch and takes `sendUserTurn` above, which carries the intent.
 */
export function sendGoalControlFrame(
  goalText: string,
  sessionId: string,
  dispatch: (frame: Record<string, unknown>) => boolean,
): boolean {
  return dispatch({ type: "send_message", text: goalText, sessionId });
}
