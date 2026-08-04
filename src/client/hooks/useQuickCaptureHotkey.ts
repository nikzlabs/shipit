import { eventMatchesChord, isValidChord } from "../keybindings/registry.js";
import { useEventListener } from "./useEventListener.js";

/**
 * Validity for a global hotkey that fires while the user is typing — needs a
 * strong modifier plus a second modifier. Thin wrapper over the registry's
 * `isValidChord` (docs/180); kept for back-compat with existing callers/tests.
 */
export function isValidQuickCaptureHotkey(hotkey: string): boolean {
  return isValidChord(hotkey, true);
}

export function useQuickCaptureHotkey(hotkey: string, onOpen: () => void): void {
  // Null target while the hotkey is invalid → no listener attached (the gate the
  // old early-return provided). The latest `hotkey`/`onOpen` fire via the ref.
  useEventListener(isValidQuickCaptureHotkey(hotkey) ? window : null, "keydown", (e) => {
    if (!eventMatchesChord(e, hotkey)) return;
    e.preventDefault();
    onOpen();
  });
}
