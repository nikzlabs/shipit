import { SearchBar } from "./SearchBar.js";
import type { SearchMatch } from "../hooks/useSearch.js";

/** The conversation composer — see `data-chat-input` in MessageInput.tsx. */
const CHAT_INPUT_SELECTOR = '[data-chat-input="chat"]';

/**
 * The conversation search bar, plus the two pieces of focus behaviour the
 * `chat-search` hotkey needs. Both live here rather than at the App call site
 * so that dropping one is a failing test and not a silent regression:
 *
 *  - `focusKey` changes on every open, remounting `SearchBar` so its
 *    mount-time autofocus runs again. Without it, invoking the hotkey while
 *    the bar is already open swallows the key and the query is typed into the
 *    message draft instead.
 *  - Closing hands the cursor back to the composer. Otherwise focus lands on
 *    `<body>`, and the next press of the hotkey — which only fires from the
 *    composer — falls through to the browser's own Find.
 */
export function ConversationSearch({
  focusKey,
  onClose,
  ...searchBarProps
}: {
  focusKey: number;
  query: string;
  onQueryChange: (query: string) => void;
  matches: SearchMatch[];
  currentMatchIndex: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}) {
  return (
    <SearchBar
      key={focusKey}
      {...searchBarProps}
      onClose={() => {
        onClose();
        document.querySelector<HTMLTextAreaElement>(CHAT_INPUT_SELECTOR)?.focus();
      }}
    />
  );
}
