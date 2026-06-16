export interface SelectionCommentData {
  id: string;
  quotedText: string;
  contextBefore: string;
  contextAfter: string;
  text: string;
  source?: "human" | "ai";
}

/**
 * The user's pending selection — captured when the floating "Comment" button
 * is clicked. We snapshot the selection because the live one can be lost if
 * the user clicks elsewhere (e.g. scrolling, editing the input) before
 * submitting. The `range` is used to paint a CSS Custom Highlight while the
 * input is open, so the user keeps a visible anchor for what they're
 * commenting on.
 */
export interface PendingSelection {
  quotedText: string;
  contextBefore: string;
  contextAfter: string;
  range: Range;
  blockIndex: number;
}

/**
 * Live snapshot of the user's current selection, captured every time the
 * selection changes. Bundles together (a) the per-line rects used to position
 * the floating Comment button, (b) the resolved selection data (quoted
 * text + context) so that clicking the button doesn't need to re-read
 * `window.getSelection()`, and (c) the underlying Range, which we promote
 * into the CSS Custom Highlight API once the comment input opens — that's
 * what keeps a visible highlight on the selected text while focus is in the
 * textarea (the native selection gets dimmed or cleared by the browser
 * depending on UA).
 *
 * `first`/`last` are the rects of the first and last line of the selection
 * (via `range.getClientRects()`). We never use `range.getBoundingClientRect()`
 * because for multi-line selections the bounding rect spans the full text
 * column — its horizontal centre lands far from the actual selected text.
 */
export interface SelectionSnapshot {
  first: DOMRect;
  last: DOMRect;
  quotedText: string;
  contextBefore: string;
  contextAfter: string;
  range: Range;
  blockIndex: number;
}
