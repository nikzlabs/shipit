/**
 * The subagent final report: parsing, metadata extraction, and slicing
 * (docs/109, requirements 1, 5, 8).
 *
 * Isomorphic and dependency-free, because three consumers have to agree on it
 * byte for byte:
 *
 *   - `SubagentCall` (client) renders the report and its metadata chips;
 *   - `transcript-projection` (server) ships only the clamped head under
 *     requirement 8, and must produce something the client parser still
 *     understands;
 *   - `api-routes-lazy-bodies` serves the whole thing back when the modal opens.
 *
 * The parsing half used to live in `client/utils/group-events-by-parent.ts` and
 * is re-exported from there, so the client's import path is unchanged.
 */

/** A final report split into the part written for the user and the CLI's footer. */
export interface ParsedSubagentReport {
  /** The report itself, ready to render as markdown. */
  text: string;
  /**
   * The CLI's trailing accounting block, verbatim, when one was recognized.
   * Addressed to the *agent* (it explains how to resume the subagent), so the
   * renderer demotes it rather than showing it as part of the report.
   */
  meta: string | null;
}

/**
 * Keys the Claude CLI's accounting footer is built from. Used to recognize the
 * block, not to parse it — see {@link parseSubagentReport}.
 */
const SUBAGENT_META_KEYS = new Set([
  "agentId",
  "subagent_tokens",
  "tool_uses",
  "duration_ms",
]);

/**
 * Split a subagent's `tool_result` content into report text and the CLI's
 * accounting footer (planning#289).
 *
 * The CLI returns the result as a **JSON-encoded block array** whenever the
 * subagent's reply has more than one block — which is the normal case, because
 * the CLI appends its own `agentId` / token-accounting block after the report.
 * `SubagentCall` used to hand that string straight to the markdown renderer, so
 * users saw `[{"type":"text","text":"…"}]` with escaped newlines instead of
 * their report.
 *
 * Parsing is **structural**, matching `parseContentForImages`: `startsWith("[")`
 * then `JSON.parse`, then inspect block types. docs/244's round 4 removed two
 * successive *lexical* pre-filters that were each wrong in a different way, and
 * the lesson holds here — a plain-string report, or anything that isn't a block
 * array, is returned untouched.
 *
 * The footer is the one thing that has no structural marker: it arrives as an
 * ordinary `type: "text"` block. So it is recognized narrowly — only as the
 * LAST block, and only when every line is `key: value` with a key the CLI
 * actually emits. Anything else stays part of the report, which is the safe
 * direction: a missed footer renders as text (today's behavior), while a false
 * positive would silently eat someone's report.
 */
export function parseSubagentReport(content: string): ParsedSubagentReport {
  if (!content.startsWith("[")) return { text: content, meta: null };

  let blocks: unknown;
  try {
    blocks = JSON.parse(content);
  } catch {
    return { text: content, meta: null };
  }
  if (!Array.isArray(blocks)) return { text: content, meta: null };

  const texts: string[] = [];
  for (const block of blocks as Record<string, unknown>[]) {
    // Non-text blocks (an image the subagent returned) are not this function's
    // business; they are dropped from the text and left to the image path.
    if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
  }
  // A block array we could parse but found no text in tells us nothing useful —
  // returning "" would blank a report that does exist in some other shape.
  if (texts.length === 0) return { text: content, meta: null };

  // A LONE meta block is still meta (docs/109 req 5). This used to require
  // `texts.length > 1`, on the reasoning that a single block is the report and
  // blanking it would be the worse failure — but the block is only reached here
  // if every one of its lines is a `key: value` with a key the CLI emits, which
  // no prose report satisfies. The old rule meant a subagent that returned
  // nothing but accounting had its `agentId` rendered to the user as prose.
  const last = texts[texts.length - 1];
  if (isSubagentMetaBlock(last)) {
    return { text: texts.slice(0, -1).join("\n\n"), meta: last };
  }
  return { text: texts.join("\n\n"), meta: null };
}

/** Every line is `<known-key>: <value>`, and there is at least one line. */
function isSubagentMetaBlock(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return false;
  return lines.every((line) => {
    const key = line.slice(0, line.indexOf(":")).trim();
    return line.includes(":") && SUBAGENT_META_KEYS.has(key);
  });
}

/**
 * The accounting footer's numbers, for the header chips (requirement 5).
 *
 * `agentId` is deliberately NOT returned. It is an internal handle the CLI
 * hands the agent for `SendMessage`, it means nothing to the reader, and the
 * launch acknowledgement below says outright that it must not be surfaced.
 * Dropping it here rather than at the render site means there is one place to
 * check that it never reaches the DOM.
 */
export interface SubagentReportMeta {
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
}

export function parseReportMeta(meta: string | null): SubagentReportMeta | null {
  if (!meta) return null;
  const out: SubagentReportMeta = {};
  for (const line of meta.split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = Number(line.slice(idx + 1).trim());
    if (!Number.isFinite(value)) continue;
    if (key === "subagent_tokens") out.tokens = value;
    else if (key === "tool_uses") out.toolUses = value;
    else if (key === "duration_ms") out.durationMs = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * True when this "report" is really the CLI's acknowledgement that a
 * `run_in_background` agent was *launched* (requirement 1).
 *
 * The tool result for a backgrounded Task is not a report at all — it is
 * machinery addressed to the agent (an `agentId` to resume with, the output
 * file path, and an instruction never to quote any of it). Rendering it as the
 * final report showed the user internal metadata AND told them the subagent was
 * done while it was still running.
 *
 * Recognised by three things at once, because the failure directions are not
 * symmetric: a missed acknowledgement shows the user some machinery, while a
 * false positive *hides a real report entirely*. So the test is deliberately
 * over-specified —
 *
 *   1. it opens with the CLI's sentence (not merely contains it — a report
 *      quoting the phrase, as this repo's own docs do, is not swallowed);
 *   2. it carries `agentId:` or `output_file:` at the start of a line, which
 *      prose does not; and
 *   3. it is short. The real acknowledgement is around 700 bytes and always
 *      will be — it is four fixed sentences and a path. A report is not.
 *
 * The Task's own `run_in_background` input would be the authoritative signal
 * and is deliberately NOT used: `inputKeyTreatment` drops it from the wire on
 * every committed path (only `description` / `subagent_type` / `skill` / `args`
 * are kept), so gating on it would work live and then fail on reload — turning
 * a fixed bug back on at the exact moment the user scrolls back to it.
 */
const LAUNCH_ACK_MAX_BYTES = 2_000;

export function isBackgroundLaunchAck(text: string): boolean {
  if (text.length > LAUNCH_ACK_MAX_BYTES) return false;
  const head = text.trimStart();
  if (!head.startsWith("Async agent launched successfully")) return false;
  return /^agentId:/m.test(head) || /^output_file:/m.test(head);
}

/**
 * Lines of a report carried inline with the transcript (requirement 8).
 *
 * The card clamps the report to a fixed height and puts the rest behind the
 * "Show the full report" modal, so this is the point past which nothing is
 * visible without a click. Twelve rather than the ten-ish the clamp shows: the
 * clamp is measured in *rendered* lines and this counts *source* lines, and a
 * markdown source line usually renders as one or more visual lines, never
 * fewer. Erring high means the clamp is always the thing that cuts, so the fade
 * lands where the design puts it instead of at a ragged end-of-payload.
 */
export const REPORT_SLICE_LINES = 12;

/** Hard byte backstop, for a report that is one enormous line. */
export const REPORT_SLICE_BYTES = 8 * 1024;

/**
 * Below this a report ships whole: the `truncated` / `totalLines` markers cost
 * ~60 bytes and a round-trip, which is a bad trade for a two-line report.
 * Matches `RESULT_STRIP_FLOOR_BYTES`, and is a separate constant only because
 * this module must not import the slice module (the client imports this one).
 */
export const REPORT_STRIP_FLOOR_BYTES = 200;

export interface SlicedReport {
  /** The clamped report, in the same shape the original arrived in. */
  content: string;
  /** True line count of the whole report text, for the modal's "N lines" label. */
  totalLines: number;
  /** Byte length of the whole original content. */
  totalBytes: number;
}

/**
 * Clamp a final report for the wire, preserving the shape the client parses.
 *
 * A report must never be sliced as a raw string. The CLI's normal encoding is a
 * `JSON.stringify`'d block array — a **single line** — so a line cap never
 * fires and a byte cap cuts mid-array, leaving JSON that `parseSubagentReport`
 * cannot parse and therefore renders verbatim. That is the planning#289 bug with
 * extra steps. So the slice is applied to the report *text* and the block
 * structure is rebuilt around it, exactly as `projectBlockArray` does for MCP
 * image results.
 *
 * The accounting footer is kept in full: it is the source of the header chips,
 * which are visible without a click, and it is tens of bytes. **Non-text blocks
 * are kept too** — an image a subagent returned is not this module's business,
 * but dropping it from the rebuilt array would delete it from the payload
 * entirely, and a caller that substitutes image URLs before slicing (which
 * `projectToolResult` does) has already made them cheap.
 *
 * Returns null when the report already fits, so the common short report carries
 * no extra JSON at all.
 */
export function sliceSubagentReport(content: string): SlicedReport | null {
  const { text, meta } = parseSubagentReport(content);
  const totalBytes = utf8Length(content);
  if (utf8Length(text) <= REPORT_STRIP_FLOOR_BYTES) return null;

  const head = clampLines(text, REPORT_SLICE_LINES, REPORT_SLICE_BYTES);
  if (head === null) return null;

  const totalLines = countLines(text);
  // Plain-string report in, plain-string report out. Wrapping it in a block
  // array would work (the parser handles both) but would change the shape the
  // client sees for no reason.
  if (meta === null && !content.startsWith("[")) {
    return { content: head, totalLines, totalBytes };
  }
  return { content: rebuildBlocks(content, head, meta), totalLines, totalBytes };
}

/**
 * Rebuild the block array around the clamped text, in place: the first text
 * block carries the head, later text blocks collapse into it (which is what
 * `parseSubagentReport` does when reading it back), the footer block is
 * restored verbatim, and every non-text block is passed through untouched.
 *
 * Mirrors `projectBlockArray`'s rewrite loop rather than constructing a fresh
 * two-element array, so a block shape this module does not model survives the
 * round trip instead of being silently deleted.
 */
function rebuildBlocks(content: string, head: string, meta: string | null): string {
  let blocks: unknown;
  try {
    blocks = JSON.parse(content);
  } catch {
    return JSON.stringify([{ type: "text", text: head }]);
  }
  if (!Array.isArray(blocks)) return JSON.stringify([{ type: "text", text: head }]);

  // Last matching block, not the first: the footer is by definition the final
  // text block, and a report could legitimately repeat its text earlier.
  let metaIndex = -1;
  if (meta !== null) {
    for (let i = (blocks as unknown[]).length - 1; i >= 0; i--) {
      const block = (blocks as unknown[])[i];
      if (isTextBlock(block) && (block as { text: string }).text === meta) {
        metaIndex = i;
        break;
      }
    }
  }

  let headEmitted = false;
  const out: unknown[] = [];
  for (const [i, block] of blocks.entries()) {
    if (!isTextBlock(block)) {
      out.push(block);
      continue;
    }
    if (i === metaIndex) {
      out.push(block);
      continue;
    }
    if (headEmitted) continue;
    headEmitted = true;
    out.push({ ...(block as Record<string, unknown>), text: head });
  }
  return JSON.stringify(out);
}

function isTextBlock(block: unknown): boolean {
  if (typeof block !== "object" || block === null) return false;
  const b = block as Record<string, unknown>;
  return b.type === "text" && typeof b.text === "string";
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

function countLines(text: string): number {
  let lines = 1;
  for (const ch of text) if (ch === "\n") lines++;
  return lines;
}

/** The first `lineLimit` lines, capped at `byteLimit`; null when it all fits. */
function clampLines(text: string, lineLimit: number, byteLimit: number): string | null {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (countLines(text) <= lineLimit && bytes.length <= byteLimit) return null;

  let head = text;
  let seen = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\n") continue;
    if (++seen === lineLimit) {
      head = text.slice(0, i);
      break;
    }
  }

  const headBytes = encoder.encode(head);
  if (headBytes.length > byteLimit) {
    // Walk back off a UTF-8 continuation byte so the decode never ends in a
    // replacement character.
    let end = byteLimit;
    while (end > 0 && ((headBytes[end] ?? 0) & 0xc0) === 0x80) end--;
    head = new TextDecoder("utf-8").decode(headBytes.subarray(0, end));
  }
  return head;
}
