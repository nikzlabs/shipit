import { useRef, useLayoutEffect, type RefObject } from "react";
import { ChatTeardropTextIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import type { SelectionSnapshot } from "./types.js";

/**
 * Floating "Comment" button anchored to the live selection.
 *
 * Position the floating button against the latest selection rect. We use
 * `position: absolute` relative to `containerRef` (which is `position:
 * relative`) rather than `position: fixed`, because the markdown can be
 * rendered inside a transformed ancestor (e.g. Radix DialogContent uses
 * `-translate-x-1/2 -translate-y-1/2` to centre itself). A transformed
 * ancestor becomes the containing block for `position: fixed` descendants,
 * which silently breaks viewport-relative coordinates — the button drifts
 * toward the side of the screen. `position: absolute` relative to the
 * markdown body avoids the trap entirely and also keeps the button anchored
 * to the text when the dialog body scrolls.
 *
 * Strategy: prefer placing the button below the LAST line of the selection,
 * centred horizontally on that line. If there's no room below the viewport,
 * fall back to above the FIRST line. Horizontal position is clamped to the
 * container width so the button stays next to the selected text.
 */
export function FloatingCommentButton({
  snapshot,
  containerRef,
  onStart,
}: {
  snapshot: SelectionSnapshot;
  containerRef: RefObject<HTMLDivElement | null>;
  onStart: () => void;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const el = buttonRef.current;
    const container = containerRef.current;
    if (!el || !container || !snapshot) return;
    const containerRect = container.getBoundingClientRect();
    const margin = 6;
    const edgePad = 4;
    const bH = el.offsetHeight;
    const bW = el.offsetWidth;

    const spaceBelow = window.innerHeight - snapshot.last.bottom;
    const placeBelow = spaceBelow >= bH + margin + edgePad;
    const anchor = placeBelow ? snapshot.last : snapshot.first;
    const top = placeBelow
      ? anchor.bottom - containerRect.top + margin
      : anchor.top - containerRect.top - bH - margin;

    const desiredLeft =
      anchor.left - containerRect.left + anchor.width / 2 - bW / 2;
    const minLeft = edgePad;
    const maxLeft = Math.max(edgePad, containerRect.width - bW - edgePad);
    const left = Math.max(minLeft, Math.min(desiredLeft, maxLeft));

    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
  }, [snapshot, containerRef]);

  return (
    <button
      ref={buttonRef}
      onMouseDown={(e) => {
        // preventDefault stops the click from collapsing the selection or
        // moving focus to the button. stopPropagation stops Radix Dialog's
        // outside-click detection (and any other ancestor listeners) from
        // swallowing the event.
        e.preventDefault();
        e.stopPropagation();
        onStart();
      }}
      className="absolute z-50 flex items-center gap-1 px-2 py-1 rounded bg-(--color-bg-elevated) border border-(--color-border-secondary) text-xs text-(--color-text-primary) shadow-lg hover:brightness-125 hover:border-(--color-border-primary) cursor-pointer"
      title="Comment on this selection"
    >
      <ChatTeardropTextIcon size={ICON_SIZE.SM} />
      Comment
    </button>
  );
}
