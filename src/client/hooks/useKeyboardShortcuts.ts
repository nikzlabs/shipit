import { eventMatchesChord } from "../keybindings/registry.js";
import { useKeybinding } from "../keybindings/use-keybinding.js";
import { useEventListener } from "./useEventListener.js";

export function useKeyboardShortcuts(params: {
  setShortcutsOpen: (updater: (prev: boolean) => boolean) => void;
  handleNewSession: () => void;
}): void {
  const { setShortcutsOpen, handleNewSession } = params;

  const toggleChord = useKeybinding("toggle-shortcuts");
  const newSessionChord = useKeybinding("new-session");

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

  useEventListener(window, "keydown", (e) => {
    if (eventMatchesChord(e, newSessionChord)) {
      e.preventDefault();
      handleNewSession();
    }
  });

  // Note: the agent is intentionally NOT cancellable via the Escape key. Escape

}
