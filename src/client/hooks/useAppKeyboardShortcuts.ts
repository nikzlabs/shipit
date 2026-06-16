import type { Dispatch, SetStateAction } from "react";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts.js";
import { useQuickCaptureHotkey } from "./useQuickCaptureHotkey.js";
import { useUiStore } from "../stores/ui-store.js";

/**
 * App-level keyboard wiring: the shortcuts overlay + new-session chord
 * (`useKeyboardShortcuts`), the text quick-capture hotkey, and the voice
 * quick-capture hotkey (docs/144 Mode B — opens the overlay AND auto-starts the
 * mic, only when voice input is enabled).
 *
 * The resolved chords (`quickCaptureHotkey`, `voiceHotkeyModeB`) and
 * `voiceInputEnabled` are passed in so their `useKeybinding`/store selectors
 * stay at their original positions in App (preserving effect ordering).
 */
export function useAppKeyboardShortcuts(params: {
  setShortcutsOpen: Dispatch<SetStateAction<boolean>>;
  handleNewSessionShortcut: () => void;
  quickCaptureHotkey: string;
  voiceInputEnabled: boolean;
  voiceHotkeyModeB: string;
}): void {
  const { setShortcutsOpen, handleNewSessionShortcut, quickCaptureHotkey, voiceInputEnabled, voiceHotkeyModeB } = params;

  useKeyboardShortcuts({
    setShortcutsOpen: (updater) => setShortcutsOpen(updater),
    handleNewSession: handleNewSessionShortcut,
  });

  useQuickCaptureHotkey(quickCaptureHotkey, () => {
    useUiStore.getState().setQuickCaptureOpen(true);
  });

  // docs/144 Mode B — voice hotkey opens the overlay *and* auto-starts mic.
  // Only active when voice input is enabled; reuses the same conflict-checked
  // matcher as the text-only quick-capture hotkey.
  useQuickCaptureHotkey(voiceInputEnabled ? voiceHotkeyModeB : "", () => {
    useUiStore.getState().setQuickCaptureOpen(true, true);
  });
}
