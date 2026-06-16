// eslint-disable-next-line no-restricted-imports -- useEffect: mirror per-session draft into localStorage
import { useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { getSavedDraftMessage, saveDraftMessage } from "../../../utils/local-storage.js";

/**
 * Per-session draft persistence: remember what the user has typed when they
 * switch to a different session, and recover it when they switch back. Keyed
 * off `focusKey`, which is the session identity from the composer's POV
 * ("new" for the new-session view, or the real session ID otherwise). We detect
 * focusKey changes during render — same pattern as the focus logic in the
 * component — so the swap is synchronous and doesn't flicker the previous text
 * into view for one frame. Saves on every keystroke as well (via the effect
 * below) so the draft also survives reloads, not just session swaps.
 *
 * Skipped for the overlay surface (`persistDraft === false`): the quick-capture
 * overlay is a fresh "new session" launcher, not a per-session composer —
 * restoring whatever the user last typed there on each open is surprising
 * rather than helpful.
 */
export function useMessageDraft({
  focusKey,
  persistDraft,
  text,
  setText,
}: {
  focusKey: string | undefined;
  persistDraft: boolean;
  text: string;
  setText: Dispatch<SetStateAction<string>>;
}) {
  const draftFocusKeyRef = useRef<string | undefined>(undefined);
  if (persistDraft && focusKey !== draftFocusKeyRef.current) {
    // Persist the *previous* session's text under its key before swapping in
    // the new session's draft. `text` here is still the previous session's
    // value because state updates from this branch haven't applied yet.
    if (draftFocusKeyRef.current) {
      saveDraftMessage(draftFocusKeyRef.current, text);
    }
    draftFocusKeyRef.current = focusKey;
    const loaded = focusKey ? getSavedDraftMessage(focusKey) ?? "" : "";
    if (loaded !== text) setText(loaded);
  }

  // Mirror text into localStorage so the draft also survives a tab refresh.
  // Declared AFTER the prefill effect below in mount-time effect ordering so
  // a freshly-consumed prefill is what gets persisted (not the empty default).
  // eslint-disable-next-line no-restricted-syntax -- per-session draft persistence
  useEffect(() => {
    if (persistDraft && focusKey) saveDraftMessage(focusKey, text);
  }, [text, focusKey, persistDraft]);
}
