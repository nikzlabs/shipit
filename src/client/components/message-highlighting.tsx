import type { SearchMatch } from "../hooks/useSearch.js";

export function getSegmentMatches(
  matches: SearchMatch[],
  segOffset: number,
  segLength: number
): SearchMatch[] {
  return matches
    .filter(
      (m) =>
        m.start >= segOffset && m.start + m.length <= segOffset + segLength
    )
    .map((m) => ({ ...m, start: m.start - segOffset }));
}

export function HighlightedText({
  text,
  matches,
  currentMatch,
  currentMatchRef,
}: {
  text: string;
  matches: SearchMatch[];
  currentMatch?: SearchMatch;
  currentMatchRef: React.RefObject<HTMLElement | null>;
}) {
  if (matches.length === 0) return <>{text}</>;

  const parts: React.ReactNode[] = [];
  let cursor = 0;

  for (const match of matches) {
    if (match.start > cursor) {
      parts.push(text.slice(cursor, match.start));
    }
    const isCurrent =
      currentMatch?.messageIndex === match.messageIndex &&
      currentMatch.start === match.start;
    parts.push(
      <mark
        key={`${match.start}-${match.length}`}
        ref={isCurrent ? currentMatchRef : undefined}
        className={
          isCurrent
            ? "search-highlight search-highlight--current"
            : "search-highlight"
        }
      >
        {text.slice(match.start, match.start + match.length)}
      </mark>
    );
    cursor = match.start + match.length;
  }

  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }

  return <>{parts}</>;
}
