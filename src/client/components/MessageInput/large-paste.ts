/**
 * Large-paste-to-file — docs/292-paste-large-text-as-file.
 *
 * A paste of 2,000 characters or more does not go into the composer at all: it
 * becomes an uploaded `.txt` attachment instead. Below the threshold nothing
 * changes, and there is deliberately no way back to inline text, so the whole
 * rule is this constant plus a `File` factory.
 */

/**
 * Paste length, in characters, at or above which the paste becomes a file.
 * 2,000 is roughly 30–50 lines of code — where a pasted block stops being
 * something the user can read and edit around inside the input box.
 */
export const LARGE_PASTE_THRESHOLD_CHARS = 2000;

/**
 * Base name for a converted paste. `saveUploadedFile` renames on collision
 * (`deduplicateFilename` in `services/files.ts`), so a later paste in the same
 * session lands as `pasted-text-1.txt`.
 */
export const PASTED_TEXT_FILENAME = "pasted-text.txt";

/**
 * True when this paste is large enough to be attached instead of inserted.
 *
 * Counts **characters**, not `String.length`: that is UTF-16 code units, so a
 * paste of astral characters (emoji, rarer CJK) would convert at half the
 * characters the requirement names. The length check short-circuits the common
 * case — code points can never outnumber code units — and the count stops at
 * the threshold, so the work is bounded however large the paste is.
 */
export function isLargePaste(text: string): boolean {
  if (text.length < LARGE_PASTE_THRESHOLD_CHARS) return false;
  let characters = 0;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    // A high surrogate followed by anything is one character, not two.
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) i += 1;
    characters += 1;
    if (characters >= LARGE_PASTE_THRESHOLD_CHARS) return true;
  }
  return false;
}

/** Wrap pasted text as a `File` so it can go through the normal upload path. */
export function buildPastedTextFile(text: string): File {
  return new File([text], PASTED_TEXT_FILENAME, { type: "text/plain" });
}
