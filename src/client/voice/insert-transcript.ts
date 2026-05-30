/**
 * Pure transcript-splicing helper (docs/144).
 *
 * Splices a dictated transcript into the current textarea value at the
 * cursor (or selection). This is the ONLY place a transcript turns into
 * textarea text — keeping it pure and isolated is what enforces the
 * "review-before-send" contract: the voice hook hands us a string, we
 * compute the next textarea value, and the caller calls `setText`. There
 * is no path from here to a send action.
 */

export interface SpliceInput {
  /** Current textarea value. */
  value: string;
  /** Selection start (cursor) — defaults to end of value when undefined. */
  selectionStart?: number;
  /** Selection end — defaults to selectionStart when undefined. */
  selectionEnd?: number;
  /** The transcript to insert. */
  transcript: string;
}

export interface SpliceResult {
  /** The new textarea value. */
  value: string;
  /** Cursor position to place after the inserted text. */
  cursor: number;
}

/**
 * Splice `transcript` into `value` at the cursor/selection.
 *
 * - If a selection is present, the transcript replaces it.
 * - A leading space is added when the character immediately before the
 *   insertion point is a non-space, non-newline, so consecutive
 *   dictations don't run words together.
 * - Returns the new value and the cursor position to set (end of the
 *   inserted text).
 */
export function spliceTranscript(input: SpliceInput): SpliceResult {
  const { value, transcript } = input;
  const len = value.length;
  let start = input.selectionStart ?? len;
  let end = input.selectionEnd ?? start;
  // Clamp defensively.
  start = Math.max(0, Math.min(start, len));
  end = Math.max(start, Math.min(end, len));

  const before = value.slice(0, start);
  const after = value.slice(end);

  const prevChar = before.slice(-1);
  const needsLeadingSpace = prevChar !== "" && prevChar !== " " && prevChar !== "\n" && prevChar !== "\t";
  const insert = (needsLeadingSpace ? " " : "") + transcript;

  return {
    value: before + insert + after,
    cursor: before.length + insert.length,
  };
}
