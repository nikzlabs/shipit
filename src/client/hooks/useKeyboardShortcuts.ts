import { eventMatchesChord } from "../keybindings/registry.js";
import { useKeybinding } from "../keybindings/use-keybinding.js";
import { useEventListener } from "./useEventListener.js";

export function useKeyboardShortcuts(params: {
  setShortcutsOpen: (updater: (prev: boolean) => boolean) => void;
  handleNewSession: () => void;
}): void {
  const { setShortcutsOpen, handleNewSession } = params;

  // Chords come from the registry/overrides (docs/180) so they stay in sync
  // with the Keyboard settings tab and the ? overlay.
  const toggleChord = useKeybinding("toggle-shortcuts");
  const newSessionChord = useKeybinding("new-session");

  // Toggle the keyboard-shortcuts overlay. The configurable chord (default
  // Cmd/Ctrl+/) works regardless of focus; bare ? is kept as a fixed fallback
  // for users whose focus is outside any input (its implied Shift can't round
  // trip through the strict matcher, so it stays special-cased here). The latest
  // `toggleChord` / `setShortcutsOpen` are read at fire time, so no rebind is
  // needed when the chord changes.
  useEventListener(window, "keydown", (e) => {
    const isChord = eventMatchesChord(e, toggleChord);
    const isBareQuestionMark = e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (!isChord && !isBareQuestionMark) return;
    if (isBareQuestionMark) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    }
    e.preventDefault();
    setShortcutsOpen((prev: boolean) => !prev);
  });

  // Start a new session (default Cmd/Ctrl+Shift+O). Fires regardless of focus so
  // the user can trigger it while typing in the chat input.
  useEventListener(window, "keydown", (e) => {
    if (eventMatchesChord(e, newSessionChord)) {
      e.preventDefault();
      handleNewSession();
    }
  });

  // Note: the agent is intentionally NOT cancellable via the Escape key. Escape
  // fires globally regardless of focus, so an errant press (e.g. while the
  // preview pane is focused) would cancel a running turn by accident. The only
  // way to stop the agent is the explicit stop button in the chat input.
}
