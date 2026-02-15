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

  // Disable text selection while dragging
  useEffect(() => {
    if (isDragging) {
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
    } else {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    }
  }, [isDragging]);

  return { fraction, isDragging, onMouseDown, containerRef };
}
