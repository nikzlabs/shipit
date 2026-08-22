// eslint-disable-next-line no-restricted-imports -- useEffect: document-level pointer listeners + body style pinning during drag (DOM sync)
import { useEffect, useRef, useState } from "react";
import { usePreviewStore } from "../../stores/preview-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import { CUSTOM_SIZE_MIN, CUSTOM_SIZE_MAX } from "../device-presets.js";

/** Which axes a grabbed handle resizes. */
export type ViewportDragAxis = "x" | "y" | "xy";

/**
 * One axis of a drag gesture (docs/278 req 2).
 *
 * The surface is center-anchored, so moving an edge by Δ changes the size by
 * 2Δ — divided by the gesture-start scale so the handle tracks the pointer
 * when the gesture begins on a scaled-down surface. The result is clamped to
 * `[CUSTOM_SIZE_MIN, min(CUSTOM_SIZE_MAX, max(available, start))]`: a drag
 * exists to sweep breakpoints at 1:1 with the edge under the cursor, so it
 * cannot grow the surface past what fits the panel — but a surface that
 * *starts* larger than the panel can be dragged smaller, continuously (at the
 * fit boundary the scale is exactly 1, so there is no jump anywhere in the
 * gesture). Larger sizes stay reachable by preset or typed input, which
 * scale-to-fit. `CUSTOM_SIZE_MAX` caps everything: on a panel wider than the
 * absolute bound, an uncapped drag could create a size the persisted-viewport
 * validation rejects, silently dropping that session's memory.
 */
export function computeViewportResize(
  start: number,
  totalDelta: number,
  scale: number,
  available: number,
): number {
  const next = Math.round(start + (2 * totalDelta) / scale);
  const upper = Math.min(CUSTOM_SIZE_MAX, Math.max(available, start, CUSTOM_SIZE_MIN));
  return Math.min(Math.max(next, CUSTOM_SIZE_MIN), upper);
}

/** Viewport px one arrow-key press moves a handle by. */
export const KEYBOARD_RESIZE_STEP = 10;

/**
 * The size an arrow key produces on an edge slider, or `null` for a key that
 * slider does not act on (so the caller leaves the event alone — an unhandled
 * arrow must still scroll the panel). Keyboard resize is per-edge only: the
 * corner is a pointer-only convenience, because a `role="button"` that answers
 * arrows but not Enter/Space lies to assistive technology, and both axes are
 * already reachable through the two sliders.
 *
 * Deliberately NOT `computeViewportResize`: a key press asks for a fixed
 * number of viewport px — there is no pointer to keep under an edge, so the
 * centred-edge doubling would move every press twice its advertised step, and
 * the drag's fit-the-panel clamp doesn't apply either. Like typed input, a key
 * press may step past the panel and scale-to-fit absorbs it; only the absolute
 * bounds hold.
 */
export function computeKeyboardResize(
  axis: Exclude<ViewportDragAxis, "xy">,
  current: { width: number; height: number },
  key: string,
): { width: number; height: number } | null {
  const clamp = (v: number) => Math.min(Math.max(v, CUSTOM_SIZE_MIN), CUSTOM_SIZE_MAX);
  if (axis === "x" && (key === "ArrowRight" || key === "ArrowLeft")) {
    const delta = key === "ArrowRight" ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP;
    return { width: clamp(current.width + delta), height: current.height };
  }
  if (axis === "y" && (key === "ArrowDown" || key === "ArrowUp")) {
    const delta = key === "ArrowDown" ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP;
    return { width: current.width, height: clamp(current.height + delta) };
  }
  return null;
}

const AXIS_CURSOR: Record<ViewportDragAxis, string> = {
  x: "ew-resize",
  y: "ns-resize",
  xy: "nwse-resize",
};

interface DragGesture {
  axis: ViewportDragAxis;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
  scale: number;
  availableWidth: number;
  availableHeight: number;
  /**
   * The session the gesture belongs to. `PreviewFrame` stays mounted across
   * session switches, so an unmount is not guaranteed to end a gesture — and a
   * move that lands after a switch would resize A's geometry into B's viewport
   * memory (`setFreeformSize` keys persistence by the *current* session). A
   * mismatch ends the gesture instead.
   */
  sessionId: string | undefined;
}

export interface ViewportResizeHandlesProps {
  /** Effective (orientation-applied) viewport dims, from `useDeviceFrame`. */
  deviceWidth: number;
  deviceHeight: number;
  /** Scale-to-fit factor for the rendered surface. */
  deviceScale: number;
  /** The box a 100%-scale surface can occupy (panel minus frame padding). */
  availableWidth: number;
  availableHeight: number;
}

/**
 * Resize handles on the constrained preview surface: right edge (width),
 * bottom edge (height), corner (both). Dragging resizes the surface live
 * through `setFreeformSize` — while a named preset is active, the first move
 * detaches the selection into Custom at the dragged size (docs/278).
 *
 * The edge handles are focusable `role="slider"`s (req 9): arrow keys step
 * their own axis by {@link KEYBOARD_RESIZE_STEP} and `aria-value*` announces
 * the size, so the freeform size is reachable without a pointer. Their
 * `aria-orientation` matches the ARROW-KEY axis (width = horizontal, height =
 * vertical), never the grip's drawn bar — announcing the bar's direction told
 * assistive-technology users the opposite keys from the ones implemented. The
 * corner is a pointer-only convenience (`aria-hidden`): both axes are already
 * keyboard-reachable through the sliders, and any focusable role here would
 * promise semantics (Enter/Space, a single value) it cannot honour. The
 * labelled menu inputs remain the exact-entry path.
 *
 * While a gesture is live, a transparent shield covers the panel so the iframe
 * cannot swallow pointer events (the same problem `AppLayout` solves for the
 * panel divider with `pointer-events-none`), and a size badge floats at the
 * top of the panel — the toolbar indicator is live too, but the eye is on the
 * surface (req 5).
 */
export function ViewportResizeHandles({
  deviceWidth,
  deviceHeight,
  deviceScale,
  availableWidth,
  availableHeight,
}: ViewportResizeHandlesProps) {
  const dragRef = useRef<DragGesture | null>(null);
  const [dragAxis, setDragAxis] = useState<ViewportDragAxis | null>(null);

  const beginDrag = (axis: ViewportDragAxis) => (e: React.PointerEvent) => {
    // Primary button/contact only (0 for left mouse AND first touch); a
    // degenerate scale (unmeasured or sliver panel) would divide the gesture
    // math by ~0, so refuse to start instead.
    if (e.button !== 0) return;
    if (deviceScale <= 0) return;
    e.preventDefault();
    dragRef.current = {
      axis,
      startX: e.clientX,
      startY: e.clientY,
      startWidth: deviceWidth,
      startHeight: deviceHeight,
      scale: deviceScale,
      availableWidth,
      availableHeight,
      sessionId: useSessionStore.getState().sessionId,
    };
    setDragAxis(axis);
  };

  // The active gesture: document-level listeners so the pointer can leave the
  // handle, body cursor/user-select pinned. Owned by an effect keyed on the
  // gesture so cleanup runs on pointerup AND on a mid-drag unmount (session
  // switch) — the same unmount-safety `useResizablePanel` documents.
  // eslint-disable-next-line no-restricted-syntax -- document listeners + body style for the live drag gesture (DOM sync)
  useEffect(() => {
    if (!dragAxis) return;
    const onUp = () => {
      dragRef.current = null;
      setDragAxis(null);
    };
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      // The session changed under a live gesture (see DragGesture.sessionId):
      // end it rather than resize the incoming session's viewport.
      if (drag.sessionId !== useSessionStore.getState().sessionId) {
        onUp();
        return;
      }
      const width =
        drag.axis === "y"
          ? drag.startWidth
          : computeViewportResize(drag.startWidth, e.clientX - drag.startX, drag.scale, drag.availableWidth);
      const height =
        drag.axis === "x"
          ? drag.startHeight
          : computeViewportResize(drag.startHeight, e.clientY - drag.startY, drag.scale, drag.availableHeight);
      usePreviewStore.getState().setFreeformSize(width, height);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = AXIS_CURSOR[dragAxis];
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [dragAxis]);

  // A key press asks for the size relative to what is on screen now.
  const onArrowKey = (axis: Exclude<ViewportDragAxis, "xy">) => (e: React.KeyboardEvent) => {
    const next = computeKeyboardResize(axis, { width: deviceWidth, height: deviceHeight }, e.key);
    if (!next) return;
    // Otherwise the arrow scrolls the panel out from under the handle.
    e.preventDefault();
    usePreviewStore.getState().setFreeformSize(next.width, next.height);
  };

  const renderedWidth = deviceWidth * deviceScale;
  const renderedHeight = deviceHeight * deviceScale;
  // Full literal class strings (Tailwind's scanner cannot see interpolations).
  // The grip is the focus indicator too: the handle itself drops the outline
  // (a box around an invisible hit area reads as a rendering artifact) and the
  // pill goes accent on keyboard focus instead, the same signal hover gives.
  const grip = (active: boolean) =>
    `rounded-full transition-[background-color] duration-(--duration-fast) ${
      active
        ? "bg-(--color-accent)"
        : "bg-(--color-border-secondary) group-hover:bg-(--color-accent) group-focus-visible:bg-(--color-accent)"
    }`;

  return (
    <>
      {/* Positioned identically to the device-framed iframe so the handles sit
          on the rendered edges at any scale. pointer-events pass through the
          wrapper; only the handles themselves are interactive. */}
      <div
        data-testid="viewport-resize-handles"
        className="absolute pointer-events-none"
        style={{
          width: `${renderedWidth}px`,
          height: `${renderedHeight}px`,
          left: "50%",
          top: "50%",
          transform: "translate(-50%, -50%)",
        }}
      >
        {/* `role="slider"` because that is what arrow keys on a single-axis
            grip mean, and it hands a screen reader the number. Orientation
            names the arrow-key axis the value moves on — NOT the grip's drawn
            bar, which is perpendicular to it. */}
        <div
          data-testid="viewport-handle-x"
          role="slider"
          aria-label="Resize the preview width"
          aria-orientation="horizontal"
          aria-valuemin={CUSTOM_SIZE_MIN}
          aria-valuemax={CUSTOM_SIZE_MAX}
          aria-valuenow={deviceWidth}
          aria-valuetext={`${deviceWidth} pixels wide`}
          tabIndex={0}
          onPointerDown={beginDrag("x")}
          onKeyDown={onArrowKey("x")}
          className="group pointer-events-auto touch-none absolute top-1/2 -right-3.5 flex h-16 w-3.5 -translate-y-1/2 cursor-ew-resize items-center justify-center focus:outline-none"
        >
          <div className={`h-10 w-1 ${grip(dragAxis === "x")}`} />
        </div>
        <div
          data-testid="viewport-handle-y"
          role="slider"
          aria-label="Resize the preview height"
          aria-orientation="vertical"
          aria-valuemin={CUSTOM_SIZE_MIN}
          aria-valuemax={CUSTOM_SIZE_MAX}
          aria-valuenow={deviceHeight}
          aria-valuetext={`${deviceHeight} pixels tall`}
          tabIndex={0}
          onPointerDown={beginDrag("y")}
          onKeyDown={onArrowKey("y")}
          className="group pointer-events-auto touch-none absolute left-1/2 -bottom-3.5 flex h-3.5 w-16 -translate-x-1/2 cursor-ns-resize items-center justify-center focus:outline-none"
        >
          <div className={`h-1 w-10 ${grip(dragAxis === "y")}`} />
        </div>
        {/* Pointer-only convenience (see the component docstring): both axes
            are keyboard-reachable through the sliders above, so this carries
            no role, no focus, and no announcement. */}
        <div
          aria-hidden="true"
          data-testid="viewport-handle-xy"
          onPointerDown={beginDrag("xy")}
          className="group pointer-events-auto touch-none absolute -right-3.5 -bottom-3.5 flex h-5 w-5 cursor-nwse-resize items-center justify-center"
        >
          <div className={`h-2 w-2 ${grip(dragAxis === "xy")}`} />
        </div>
      </div>
      {dragAxis && (
        <>
          {/* Shield: keeps the gesture's pointer events in this document — an
              iframe under the pointer would swallow them and freeze the drag. */}
          <div
            aria-hidden="true"
            data-testid="viewport-drag-shield"
            className="absolute inset-0"
            style={{ cursor: AXIS_CURSOR[dragAxis] }}
          />
          <div
            aria-hidden="true"
            data-testid="viewport-drag-badge"
            className="absolute top-2 left-1/2 -translate-x-1/2 rounded-md border border-(--color-border-primary) bg-(--color-bg-elevated) px-2 py-0.5 text-xs tabular-nums text-(--color-text-primary) shadow-sm pointer-events-none"
          >
            {deviceWidth} × {deviceHeight}
          </div>
        </>
      )}
    </>
  );
}
