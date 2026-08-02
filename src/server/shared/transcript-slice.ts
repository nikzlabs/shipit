/**
 * Pure slicing primitives for the lazy transcript-body projection (docs/244,
 * SHI-267). Kept dependency-free and isomorphic — the orchestrator uses these
 * to build the wire payload, and the client imports the constants to prove its
 * inline previews still fit inside a slice.
 *
 * The line cap is the primary bound and is *derived*, not picked: the largest
 * inline preview any render path draws is Bash at 30 lines
 * (`client/components/ToolResult.tsx`), so a 40-line slice covers every path
 * with headroom. `tool-result-slice.test.ts` asserts that relationship so a
 * future render path that shows more lines fails the build rather than
 * silently rendering a short preview.
 *
 * The byte cap is a *backstop* for what a line cap cannot bound: a single
 * minified-JSON or base64 line can be megabytes on its own. It is the one
 * place this feature knowingly shows less than it does today — the
 * alternative, honouring 40 lines at any width, re-admits the unbounded
 * payload the feature exists to remove.
 */

/** Max lines carried inline before the tail moves behind a fetch. */
export const TRANSCRIPT_SLICE_LINES = 40;

/** Hard byte backstop for pathologically long single lines. */
export const TRANSCRIPT_SLICE_BYTES = 16 * 1024;

export interface SlicedBody {
  /** The head slice — a prefix of the original. */
  content: string;
  /** True line count of the *whole* body, for the "Show all N lines" label. */
  totalLines: number;
  /** Byte length of the whole body. */
  totalBytes: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

/**
 * Truncate `bytes` to at most `max` bytes without splitting a UTF-8 codepoint.
 * Walks back off any continuation byte (`0b10xxxxxx`) straddling the boundary,
 * so the decoded string never ends in a replacement character.
 */
function sliceUtf8(bytes: Uint8Array, max: number): string {
  if (bytes.length <= max) return decoder.decode(bytes);
  let end = max;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return decoder.decode(bytes.subarray(0, end));
}

/** Count lines the same way the client's `truncateLines` does. */
function countLines(text: string): number {
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lines++;
  return lines;
}

/**
 * Slice a body down to the inline budget. Returns `null` when the body already
 * fits — the common case by far, and the caller leaves the payload untouched so
 * small results carry no extra JSON at all.
 */
export function sliceBody(
  content: string,
  lineLimit: number = TRANSCRIPT_SLICE_LINES,
  byteLimit: number = TRANSCRIPT_SLICE_BYTES,
): SlicedBody | null {
  const bytes = encoder.encode(content);
  const totalLines = countLines(content);
  if (totalLines <= lineLimit && bytes.length <= byteLimit) return null;

  // Line cap first — it is the bound derived from what the UI draws.
  let head = content;
  if (totalLines > lineLimit) {
    let cut = -1;
    let seen = 0;
    for (let i = 0; i < content.length; i++) {
      if (content[i] !== "\n") continue;
      if (++seen === lineLimit) {
        cut = i;
        break;
      }
    }
    if (cut >= 0) head = content.slice(0, cut);
  }

  // Byte backstop, applied to whatever the line cap left.
  const headBytes = encoder.encode(head);
  if (headBytes.length > byteLimit) head = sliceUtf8(headBytes, byteLimit);

  return { content: head, totalLines, totalBytes: bytes.length };
}
