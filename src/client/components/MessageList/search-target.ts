import type { SearchMatch } from "../../hooks/useSearch.js";
import type { ChatMessage } from "./types.js";

const CURRENT_MATCH_HIGHLIGHT = "shipit-search-current";

/** A markdown link's or image's `(destination)`, which the row does not show. */
const LINK_DESTINATION = /\]\([^)]*\)/g;

/**
 * Lowercase that keeps every offset. A character whose lowercase is longer
 * (`İ`) stays as it is, so a match through one falls back to its row.
 */
function foldCase(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;
  let out = "";
  for (const ch of text) {
    const folded = ch.toLowerCase();
    out += folded.length === ch.length ? folded : ch;
  }
  return out;
}

export interface MatchDescription {
  needle: string;
  /** Which of the occurrences its row shows this is, counted as `useSearch` counts. */
  ordinal: number;
}

/**
 * The match's text and which shown occurrence it is, so a row that draws no
 * `<mark>` for it can be searched instead. Null when the row cannot show it.
 */
export function describeMatch(messages: ChatMessage[], match: SearchMatch): MatchDescription | null {
  const text = messages[match.messageIndex]?.text.toLowerCase();
  if (!text) return null;
  const needle = text.slice(match.start, match.start + match.length);
  if (!needle) return null;
  const hidden = [...text.matchAll(LINK_DESTINATION)].map((m) => [m.index, m.index + m[0].length]);
  const shown = (at: number) => !hidden.some(([from, to]) => at > from && at < to);
  if (!shown(match.start)) return null;
  let ordinal = 0;
  for (let at = text.indexOf(needle); at !== -1 && at < match.start; at = text.indexOf(needle, at + 1)) {
    if (shown(at)) ordinal++;
  }
  return { needle, ordinal };
}

function findOccurrence(root: Element, { needle, ordinal }: MatchDescription): Range | null {
  const nodes: Text[] = [];
  const ends: number[] = [];
  let text = "";
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    text += foldCase((node as Text).data);
    nodes.push(node as Text);
    ends.push(text.length);
  }

  const found: number[] = [];
  for (let at = text.indexOf(needle); at !== -1 && found.length <= ordinal; at = text.indexOf(needle, at + 1)) {
    found.push(at);
  }
  if (found.length === 0) return null;
  // Raw HTML the transcript drops can leave the row with fewer occurrences.
  const start = found[Math.min(ordinal, found.length - 1)];
  const end = start + needle.length;

  const point = (offset: number, isEnd: boolean): [Text, number] => {
    const i = ends.findIndex((e) => (isEnd ? offset <= e : offset < e));
    return [nodes[i], offset - (ends[i] - nodes[i].data.length)];
  };
  const range = root.ownerDocument.createRange();
  range.setStart(...point(start, false));
  range.setEnd(...point(end, true));
  return range;
}

/**
 * Where a match the transcript draws no `<mark>` for is: its text in the
 * message's row, or the row itself when the row does not show the text.
 */
export function locateMatch(
  container: HTMLElement,
  messageIndex: number,
  match: MatchDescription | null,
): Range | HTMLElement | null {
  const rows = container.querySelectorAll<HTMLElement>(`[data-compact-index="${messageIndex}"]`);
  if (match) {
    for (const row of rows) {
      const range = findOccurrence(row, match);
      if (range) return range;
    }
  }
  return rows[0] ?? null;
}

export function scrollToCenter(container: HTMLElement, target: Range | HTMLElement): void {
  if (target instanceof HTMLElement) {
    target.scrollIntoView({ block: "center" });
    return;
  }
  const rect = target.getBoundingClientRect();
  const box = container.getBoundingClientRect();
  container.scrollTop += rect.top + rect.height / 2 - (box.top + box.height / 2);
}

/** Paints the current match in a row with no `<mark>`; returns the cleanup. */
export function paintCurrentMatch(range: Range): () => void {
  const HighlightCtor = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  const highlights = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
  if (!HighlightCtor || !highlights) return () => {};
  highlights.set(CURRENT_MATCH_HIGHLIGHT, new HighlightCtor(range));
  return () => { highlights.delete(CURRENT_MATCH_HIGHLIGHT); };
}
