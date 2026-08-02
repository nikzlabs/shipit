/**
 * Serve-path projection for heavy transcript bodies (docs/244, SHI-267).
 *
 * A transcript load used to transfer every byte the agent ever produced —
 * megabyte command outputs, whole file bodies behind a one-line `+40 -12`
 * summary, and base64 screenshots — even though the UI draws a few dozen lines
 * of each. This module rewrites those payloads on their way to the browser so
 * only what is visible without a click goes over the wire, and the rest is
 * fetched from the endpoints in `api-routes-lazy-bodies.ts` when the user opens
 * the view that shows it.
 *
 * ## This must never run on the write path
 *
 * The projection is applied when a message is *served*, never when it is
 * stored. Full bodies stay in SQLite, so nothing is lost and an existing
 * transcript benefits on its next load.
 *
 * In particular it must NOT live in `ChatHistoryManager.fromRow`. `fromRow`
 * feeds several read-modify-write paths (`updateLastMessage`,
 * `updateBugReportCard`, `upsertReleaseCard`, and siblings) that decode a row,
 * mutate one field, and write the whole row back through `toRow`. Slicing there
 * would make every one of those silently persist the truncation, permanently
 * destroying the bodies this design is careful to keep. `load()` also has
 * internal consumers (rollback handlers, agent env, PR-description building)
 * that need the real content. Hence a separate function, applied at the two
 * places the browser is on the other end: `getChatHistory` and the live
 * `agent_event` emit.
 *
 * ## Ordering, and why the live path is safe
 *
 * On the live path the projection runs on a *copy* for the emit only; the
 * original event flows on to `extractToolResults` and is persisted whole.
 * A client that immediately requests a stripped body cannot outrun the write:
 * `replaceInProgress` is a synchronous better-sqlite3 call in the same tick as
 * the emit, so the row is committed before the WebSocket frame reaches the
 * network.
 */

import { createHash } from "node:crypto";
import { sliceBody } from "../shared/transcript-slice.js";
import { SUBAGENT_TOOL_NAMES } from "../shared/transcript-slice-tools.js";
import type { PersistedMessage } from "./chat-history.js";
import type { AgentEvent } from "../shared/types.js";
import type { ToolResultEntry } from "./session-runner.js";

/** Tools whose *input* is a file body drawn as a one-line diff summary. */
const DIFF_INPUT_TOOLS = new Set(["Edit", "Write"]);

/** Input keys holding a file body, stripped once the line stats are computed. */
const DIFF_BODY_KEYS = ["content", "old_string", "new_string"] as const;
const DIFF_BODY_KEY_SET = new Set<string>(DIFF_BODY_KEYS);

export function imageUrl(sessionId: string, hash: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/images/${hash}`;
}

/** sha256 of the base64 payload — addresses an image by what it is. */
export function imageHash(base64: string): string {
  return createHash("sha256").update(base64).digest("hex");
}

function countLines(text: string): number {
  if (!text) return 0;
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
  return normalized ? normalized.split("\n").length : 0;
}

/**
 * Replace base64 image payloads inside a tool result's JSON content array with
 * URLs, leaving the text alone. MCP image results (Playwright screenshots) are
 * persisted as `JSON.stringify(content)` — an array of text and base64 image
 * blocks — and the client's `parseContentForImages` needs the whole array to
 * stay valid JSON.
 *
 * Returns the original string unchanged when there is nothing image-shaped in
 * it, so the overwhelming majority of results pay only a `startsWith` check.
 */
export function substituteResultImages(sessionId: string, content: string): string {
  const projected = projectBlockArray(sessionId, content, false);
  return projected ? projected.content : content;
}

/**
 * Project a tool result that is a JSON array of content blocks, keeping the
 * array valid JSON.
 *
 * A block array must never be sliced as a raw string: it is emitted by
 * `JSON.stringify`, so it is a *single line* — the line cap never fires and the
 * byte backstop would cut it mid-array, leaving unparseable JSON.
 * `parseContentForImages` would then return null and the screenshot would
 * degrade into a wall of raw JSON. So the slice is applied to the *text* inside
 * the blocks instead, and the structure is rebuilt around it.
 *
 * Text blocks are collapsed into one because that is what the client already
 * renders: `parseContentForImages` joins them with newlines into a single
 * preview body.
 *
 * Returns null when `content` isn't a block array, leaving the ordinary
 * string-slicing path to handle it.
 */
function projectBlockArray(
  sessionId: string,
  content: string,
  slice: boolean,
): { content: string; sliced: ReturnType<typeof sliceBody> } | null {
  if (!content.startsWith("[")) return null;
  let blocks: unknown;
  try {
    blocks = JSON.parse(content);
  } catch {
    return null;
  }
  if (!Array.isArray(blocks)) return null;

  const texts: string[] = [];
  let sawImage = false;
  for (const block of blocks) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
    if (b.type === "image") sawImage = true;
  }
  // Nothing image-shaped and nothing to slice — leave it to the string path so
  // ordinary JSON results (a tool returning a data structure) still get bounded.
  if (!sawImage) return null;

  const joined = texts.join("\n");
  const sliced = slice ? sliceBody(joined) : null;
  const text = sliced ? sliced.content : joined;

  let textEmitted = false;
  const rewritten: unknown[] = [];
  for (const block of blocks) {
    if (typeof block !== "object" || block === null) {
      rewritten.push(block);
      continue;
    }
    const b = block as Record<string, unknown>;
    if (b.type === "text") {
      if (textEmitted) continue;
      textEmitted = true;
      rewritten.push({ ...b, text });
      continue;
    }
    if (b.type === "image") {
      const source = b.source as Record<string, unknown> | undefined;
      if (source && typeof source.data === "string" && source.data) {
        const { data, ...rest } = source;
        rewritten.push({ ...b, source: { ...rest, shipit_url: imageUrl(sessionId, imageHash(data)) } });
        continue;
      }
    }
    rewritten.push(block);
  }

  return { content: JSON.stringify(rewritten), sliced };
}

/**
 * Project one tool result. `toolName` is the name of the tool that produced it,
 * used for the single exemption: a Task/Skill/Agent result carries the
 * subagent's final report, which `SubagentCall` renders in full as markdown
 * with no expand affordance — slicing it would visibly cut the report with no
 * way to get the rest back.
 */
export function projectToolResult(
  sessionId: string,
  result: ToolResultEntry,
  toolName: string | undefined,
): ToolResultEntry {
  const exempt = !!toolName && SUBAGENT_TOOL_NAMES.has(toolName);

  // Block arrays (MCP image results) take the structure-preserving path, which
  // slices the text inside the blocks rather than the JSON string around them.
  const blocks = projectBlockArray(sessionId, result.content, !exempt);
  if (blocks) {
    if (exempt || !blocks.sliced) {
      return blocks.content === result.content ? result : { ...result, content: blocks.content };
    }
    return {
      ...result,
      content: blocks.content,
      truncated: true,
      totalLines: blocks.sliced.totalLines,
      totalBytes: blocks.sliced.totalBytes,
    };
  }

  if (exempt) return result;

  const sliced = sliceBody(result.content);
  if (!sliced) return result;
  return {
    ...result,
    content: sliced.content,
    truncated: true,
    totalLines: sliced.totalLines,
    totalBytes: sliced.totalBytes,
  };
}

/**
 * Project a tool_use block: for Edit/Write, compute the `+N -M` stats the diff
 * summary draws and drop the file body, which is only ever shown in the modal
 * behind a click.
 */
export function projectToolUse<T extends { name: string; input: Record<string, unknown> }>(
  tool: T,
): T & { bodyTruncated?: true; diffStats?: { added: number; removed: number } } {
  if (!DIFF_INPUT_TOOLS.has(tool.name)) return tool;
  const str = (key: string): string => (typeof tool.input[key] === "string" ? tool.input[key] : "");
  if (!DIFF_BODY_KEYS.some((k) => str(k).length > 0)) return tool;

  const added = countLines(str("new_string") || str("content"));
  const removed = countLines(str("old_string"));

  // Rebuilt by filtering rather than `delete`-ing keys off a copy: a dynamic
  // delete is both slower (it deoptimizes the object's shape) and banned by
  // lint, and the projection runs over every tool_use in every served message.
  const input = Object.fromEntries(
    Object.entries(tool.input).filter(([k]) => !DIFF_BODY_KEY_SET.has(k)),
  );

  return { ...tool, input, bodyTruncated: true, diffStats: { added, removed } };
}

/** Build an id → tool-name map so results can find the tool that produced them. */
function toolNamesFor(msg: PersistedMessage): Map<string, string> {
  const names = new Map<string, string>();
  for (const t of msg.toolUse ?? []) names.set(t.id, t.name);
  for (const ev of msg.subagentEvents ?? []) {
    if (ev.kind === "assistant") for (const t of ev.toolUse ?? []) names.set(t.id, t.name);
  }
  return names;
}

/**
 * Project a whole persisted transcript for delivery to the browser. Returns new
 * objects only where something changed, so untouched messages keep their
 * identity and the common all-small transcript allocates nothing.
 */
export function projectMessagesForWire(sessionId: string, messages: PersistedMessage[]): PersistedMessage[] {
  return messages.map((msg) => {
    const names = toolNamesFor(msg);
    let changed = false;

    const toolResults = msg.toolResults?.map((r) => {
      const projected = projectToolResult(sessionId, r, names.get(r.toolUseId));
      if (projected !== r) changed = true;
      return projected;
    });

    const toolUse = msg.toolUse?.map((t) => {
      const projected = projectToolUse(t);
      if (projected !== t) changed = true;
      return projected;
    });

    const images = msg.images?.map((img) => {
      if (!img.data) return img;
      changed = true;
      return { mediaType: img.mediaType, src: imageUrl(sessionId, imageHash(img.data)) };
    });

    const subagentEvents = msg.subagentEvents?.map((ev) => {
      if (ev.kind === "tool_result") {
        const results = ev.toolResults.map((r) => projectToolResult(sessionId, r, names.get(r.toolUseId)));
        if (results.some((r, i) => r !== ev.toolResults[i])) {
          changed = true;
          return { ...ev, toolResults: results };
        }
        return ev;
      }
      const original = ev.toolUse;
      if (!original) return ev;
      const tools = original.map((t) => projectToolUse(t));
      if (tools.some((t, i) => t !== original[i])) {
        changed = true;
        return { ...ev, toolUse: tools };
      }
      return ev;
    });

    if (!changed) return msg;
    return {
      ...msg,
      ...(toolResults ? { toolResults } : {}),
      ...(toolUse ? { toolUse } : {}),
      ...(images ? { images } : {}),
      ...(subagentEvents ? { subagentEvents } : {}),
    };
  });
}

/**
 * Project a live `agent_event` for the emit. Returns the same reference when
 * nothing changed — the caller must keep using the ORIGINAL event for
 * persistence, since the stored row has to hold the full body.
 */
export function projectAgentEventForWire(
  sessionId: string,
  event: AgentEvent,
  toolNameOf: (id: string) => string | undefined,
): AgentEvent {
  if (event.type === "agent_tool_result") {
    const content: unknown = (event as { content?: unknown }).content;
    if (!Array.isArray(content)) return event;
    let changed = false;
    const blocks = (content as unknown[]).map((b): unknown => {
      if (typeof b !== "object" || b === null) return b;
      const block = b as Record<string, unknown>;
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") return b;
      const raw = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
      const projected = projectToolResult(
        sessionId,
        { toolUseId: block.tool_use_id, content: raw },
        toolNameOf(block.tool_use_id),
      );
      if (projected.content === raw && !projected.truncated) return b;
      changed = true;
      return {
        ...block,
        content: projected.content,
        ...(projected.truncated ? {
          shipit_truncated: true,
          shipit_total_lines: projected.totalLines,
          shipit_total_bytes: projected.totalBytes,
        } : {}),
      };
    });
    return changed ? { ...event, content: blocks } : event;
  }

  if (event.type === "agent_assistant") {
    const message = (event as { message?: { content?: unknown } }).message;
    const content: unknown = message?.content;
    if (!Array.isArray(content)) return event;
    let changed = false;
    const blocks = (content as unknown[]).map((b): unknown => {
      if (typeof b !== "object" || b === null) return b;
      const block = b as Record<string, unknown>;
      if (block.type !== "tool_use" || typeof block.name !== "string") return b;
      const projected: unknown = projectToolUse(block as unknown as { name: string; input: Record<string, unknown> });
      if (projected === b) return b;
      changed = true;
      return projected;
    });
    return changed ? ({ ...event, message: { ...message, content: blocks } } as AgentEvent) : event;
  }

  return event;
}
