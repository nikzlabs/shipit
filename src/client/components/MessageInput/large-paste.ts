/**
 * Large-paste-to-file — docs/292-paste-large-text-as-file.
 *
 * A paste of 2,000 characters or more does not go into the composer at all: it
 * becomes an uploaded `.txt` attachment instead (req 1, req 2). Below the
 * threshold nothing changes (req 3). There is deliberately no way back to inline
 * text (req 5), so the whole rule is this one constant plus a `File` factory.
 */

/**
 * Paste length, in characters, at or above which the paste becomes a file.
 *
 * 2,000 characters is roughly 30–50 lines of code or a medium log dump — the
 * point at which the pasted block stops being something the user can read and
 * edit around inside the input box.
 */
export const LARGE_PASTE_THRESHOLD_CHARS = 2000;

/**
 * Base name for a converted paste. The upload service deduplicates on write
 * (`deduplicateFilename` in `services/files.ts`), so a second paste in the same
 * session lands as `pasted-text-1.txt` rather than overwriting the first.
 */
export const PASTED_TEXT_FILENAME = "pasted-text.txt";

/** True when this paste is large enough to be attached instead of inserted. */
export function isLargePaste(text: string): boolean {
  return text.length >= LARGE_PASTE_THRESHOLD_CHARS;
}

/** Wrap pasted text as a `File` so it can go through the normal upload path. */
export function buildPastedTextFile(text: string): File {
  return new File([text], PASTED_TEXT_FILENAME, { type: "text/plain" });
}
