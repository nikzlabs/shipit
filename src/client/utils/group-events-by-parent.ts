/**
 * Group a flat list of subagent events by their `parentToolUseId` and
 * separate assistant blocks (text, nested tool calls) from terminal tool
 * results. Used by `SubagentCall` to render a Task tool's prompt, work, and
 * final report inline. (109 — subagent transparency)
 */

import type { SubagentEvent, ToolUseBlock, ToolResultBlock } from "../components/MessageList.js";

/**
 * A single rendered "step" inside a subagent's work timeline. Mirrors
 * `SubagentEvent` but normalized for the renderer:
 * - "assistant" entries carry the subagent's narration and any tool calls.
 * - "tool_result" entries carry results from those tool calls.
 *
 * Order is preserved from the original event stream so the work view shows
 * the subagent's actions chronologically.
 */
export type SubagentStep =
  | { kind: "assistant"; text: string; toolUse: ToolUseBlock[] }
  | { kind: "tool_result"; toolResults: ToolResultBlock[] };

export interface SubagentTree {
  parentToolUseId: string;
  steps: SubagentStep[];
}

/**
 * Group subagent events by their parent tool-use id. Returns a Map keyed by
 * the parent Task tool's id. The renderer looks up entries for a Task tool by
 * its id; absent entries mean "no nested activity yet."
 */
export function groupEventsByParent(events: SubagentEvent[] | undefined): Map<string, SubagentTree> {
  const out = new Map<string, SubagentTree>();
  if (!events) return out;

  for (const ev of events) {
    let tree = out.get(ev.parentToolUseId);
    if (!tree) {
      tree = { parentToolUseId: ev.parentToolUseId, steps: [] };
      out.set(ev.parentToolUseId, tree);
    }
    if (ev.kind === "assistant") {
      tree.steps.push({ kind: "assistant", text: ev.text, toolUse: ev.toolUse });
    } else {
      tree.steps.push({ kind: "tool_result", toolResults: ev.toolResults });
    }
  }
  return out;
}

/**
 * Extract the subagent's "final report" — the markdown text content of the
 * `tool_result` block whose `tool_use_id` is the parent Task call's id. The
 * Task tool's result block is always emitted *outside* the nested events
 * (it's the parent's tool result, not the subagent's). Caller passes the
 * parent message's `toolResults` along with the parent tool id.
 */
export function findSubagentFinalReport(
  parentToolId: string,
  parentToolResults: ToolResultBlock[] | undefined,
): ToolResultBlock | undefined {
  return parentToolResults?.find((r) => r.toolUseId === parentToolId);
}

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
 * accounting footer (SHI-287).
 *
 * The CLI returns the result as a **JSON-encoded block array** whenever the
 * subagent's reply has more than one block — which is the normal case, because
 * the CLI appends its own `agentId` / token-accounting block after the report.
 * `SubagentCall` used to hand that string straight to the markdown renderer, so
 * users saw `[{"type":"text","text":"…"}]` with escaped newlines instead of
 * their report.
 *
 * Not a docs/244 regression, despite the timing: the lazy-body projection
 * *exempts* subagent reports (`rendersResultContentInline` is true for
 * `SUBAGENT_REPORT_TOOL_NAMES`), so the renderer receives byte-for-byte what it
 * received before that feature landed.
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

  const last = texts[texts.length - 1];
  if (texts.length > 1 && isSubagentMetaBlock(last)) {
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
