import { useRef, useState } from "react";
import { VIEWPORT_SIZE_MAX, VIEWPORT_SIZE_MIN } from "../device-presets.js";
import {
  sizeFromArrowKey,
  sizeFromDrag,
  toStoredSize,
  type DragAnchor,
  type ResizeEdge,
  type ViewportSize,
} from "./viewport-drag.js";

interface ViewportResizeHandlesProps {
  /** Rendered viewport width in CSS px (already rotated). */
  deviceWidth: number;
  /** Rendered viewport height in CSS px (already rotated). */
  deviceHeight: number;
  /** Scale the frame is drawn at, so a pointer delta converts to viewport px. */
  deviceScale: number;
  /** Whether the frame is rotated, so a dragged size is stored the right way round. */
  isLandscape: boolean;
  /** Commit a new freeform size, in STORED (un-rotated) orientation. */
  onResize: (size: ViewportSize) => void;
}

/** Thickness in px of a handle's pointer target. Wider than the pill it draws. */
const HIT_SIZE = 14;

const CURSOR: Record<ResizeEdge, string> = {
  right: "cursor-ew-resize",
  bottom: "cursor-ns-resize",
  corner: "cursor-nwse-resize",
};

/**
 * Drag handles on the right edge, bottom edge and bottom-right corner of the
 * framed viewport.
 *
 * Only three, because the frame is CENTRED: a left handle and a right handle
 * would set the same number, so a fourth is a control that does nothing new.
 *
 * The interaction runs on pointer capture taken by the handle itself, so there
 * are no window listeners and no effect to clean up — and, more to the point,
 * the drag survives crossing the iframe, which would otherwise swallow every
 * move event the moment the pointer left the handle. The shield at the bottom
 * covers the cursor, which capture does not carry across a document boundary.
 */
export function ViewportResizeHandles({
  deviceWidth,
  deviceHeight,
  deviceScale,
  isLandscape,
  onResize,
}: ViewportResizeHandlesProps) {
  const [draggingEdge, setDraggingEdge] = useState<ResizeEdge | null>(null);
  const dragRef = useRef<{ edge: ResizeEdge; x: number; y: number; anchor: DragAnchor } | null>(null);

  // Where each handle sits, in the container's own coordinates. The frame is
  // centred, so half the *rendered* extent from the middle reaches its edge.
  const halfRenderedWidth = (deviceWidth * deviceScale) / 2;
  const halfRenderedHeight = (deviceHeight * deviceScale) / 2;

  const commit = (rendered: ViewportSize) => onResize(toStoredSize(rendered, isLandscape));

  const startDrag = (edge: ResizeEdge) => (e: React.PointerEvent<HTMLDivElement>) => {
    // Left button / primary touch only — a right-click must not start a drag.
    if (e.button !== 0) return;
    e.preventDefault();
    // Capture is what carries the drag across the iframe; it is not what makes
    // the drag work. Acquiring it can fail (no live pointer for this id, or a
    // host that doesn't implement it), and a drag that still tracks while the
    // pointer stays over the handle beats one that refuses to start.
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* uncaptured drag */ }
    dragRef.current = {
      edge,
      x: e.clientX,
      y: e.clientY,
      anchor: { width: deviceWidth, height: deviceHeight, scale: deviceScale },
    };
    setDraggingEdge(edge);
  };

  const moveDrag = (edge: ResizeEdge) => (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag?.edge !== edge) return;
    commit(sizeFromDrag(edge, drag.anchor, e.clientX - drag.x, e.clientY - drag.y));
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    dragRef.current = null;
    setDraggingEdge(null);
  };

  const pressKey = (edge: ResizeEdge) => (e: React.KeyboardEvent<HTMLDivElement>) => {
    const next = sizeFromArrowKey(edge, { width: deviceWidth, height: deviceHeight }, e.key);
    if (!next) return;
    // Otherwise the arrow scrolls the panel out from under the handle.
    e.preventDefault();
    commit(next);
  };

  /** One handle: an invisible pointer target wrapped around a small visible pill. */
  const handle = (
    edge: ResizeEdge,
    a11y: React.AriaAttributes & { role: string },
    box: React.CSSProperties,
    pill: string,
  ) => (
    <div
      {...a11y}
      tabIndex={0}
      style={box}
      onPointerDown={startDrag(edge)}
      onPointerMove={moveDrag(edge)}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={pressKey(edge)}
      // `touch-none`: without it a touch drag pans the panel instead of resizing.
      className={`group/vh absolute z-20 flex items-center justify-center -translate-x-1/2 -translate-y-1/2 touch-none focus:outline-none ${CURSOR[edge]}`}
    >
      <span
        aria-hidden="true"
        className={`block rounded-full transition-[background-color] duration-[var(--duration-fast)] ${pill} ${
          draggingEdge === edge
            ? "bg-(--color-accent)"
            : "bg-(--color-border-secondary) group-hover/vh:bg-(--color-accent) group-focus-visible/vh:bg-(--color-accent)"
        }`}
      />
    </div>
  );

  return (
    <>
      {/* Right edge — width. `role="slider"` because that is what arrow keys on
          a single-axis grip mean, and it gives a screen reader the number. */}
      {handle(
        "right",
        {
          role: "slider",
          "aria-label": "Drag to resize the preview width",
          "aria-orientation": "vertical",
          "aria-valuemin": VIEWPORT_SIZE_MIN,
          "aria-valuemax": VIEWPORT_SIZE_MAX,
          "aria-valuenow": deviceWidth,
          "aria-valuetext": `${deviceWidth} pixels wide`,
        },
        {
          left: `calc(50% + ${halfRenderedWidth}px)`,
          top: "50%",
          width: HIT_SIZE,
          height: Math.max(HIT_SIZE, deviceHeight * deviceScale),
        },
        "w-1 h-8",
      )}

      {/* Bottom edge — height. */}
      {handle(
        "bottom",
        {
          role: "slider",
          "aria-label": "Drag to resize the preview height",
          "aria-orientation": "horizontal",
          "aria-valuemin": VIEWPORT_SIZE_MIN,
          "aria-valuemax": VIEWPORT_SIZE_MAX,
          "aria-valuenow": deviceHeight,
          "aria-valuetext": `${deviceHeight} pixels tall`,
        },
        {
          top: `calc(50% + ${halfRenderedHeight}px)`,
          left: "50%",
          height: HIT_SIZE,
          width: Math.max(HIT_SIZE, deviceWidth * deviceScale),
        },
        "h-1 w-8",
      )}

      {/* Bottom-right corner — both axes at once, so no single slider value fits. */}
      {handle(
        "corner",
        {
          role: "button",
          "aria-label": `Drag to resize the preview width and height (currently ${deviceWidth} by ${deviceHeight} pixels)`,
        },
        {
          left: `calc(50% + ${halfRenderedWidth}px)`,
          top: `calc(50% + ${halfRenderedHeight}px)`,
          width: HIT_SIZE,
          height: HIT_SIZE,
        },
        "w-2.5 h-2.5",
      )}

      {/* Cursor shield. Pointer capture keeps the EVENTS coming while the
          pointer is over the iframe, but the cursor is resolved by whichever
          document it is over — so without this it flickers to the previewed
          page's cursor mid-drag, and that page shows hover states for a pointer
          that is busy elsewhere. */}
      {draggingEdge && (
        <div aria-hidden="true" className={`absolute inset-0 z-30 ${CURSOR[draggingEdge]}`} />
      )}
    </>
  );
}
