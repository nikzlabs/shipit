import { eventMatchesChord } from "../keybindings/registry.js";
import { useKeybinding } from "../keybindings/use-keybinding.js";
import { useEventListener } from "./useEventListener.js";

/**
 * The two halves of the conversation: the composer's textarea and the
 * transcript. `MessageInput` marks itself with its surface, so this excludes
 * the quick-capture overlay's copy — searching the conversation behind that
 * overlay would be nonsense, and the browser keeps the key there.
 */
const CHAT_SELECTOR = '[data-chat-input="chat"], [data-chat-transcript]';

/**
 * Opens the conversation search bar for the `chat-search` chord, but ONLY while
 * the conversation has focus — anywhere else the browser's own Find is the
 * right tool and keeps the key. In-app search is what finds text inside turns
 * that *Compact completed turns* has collapsed, which Find cannot see.
 *
 * The event target is the test, so the transcript carries a `tabIndex` (see
 * `MessageList`): without it a click on message text leaves focus on `<body>`,
 * which is also where focus sits after a click on the sidebar, the preview or
 * any tab — and taking Ctrl+F from all of those is worse than not having it.
 */
export function useChatSearchHotkey(onOpen: () => void): void {
  const chord = useKeybinding("chat-search");

  useEventListener(window, "keydown", (e) => {
    if (!eventMatchesChord(e, chord)) return;
    const target = e.target;
    if (!(target instanceof Element) || !target.closest(CHAT_SELECTOR)) return;
    e.preventDefault();
    onOpen();
  });
}
