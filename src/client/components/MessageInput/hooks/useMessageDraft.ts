// eslint-disable-next-line no-restricted-imports -- useEffect: mirror per-session draft into localStorage
import { useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { getSavedDraftMessage, saveDraftMessage } from "../../../utils/local-storage.js";

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

    // value because state updates from this branch haven't applied yet.
    if (draftFocusKeyRef.current) {
      saveDraftMessage(draftFocusKeyRef.current, text);
    }
    draftFocusKeyRef.current = focusKey;
    const loaded = focusKey ? getSavedDraftMessage(focusKey) ?? "" : "";
    if (loaded !== text) setText(loaded);
  }

  // Declared AFTER the prefill effect below in mount-time effect ordering so

  // eslint-disable-next-line no-restricted-syntax -- per-session draft persistence
  useEffect(() => {
    if (persistDraft && focusKey) saveDraftMessage(focusKey, text);
  }, [text, focusKey, persistDraft]);
}
