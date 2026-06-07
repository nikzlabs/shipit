// eslint-disable-next-line no-restricted-imports -- useEffect: window keydown listeners with cleanup (browser API subscription)
import { useEffect } from "react";
import { eventMatchesChord } from "../keybindings/registry.js";
import { useKeybinding } from "../keybindings/use-keybinding.js";

export function useKeyboardShortcuts(params: {
  searchOpen: boolean;
  shortcutsOpen: boolean;
  setShortcutsOpen: (updater: (prev: boolean) => boolean) => void;
  isLoading: boolean;
  settingsOpen: boolean;
  handleInterrupt: () => void;
  handleNewSession: () => void;
}): void {
  const { setShortcutsOpen, isLoading, searchOpen, shortcutsOpen, settingsOpen, handleInterrupt, handleNewSession } = params;

  // Chords come from the registry/overrides (docs/180) so they stay in sync
  // with the Keyboard settings tab and the ? overlay.
  const toggleChord = useKeybinding("toggle-shortcuts");
  const newSessionChord = useKeybinding("new-session");

  // Toggle the keyboard-shortcuts overlay. The configurable chord (default
  // Cmd/Ctrl+/) works regardless of focus; bare ? is kept as a fixed fallback
  // for users whose focus is outside any input (its implied Shift can't round
  // trip through the strict matcher, so it stays special-cased here).
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isChord = eventMatchesChord(e, toggleChord);
      const isBareQuestionMark = e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey;
      if (!isChord && !isBareQuestionMark) return;
      if (isBareQuestionMark) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      }
      e.preventDefault();
      setShortcutsOpen((prev: boolean) => !prev);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setShortcutsOpen, toggleChord]);

  // Start a new session (default Cmd/Ctrl+Shift+O). Fires regardless of focus so
  // the user can trigger it while typing in the chat input.
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (eventMatchesChord(e, newSessionChord)) {
        e.preventDefault();
        handleNewSession();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleNewSession, newSessionChord]);

  // Escape key to interrupt the agent while loading (only when not typing in an input or overlay open)
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && isLoading && !searchOpen && !shortcutsOpen && !settingsOpen) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "SELECT") return;
        e.preventDefault();
        handleInterrupt();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isLoading, searchOpen, shortcutsOpen, settingsOpen, handleInterrupt]);
}
