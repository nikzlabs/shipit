// eslint-disable-next-line no-restricted-imports -- useEffect: document.body style manipulation during drag (DOM sync)
import { useState, useCallback, useRef, useEffect } from "react";

export interface UseResizablePanelOptions {

  initialFraction?: number;

  minFraction?: number;

  storageKey?: string;
}

export interface UseResizablePanelReturn {

  fraction: number;

  isDragging: boolean;

  onMouseDown: (e: React.MouseEvent) => void;

  onTouchStart: (e: React.TouchEvent) => void;

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

        newFraction = Math.max(minFraction, Math.min(1 - minFraction, newFraction));
        setFraction(newFraction);
      };

      const onMouseUp = () => {
        setIsDragging(false);
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);

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

  // (session switch, mobile drawer close) cannot leave userSelect: none welded

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
