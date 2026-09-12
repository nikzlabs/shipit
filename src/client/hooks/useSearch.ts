import { useState, useMemo, useCallback } from "react";
import type { ChatMessage } from "../components/MessageList.js";

export interface SearchMatch {

  messageIndex: number;

  start: number;

  length: number;
}

const NO_MATCHES: SearchMatch[] = [];

export function useSearch(messages: ChatMessage[]) {
  const [query, setQuery] = useState("");
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);

  const matches = useMemo(() => {

    if (!query.trim()) return NO_MATCHES;

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
