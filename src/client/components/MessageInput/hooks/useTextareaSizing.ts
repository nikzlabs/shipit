import { useLayoutEffect } from "react";
import type { RefObject } from "react";

// `field-sizing: content` (the CSS that grows the textarea with its content)
// is supported on Chrome/Edge and Firefox desktop, but missing on Firefox for
// Android and Safari. When unsupported we resize manually in a layout effect.
const SUPPORTS_FIELD_SIZING =
  typeof CSS !== "undefined" && typeof CSS.supports === "function"
    ? CSS.supports("field-sizing", "content")
    : false;

/**
 * Fallback auto-grow for browsers without `field-sizing: content` support
 * (most notably Firefox on Android). On supported browsers the CSS does this
 * natively, so we short-circuit. The max-height cap stays on the element via
 * Tailwind's `max-h-[40vh]` and is honored by both paths.
 */
export function useTextareaSizing(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  text: string,
) {
  useLayoutEffect(() => {
    if (SUPPORTS_FIELD_SIZING) return;
    const ta = textareaRef.current;
    if (!ta) return;
    // Collapse first so scrollHeight reflects the content height, not the
    // previously-set inline height (otherwise the textarea would only ever
    // grow, never shrink when the user deletes text).
    ta.style.height = "auto";
    const next = ta.scrollHeight;
    if (next > 0) ta.style.height = `${next}px`;
  }, [text, textareaRef]);
}
