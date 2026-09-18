import { eventMatchesChord, isValidChord } from "../keybindings/registry.js";
import { useEventListener } from "./useEventListener.js";

export function isValidQuickCaptureHotkey(hotkey: string): boolean {
  return isValidChord(hotkey, true);
}

export function useQuickCaptureHotkey(hotkey: string, onOpen: () => void): void {

  useEventListener(isValidQuickCaptureHotkey(hotkey) ? window : null, "keydown", (e) => {
    if (!eventMatchesChord(e, hotkey)) return;
    e.preventDefault();
    onOpen();
  });
}
