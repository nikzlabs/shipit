// Must exceed the largest inline preview; tool-result-slice.test.ts checks this.
export const TRANSCRIPT_SLICE_LINES = 40;
export const TRANSCRIPT_SLICE_BYTES = 16 * 1024;
// Small bodies cost less than slice markers and a separate fetch.
export const RESULT_STRIP_FLOOR_BYTES = 200;
export const SUB_AGENT_PREVIEW_CHARS = 140;

export function subAgentPreviewLine(markdown: string): string {
  const flat = markdown.replace(/\s+/g, " ").trim();
  return flat.length > SUB_AGENT_PREVIEW_CHARS
    ? `${flat.slice(0, SUB_AGENT_PREVIEW_CHARS)}…`
    : flat;
}

export interface SlicedBody {
  content: string;
  totalLines: number;
  totalBytes: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

function sliceUtf8(bytes: Uint8Array, max: number): string {
  if (bytes.length <= max) return decoder.decode(bytes);
  let end = max;
  // Move back to a character boundary before decoding.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return decoder.decode(bytes.subarray(0, end));
}

function countLines(text: string): number {
  let lines = 1;
  for (const ch of text) if (ch === "\n") lines++;
  return lines;
}

export function sliceBody(
  content: string,
  lineLimit: number = TRANSCRIPT_SLICE_LINES,
  byteLimit: number = TRANSCRIPT_SLICE_BYTES,
): SlicedBody | null {
  const bytes = encoder.encode(content);
  const totalLines = countLines(content);
  if (totalLines <= lineLimit && bytes.length <= byteLimit) return null;

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

  const headBytes = encoder.encode(head);
  if (headBytes.length > byteLimit) head = sliceUtf8(headBytes, byteLimit);

  return { content: head, totalLines, totalBytes: bytes.length };
}
