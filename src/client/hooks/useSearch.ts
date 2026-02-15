import { useState, useMemo, useCallback } from "react";
import type { ChatMessage } from "../components/MessageList.js";

export interface SearchMatch {
  /** Index of the message in the messages array */
  messageIndex: number;
  /** Character start offset within the message text */
  start: number;
  /** Length of the matched substring */
  length: number;
}

export interface SearchState {
  query: string;
  matches: SearchMatch[];
  currentMatchIndex: number;
}

/**
 * Hook for searching through chat messages.
 *
 * Performs case-insensitive substring matching across all message texts.
 * Returns all match locations (message index + character offset) so the
 * UI can highlight them, plus navigation to step through matches.
 */
export function useSearch(messages: ChatMessage[]) {
  const [query, setQuery] = useState("");
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);

  const matches = useMemo(() => {
    if (!query.trim()) return [];

    const needle = query.toLowerCase();
    const result: SearchMatch[] = [];

    for (let i = 0; i < messages.length; i++) {
      const text = messages[i].text;
      if (!text) continue;

      const lower = text.toLowerCase();
      let pos = 0;
      while (pos < lower.length) {
        const idx = lower.indexOf(needle, pos);
        if (idx === -1) break;
        result.push({ messageIndex: i, start: idx, length: needle.length });
        pos = idx + 1;
      }
    }

    return result;
  }, [query, messages]);

  // Clamp currentMatchIndex when matches change
  const clampedIndex = matches.length === 0 ? 0 : Math.min(currentMatchIndex, matches.length - 1);
  if (clampedIndex !== currentMatchIndex) {
    setCurrentMatchIndex(clampedIndex);
  }

  const goToNext = useCallback(() => {
    if (matches.length === 0) return;
    setCurrentMatchIndex((prev) => (prev + 1) % matches.length);
  }, [matches.length]);

  const goToPrev = useCallback(() => {
    if (matches.length === 0) return;
    setCurrentMatchIndex((prev) => (prev - 1 + matches.length) % matches.length);
  }, [matches.length]);

  const clear = useCallback(() => {
    setQuery("");
    setCurrentMatchIndex(0);
  }, []);

  return {
    query,
    setQuery: (q: string) => {
      setQuery(q);
      setCurrentMatchIndex(0);
    },
    matches,
    currentMatchIndex: clampedIndex,
    currentMatch: matches[clampedIndex] as SearchMatch | undefined,
    goToNext,
    goToPrev,
    clear,
  };
}
