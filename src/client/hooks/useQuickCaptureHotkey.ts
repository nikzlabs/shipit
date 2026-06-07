// eslint-disable-next-line no-restricted-imports -- window keydown listener with cleanup
import { useEffect } from "react";
import { eventMatchesChord, isValidChord } from "../keybindings/registry.js";

/**
 * Validity for a global hotkey that fires while the user is typing — needs a
 * strong modifier plus a second modifier. Thin wrapper over the registry's
 * `isValidChord` (docs/180); kept for back-compat with existing callers/tests.
 */
export function isValidQuickCaptureHotkey(hotkey: string): boolean {
  return isValidChord(hotkey, true);
}

export function useQuickCaptureHotkey(hotkey: string, onOpen: () => void): void {
  // eslint-disable-next-line no-restricted-syntax -- global keyboard shortcut with cleanup
  useEffect(() => {
    if (!isValidQuickCaptureHotkey(hotkey)) return undefined;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!eventMatchesChord(e, hotkey)) return;
      e.preventDefault();
      onOpen();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hotkey, onOpen]);
}
