import { useRef, useLayoutEffect, type RefObject } from "react";
import { ChatTeardropTextIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import type { SelectionSnapshot } from "./types.js";

/** Position the comment button within the transformed markdown container. */
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
        // Preserve the selection and avoid Radix outside-click handling.
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
