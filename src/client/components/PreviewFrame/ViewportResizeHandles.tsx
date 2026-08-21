// eslint-disable-next-line no-restricted-imports -- useEffect: document-level pointer listeners + body style pinning during drag (DOM sync)
import { useEffect, useRef, useState } from "react";
import { usePreviewStore } from "../../stores/preview-store.js";
import { CUSTOM_SIZE_MIN } from "../device-presets.js";

/** Which axes a grabbed handle resizes. */
export type ViewportDragAxis = "x" | "y" | "xy";

/**
 * One axis of a drag gesture (docs/278 req 2).
 *
 * The surface is center-anchored, so moving an edge by Δ changes the size by
 * 2Δ — divided by the gesture-start scale so the handle tracks the pointer
 * when the gesture begins on a scaled-down surface. The result is clamped to
 * `[CUSTOM_SIZE_MIN, max(available, start)]`: a drag exists to sweep
 * breakpoints at 1:1 with the edge under the cursor, so it cannot grow the
 * surface past what fits the panel — but a surface that *starts* larger than
 * the panel can be dragged smaller, continuously (at the fit boundary the
 * scale is exactly 1, so there is no jump anywhere in the gesture). Larger
 * sizes stay reachable by preset or typed input, which scale-to-fit.
 */
export function computeViewportResize(
  start: number,
  totalDelta: number,
  scale: number,
  available: number,
): number {
  const next = Math.round(start + (2 * totalDelta) / scale);
  const upper = Math.max(available, start, CUSTOM_SIZE_MIN);
  return Math.min(Math.max(next, CUSTOM_SIZE_MIN), upper);
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
 * Drag handles on the constrained preview surface: right edge (width), bottom
 * edge (height), corner (both). Dragging resizes the surface live through
 * `setFreeformSize` — while a named preset is active, the first move detaches
 * the selection into Custom at the dragged size (docs/278).
 *
 * Pointer-only affordances, deliberately: the accessible path to an exact size
 * is the labelled width/height inputs in the device menu, so the whole layer
 * is `aria-hidden` and nothing here is focusable.
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
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
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
    const onUp = () => {
      dragRef.current = null;
      setDragAxis(null);
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

  const renderedWidth = deviceWidth * deviceScale;
  const renderedHeight = deviceHeight * deviceScale;
  // Full literal class strings (Tailwind's scanner cannot see interpolations).
  const grip = (active: boolean) =>
    `rounded-full transition-[background-color] duration-(--duration-fast) ${
      active ? "bg-(--color-accent)" : "bg-(--color-border-secondary) group-hover:bg-(--color-accent)"
    }`;

  return (
    <>
      {/* Positioned identically to the device-framed iframe so the handles sit
          on the rendered edges at any scale. pointer-events pass through the
          wrapper; only the handles themselves are interactive. */}
      <div
        aria-hidden="true"
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
        <div
          data-testid="viewport-handle-x"
          onPointerDown={beginDrag("x")}
          className="group pointer-events-auto touch-none absolute top-1/2 -right-3.5 flex h-16 w-3.5 -translate-y-1/2 cursor-ew-resize items-center justify-center"
        >
          <div className={`h-10 w-1 ${grip(dragAxis === "x")}`} />
        </div>
        <div
          data-testid="viewport-handle-y"
          onPointerDown={beginDrag("y")}
          className="group pointer-events-auto touch-none absolute left-1/2 -bottom-3.5 flex h-3.5 w-16 -translate-x-1/2 cursor-ns-resize items-center justify-center"
        >
          <div className={`h-1 w-10 ${grip(dragAxis === "y")}`} />
        </div>
        <div
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
