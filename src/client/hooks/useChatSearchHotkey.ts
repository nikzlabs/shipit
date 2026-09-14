import { eventMatchesChord } from "../keybindings/registry.js";
import { useKeybinding } from "../keybindings/use-keybinding.js";
import { useEventListener } from "./useEventListener.js";

/**
 * The conversation composer's textarea. `MessageInput` marks itself with its
 * surface, so this excludes the quick-capture overlay's copy — searching the
 * conversation behind that overlay would be nonsense, and the browser keeps the
 * key there.
 */
const CHAT_INPUT_SELECTOR = '[data-chat-input="chat"]';

/**
 * Opens the conversation search bar for the `chat-search` chord, but ONLY while
 * the composer has focus — anywhere else the browser's own Find is the right
 * tool and keeps the key. In-app search is what finds text inside turns that
 * *Compact completed turns* has collapsed, which Find cannot see.
 */
export function useChatSearchHotkey(onOpen: () => void): void {
  const chord = useKeybinding("chat-search");

  useEventListener(window, "keydown", (e) => {
    if (!eventMatchesChord(e, chord)) return;
    const target = e.target;
    if (!(target instanceof Element) || !target.closest(CHAT_INPUT_SELECTOR)) return;
    e.preventDefault();
    onOpen();
  });
}
