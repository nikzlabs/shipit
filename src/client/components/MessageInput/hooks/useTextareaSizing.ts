import { useLayoutEffect } from "react";
import type { RefObject } from "react";

const SUPPORTS_FIELD_SIZING =
  typeof CSS !== "undefined" && typeof CSS.supports === "function"
    ? CSS.supports("field-sizing", "content")
    : false;

export function useTextareaSizing(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  text: string,
) {
  useLayoutEffect(() => {
    if (SUPPORTS_FIELD_SIZING) return;
    const ta = textareaRef.current;
    if (!ta) return;

    // grow, never shrink when the user deletes text).
    ta.style.height = "auto";
    const next = ta.scrollHeight;
    if (next > 0) ta.style.height = `${next}px`;
  }, [text, textareaRef]);
}
