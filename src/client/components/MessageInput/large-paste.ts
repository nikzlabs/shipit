

export const LARGE_PASTE_THRESHOLD_CHARS = 2000;

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

    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) i += 1;
    characters += 1;
    if (characters >= LARGE_PASTE_THRESHOLD_CHARS) return true;
  }
  return false;
}

export function buildPastedTextFile(text: string): File {
  return new File([text], PASTED_TEXT_FILENAME, { type: "text/plain" });
}
