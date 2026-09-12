import { usePrStore } from "../stores/pr-store.js";
import { getSavedMergeContinueOptOut, readOptOutSessionKey } from "./local-storage.js";

/**
 * docs/218 + docs/295 — the per-send intent for the two post-merge controls, as
 * the fields a `send_message` frame carries. **Every producer of that frame
 * calls this; none of them spreads the fields itself.**
 *
 * That rule is the whole point of the file. The flags used to be spread by hand
 * at each call site, and `send-handler.ts` was the only site that did it — so
 * the five `send_message` producers in `App.tsx` (the action-card button, the
 * two release-card buttons, the review-comments submit and "ask the agent to
 * review this file") all sent neither flag. An OMITTED field falls back to the
 * global setting, so a user who unticked "Compact the context" and then pressed
 * a button on a card got compacted anyway, silently, while their untick sat on
 * screen untouched. docs/293 had already closed exactly this omission for the
 * `/review` branch *inside* `runSend` — the class was known, and closing it in
 * one place is what let the other five drift.
 *
 * **A click is not a programmatic continuation.** docs/295 req 13 sends a
 * continuation "the user did not type" to the global setting, and its stated
 * reason is that such a continuation "has no checkbox, so the setting alone
 * decides". A card button is pressed by the user, in the view the checkbox is
 * in, often in the same breath as unticking it — the checkbox is right there,
 * and req 5 says an untick applies to the user's next message. So these frames
 * honour it. A continuation with genuinely no checkbox — a wake turn, a
 * `shipit session message`, a click inside an agent-built page — never reaches
 * this function and is unaffected.
 *
 * Only an opt-out is carried. A ticked control needs no field: absent and
 * `true` both mean "do it", and the server's own eligibility gates still apply.
 * The composer used to pass its own answer here as well. That was a second
 * authority over state the composer and the sender now share: with the control
 * shown and ticked it said `true`, and an omitted field means the same thing to
 * the server. One reader, one rule.
 */
export interface MergeContinueFrameFields {
  resetMergedBranch?: boolean;
  compactContext?: boolean;
}

export function mergeContinueFrameFields(
  sessionId: string | undefined,
): MergeContinueFrameFields {
  const optOut = sessionId
    ? usePrStore.getState().mergeContinueOptOutBySession[sessionId]
      ?? getSavedMergeContinueOptOut(sessionId)
    : {};
  return {
    ...(optOut.reset ? { resetMergedBranch: false } : {}),
    ...(optOut.compact ? { compactContext: false } : {}),
  };
}

/**
 * The untick applied to ONE message (req 5), and this is where that message is
 * declared gone. Called only on a send that actually reached the wire, so a
 * refused or dropped send leaves the user's choice intact for their retry.
 *
 * Paired with `mergeContinueFrameFields` on purpose: read and consume live in
 * one module, and `sendUserTurn` / `dispatchAgentMessage` are the only callers,
 * so no producer can carry the intent and then forget to spend it. That was the
 * first shape of this fix and it was wrong — the action-card path read the
 * opt-out, sent it, and left it in place to govern every later message.
 */
export function consumeMergeContinueIntent(
  sessionId: string | undefined,
  carried: MergeContinueFrameFields,
): void {
  if (!sessionId) return;
  // Spend exactly what this send took, never "whatever is stored now". The HTTP
  // path snapshots the intent, awaits a response, and would otherwise delete an
  // untick the user made WHILE the request was in flight — a choice that send
  // never carried, for a message that has not gone yet.
  const store = usePrStore.getState();
  if (carried.resetMergedBranch === false) store.setMergeContinueOptOut(sessionId, "reset", false);
  if (carried.compactContext === false) store.setMergeContinueOptOut(sessionId, "compact", false);
}

/**
 * Keep every tab's view of the opt-out in step with the durable mirror.
 *
 * The composer memoises what it read, while a send reads afresh — so without
 * this, tab B could DISPLAY an unticked box while its next frame carried
 * nothing (tab A having sent and cleared the key), or display a ticked one
 * while the frame carried `false`. A control that disagrees with what it sends
 * is the whole defect class this feature keeps hitting, so the display and the
 * wire are pinned to one snapshot: the store, which this keeps true.
 *
 * `storage` fires only in the OTHER tabs, which is exactly the case that needs
 * it; the writing tab already went through the store.
 */
export function syncMergeContinueOptOutAcrossTabs(): () => void {
  const onStorage = (event: StorageEvent) => {
    const sessionId = readOptOutSessionKey(event.key);
    if (!sessionId) return;
    const stored = getSavedMergeContinueOptOut(sessionId);
    usePrStore.setState((state) => ({
      mergeContinueOptOutBySession: {
        ...state.mergeContinueOptOutBySession,
        [sessionId]: stored,
      },
    }));
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
