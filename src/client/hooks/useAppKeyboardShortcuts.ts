import type { Dispatch, SetStateAction } from "react";
import { useChatSearchHotkey } from "./useChatSearchHotkey.js";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts.js";
import { useQuickCaptureHotkey } from "./useQuickCaptureHotkey.js";
import { useKeybinding } from "../keybindings/use-keybinding.js";
import { useUiStore } from "../stores/ui-store.js";

/**
 * App-level keyboard wiring: the shortcuts overlay + new-session chord
 * (`useKeyboardShortcuts`), the text quick-capture hotkey, and the voice
 * quick-capture hotkey (docs/144 Mode B — opens the overlay AND auto-starts the
 * mic, only when voice input is enabled), plus the chat-search chord.
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
  openChatSearch: () => void;
}): void {
  const { setShortcutsOpen, handleNewSessionShortcut, quickCaptureHotkey, voiceInputEnabled, voiceHotkeyModeB, openChatSearch } = params;

  useKeyboardShortcuts({
    setShortcutsOpen: (updater) => setShortcutsOpen(updater),
    handleNewSession: handleNewSessionShortcut,
  });

  useChatSearchHotkey(openChatSearch);

  useQuickCaptureHotkey(quickCaptureHotkey, () => {
    useUiStore.getState().setQuickCaptureOpen(true);
  });

  useQuickCaptureHotkey(voiceInputEnabled ? voiceHotkeyModeB : "", () => {
    useUiStore.getState().setQuickCaptureOpen(true, true);
  });

  // second-modifier matcher because it must fire while the user is typing.
  const attentionViewChord = useKeybinding("toggle-attention-view");
  useQuickCaptureHotkey(attentionViewChord, () => {
    useUiStore.getState().toggleSidebarView();
  });
}
