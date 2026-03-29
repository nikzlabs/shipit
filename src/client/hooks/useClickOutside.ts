// eslint-disable-next-line no-restricted-imports -- useEffect: document mousedown + keydown listeners for click-outside/Escape with cleanup (browser API subscription)
import { useEffect, type RefObject } from "react";

/**
 * Calls `onClose` when the user clicks outside `ref` or presses Escape.
 * Only active when `active` is true (typically tied to an `open` state).
 */
export function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  active: boolean,
): void {
  // eslint-disable-next-line no-restricted-syntax -- browser API subscription with cleanup
  useEffect(() => {
    if (!active) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [ref, onClose, active]);
}
