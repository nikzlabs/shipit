import { useRef, useEffect } from "react";
import type { SearchMatch } from "../hooks/useSearch.js";

/**
 * SearchBar — slide-down search input for finding text in chat history.
 *
 * Includes a text input, match count display, prev/next buttons, and a
 * close button. Auto-focuses the input when opened. Supports keyboard
 * shortcuts: Enter / Shift+Enter for next/prev, Escape to close.
 */
export function SearchBar({
  query,
  onQueryChange,
  matches,
  currentMatchIndex,
  onNext,
  onPrev,
  onClose,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  matches: SearchMatch[];
  currentMatchIndex: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      onPrev();
    } else if (e.key === "Enter") {
      e.preventDefault();
      onNext();
    }
  };

  return (
    <div className="flex items-center gap-2 px-4 py-2 bg-(--color-bg-secondary) border-b border-(--color-border-primary)">
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Search messages..."
        className="flex-1 bg-(--color-bg-elevated) border border-(--color-border-secondary) rounded px-3 py-1.5 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:outline-none focus:ring-1 focus:ring-(--color-border-focus)"
      />

      {/* Match count */}
      <span className="text-xs text-(--color-text-secondary) min-w-[4rem] text-center tabular-nums">
        {query.trim()
          ? matches.length > 0
            ? `${currentMatchIndex + 1} / ${matches.length}`
            : "0 results"
          : ""}
      </span>

      {/* Prev / Next buttons */}
      <button
        onClick={onPrev}
        disabled={matches.length === 0}
        className="p-1 rounded text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover) disabled:opacity-30 disabled:cursor-not-allowed"
        title="Previous match (Shift+Enter)"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
        </svg>
      </button>
      <button
        onClick={onNext}
        disabled={matches.length === 0}
        className="p-1 rounded text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover) disabled:opacity-30 disabled:cursor-not-allowed"
        title="Next match (Enter)"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Close button */}
      <button
        onClick={onClose}
        className="p-1 rounded text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover)"
        title="Close search (Escape)"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
