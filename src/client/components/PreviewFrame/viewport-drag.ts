import { clampViewportSize } from "../device-presets.js";

/** Which edge of the framed viewport a drag started from. */
export type ResizeEdge = "right" | "bottom" | "corner";

/** The framed viewport as it stood when a drag began. */
export interface DragAnchor {
  /** Rendered width in CSS px of the previewed viewport (post-rotation). */
  width: number;
  /** Rendered height in CSS px of the previewed viewport (post-rotation). */
  height: number;
  /** Scale the frame was drawn at when the drag started. */
  scale: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

/**
 * The frame is centred in the panel, so each edge moves outward by only HALF of
 * any size increase. For the dragged edge to stay under the pointer, a pointer
 * delta has to buy twice as much viewport.
 */
const CENTRED_EDGE_FACTOR = 2;

/**
 * The viewport size a drag has reached, from the size it started at and how far
 * the pointer has moved since.
 *
 * Deltas are divided by the scale captured **at drag start**, not the live one.
 * Scale-to-fit shrinks the frame as the viewport grows, so a live divisor is a
 * feedback loop: each move changes the scale that the next move is measured
 * with. Against the start scale the edge tracks the pointer exactly until the
 * viewport outgrows the panel, and past that point the frame stays pinned at
 * the panel's edge while the number keeps climbing — which is what the readout
 * says is happening, and is how you reach a 1280px viewport in a 700px panel.
 */
export function sizeFromDrag(
  edge: ResizeEdge,
  anchor: DragAnchor,
  dx: number,
  dy: number,
): ViewportSize {
  // A zero or negative scale would divide the drag into nonsense. It can only
  // arise before the panel has been measured, when there is nothing to drag.
  const scale = anchor.scale > 0 ? anchor.scale : 1;
  const width = edge === "bottom"
    ? clampViewportSize(anchor.width)
    : clampViewportSize(anchor.width + (CENTRED_EDGE_FACTOR * dx) / scale);
  const height = edge === "right"
    ? clampViewportSize(anchor.height)
    : clampViewportSize(anchor.height + (CENTRED_EDGE_FACTOR * dy) / scale);
  return { width, height };
}

/**
 * Convert a size as *rendered* back to the size as *stored*.
 *
 * Landscape is applied at render time by swapping the stored width and height
 * (see `useDeviceFrame`), so a drag — which necessarily works in rendered
 * space — has to swap back before committing, or rotating afterwards would
 * transpose the size the user just dragged out.
 */
export function toStoredSize(rendered: ViewportSize, isLandscape: boolean): ViewportSize {
  return isLandscape
    ? { width: rendered.height, height: rendered.width }
    : { width: rendered.width, height: rendered.height };
}

/** Step in px applied by one arrow-key press on a resize handle. */
export const KEYBOARD_RESIZE_STEP = 10;

/**
 * The viewport size an arrow key produces, or `null` for a key this handle does
 * not act on (so the caller can leave the event alone).
 *
 * The keyboard path deliberately does NOT go through {@link sizeFromDrag}: a
 * key press is a request for a fixed number of viewport px, with no pointer to
 * keep under an edge, so the centred-edge doubling would make every press move
 * twice as far as the step it advertises.
 */
export function sizeFromArrowKey(
  edge: ResizeEdge,
  current: ViewportSize,
  key: string,
): ViewportSize | null {
  const horizontal = edge !== "bottom";
  const vertical = edge !== "right";
  if (horizontal && (key === "ArrowRight" || key === "ArrowLeft")) {
    const delta = key === "ArrowRight" ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP;
    return { width: clampViewportSize(current.width + delta), height: current.height };
  }
  if (vertical && (key === "ArrowDown" || key === "ArrowUp")) {
    const delta = key === "ArrowDown" ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP;
    return { width: current.width, height: clampViewportSize(current.height + delta) };
  }
  return null;
}
