import { usePrStore } from "../stores/pr-store.js";
import { getSavedMergeContinueOptOut } from "./local-storage.js";

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
 * `explicit` lets the composer, which knows whether it actually *showed* the
 * control, state its own answer; every other producer passes nothing.
 */
export interface MergeContinueFrameFields {
  resetMergedBranch?: boolean;
  compactContext?: boolean;
}

export function mergeContinueFrameFields(
  sessionId: string | undefined,
  explicit?: MergeContinueFrameFields,
): MergeContinueFrameFields {
  const optOut = sessionId
    ? usePrStore.getState().mergeContinueOptOutBySession[sessionId]
      ?? getSavedMergeContinueOptOut(sessionId)
    : {};
  const reset = explicit?.resetMergedBranch ?? (optOut.reset ? false : undefined);
  const compact = explicit?.compactContext ?? (optOut.compact ? false : undefined);
  return {
    ...(reset !== undefined ? { resetMergedBranch: reset } : {}),
    ...(compact !== undefined ? { compactContext: compact } : {}),
  };
}
