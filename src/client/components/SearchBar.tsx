// eslint-disable-next-line no-restricted-imports -- useEffect: auto-focus input on mount (one-time DOM setup)
import { useRef, useEffect } from "react";
import { CaretUpIcon, CaretDownIcon, XIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
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
      <Button
        variant="ghost"
        size="sm"
        onClick={onPrev}
        disabled={matches.length === 0}
        className="p-1 disabled:opacity-30"
        title="Previous match (Shift+Enter)"
      >
        <CaretUpIcon size={ICON_SIZE.SM} />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={onNext}
        disabled={matches.length === 0}
        className="p-1 disabled:opacity-30"
        title="Next match (Enter)"
      >
        <CaretDownIcon size={ICON_SIZE.SM} />
      </Button>

      {/* Close button */}
      <Button
        variant="ghost"
        size="sm"
        onClick={onClose}
        className="p-1"
        title="Close search (Escape)"
      >
        <XIcon size={ICON_SIZE.SM} />
      </Button>
    </div>
  );
}
