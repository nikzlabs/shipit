// eslint-disable-next-line no-restricted-imports -- useEffect: document.body style manipulation during drag (DOM sync)
import { useState, useCallback, useRef, useEffect } from "react";

export interface UseResizablePanelOptions {
  /** Initial width of the left panel as a fraction (0–1). Default: 0.5 */
  initialFraction?: number;
  /** Minimum width of either panel as a fraction. Default: 0.25 */
  minFraction?: number;
  /** localStorage key for persisting the position. Omit to skip persistence. */
  storageKey?: string;
}

export interface UseResizablePanelReturn {
  /** Current left-panel width as a fraction (0–1) */
  fraction: number;
  /** Whether the user is currently dragging */
  isDragging: boolean;
  /** Attach to the resize handle's onMouseDown */
  onMouseDown: (e: React.MouseEvent) => void;
  /** Attach to the resize handle's onTouchStart for mobile/tablet drag */
  onTouchStart: (e: React.TouchEvent) => void;
  /** Ref to attach to the container element that holds both panels */
  containerRef: React.RefObject<HTMLDivElement | null>;
}

function loadFraction(key: string, fallback: number): number {
  try {
    const stored = localStorage.getItem(key);
    if (stored !== null) {
      const val = parseFloat(stored);
      if (!Number.isNaN(val) && val >= 0.1 && val <= 0.9) return val;
    }
  } catch {
    // localStorage unavailable — ignore
  }
  return fallback;
}

/**
 * Hook that manages a draggable divider between two horizontal panels.
 *
 * Usage:
 *   const { fraction, isDragging, onMouseDown, containerRef } = useResizablePanel();
 *   <div ref={containerRef} style={{ display: "flex" }}>
 *     <div style={{ width: `${fraction * 100}%` }}>Left</div>
 *     <div onMouseDown={onMouseDown} className="resize-handle" />
 *     <div style={{ width: `${(1 - fraction) * 100}%` }}>Right</div>
 *   </div>
 */
export function useResizablePanel(
  options: UseResizablePanelOptions = {}
): UseResizablePanelReturn {
  const {
    initialFraction = 0.5,
    minFraction = 0.25,
    storageKey,
  } = options;

  const [fraction, setFraction] = useState(() =>
    storageKey ? loadFraction(storageKey, initialFraction) : initialFraction
  );
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Persist to localStorage on change (debounced by the drag end)
  const persistRef = useRef(fraction);
  persistRef.current = fraction;

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);

      const onMouseMove = (moveEvent: MouseEvent) => {
        const container = containerRef.current;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        let newFraction = (moveEvent.clientX - rect.left) / rect.width;
        // Clamp within bounds
        newFraction = Math.max(minFraction, Math.min(1 - minFraction, newFraction));
        setFraction(newFraction);
      };

      const onMouseUp = () => {
        setIsDragging(false);
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        // Persist final position
        if (storageKey) {
          try {
            localStorage.setItem(storageKey, persistRef.current.toString());
          } catch {
            // ignore
          }
        }
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [minFraction, storageKey]
  );

  // Touch support — mirrors mouse logic but uses touch events
  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (e.touches.length !== 1) return;
      setIsDragging(true);

      const onTouchMove = (moveEvent: TouchEvent) => {
        const container = containerRef.current;
        if (!container || moveEvent.touches.length !== 1) return;
        const rect = container.getBoundingClientRect();
        let newFraction = (moveEvent.touches[0].clientX - rect.left) / rect.width;
        newFraction = Math.max(minFraction, Math.min(1 - minFraction, newFraction));
        setFraction(newFraction);
      };

      const onTouchEnd = () => {
        setIsDragging(false);
        document.removeEventListener("touchmove", onTouchMove);
        document.removeEventListener("touchend", onTouchEnd);
        document.removeEventListener("touchcancel", onTouchEnd);
        if (storageKey) {
          try {
            localStorage.setItem(storageKey, persistRef.current.toString());
          } catch {
            // ignore
          }
        }
      };

      document.addEventListener("touchmove", onTouchMove, { passive: true });
      document.addEventListener("touchend", onTouchEnd);
      document.addEventListener("touchcancel", onTouchEnd);
    },
    [minFraction, storageKey]
  );

  // Disable text selection while dragging.
  // The cleanup runs on isDragging→false AND on unmount, so a mid-drag unmount
  // (session switch, mobile drawer close) cannot leave userSelect: none welded
  // to <body> — which would block text selection across the entire app.
  // eslint-disable-next-line no-restricted-syntax -- DOM sync during drag
  useEffect(() => {
    if (!isDragging) return;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    return () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isDragging]);

  return { fraction, isDragging, onMouseDown, onTouchStart, containerRef };
}
