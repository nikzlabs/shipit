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
 * that need the real content. Hence a separate function, applied at the three
 * places the browser is on the other end:
 *
 *   1. `getChatHistory` — history loads, reloads, session switches.
 *   2. The live `agent_event` emit (`agent-listeners.ts`).
 *   3. The reconnect `turn_snapshot` (`route-registry.ts`), which is built from
 *      the runner's in-memory groups and so bypasses (1) entirely.
 *
 * ## What each path may strip
 *
 * Not all three may strip the same things — see {@link WireProjectionOptions}.
 * The rule is that a body may only leave the wire once the row holding it is
 * committed, and the payload classes reach disk at different moments. Only path
 * (1) can strip everything.
 *
 * On the live path the projection runs on a *copy* for the emit only; the
 * original event flows on to `extractToolResults` and is persisted whole.
 */

import { createHash } from "node:crypto";
import { sliceBody, RESULT_STRIP_FLOOR_BYTES } from "../shared/transcript-slice.js";
import { shipsResultBodyWhole, rendersResultContentInline } from "../shared/transcript-slice-tools.js";
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
  const projected = projectBlockArray(sessionId, content, "keep");
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
  mode: "keep" | "slice" | "empty",
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
  // "empty" is the modal-only case: nothing draws this text until the modal
  // opens, so none of it ships. The image URLs stay — they are ~100 bytes each
  // and keeping them means the screenshot paints immediately on open while the
  // text is still in flight.
  // The same floor the plain-body path uses: below it, emptying the text costs
  // more in markers than it saves and buys a round-trip for a few characters.
  const belowFloor = Buffer.byteLength(joined, "utf8") <= RESULT_STRIP_FLOOR_BYTES;
  const sliced = mode === "keep" || !joined || belowFloor
    ? null
    : mode === "empty"
      ? { content: "", totalLines: countLines(joined), totalBytes: Buffer.byteLength(joined, "utf8") }
      : sliceBody(joined);
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
 * used for the exemption: `WHOLE_RESULT_TOOL_NAMES` are the tools the transcript
 * renders in full with no expand affordance and no fetch path, so slicing them
 * cuts text with no way to get it back. That is the subagent final report
 * (`SubagentCall` renders it as markdown, nothing to click) and
 * `AskUserQuestion` (the Ask branch returns before the output modal, so a
 * sliced answer's tail is unreachable — SHI-291).
 *
 * `Skill` is NOT exempt: it renders no report, so its body goes through the
 * ordinary bound like any other tool result. Nor is `present`, which reads an
 * artifact id out of the head of a compact payload that a slice preserves.
 */
export function projectToolResult(
  sessionId: string,
  result: ToolResultEntry,
  toolName: string | undefined,
): ToolResultEntry {
  const exempt = shipsResultBodyWhole(toolName);

  // Requirement 1, applied at full strength: nothing renders this result's
  // content without a click, so the transcript carries none of it. The slice
  // below is the weaker fallback for the results something *does* draw inline.
  //
  // The metadata requirement 3 names is what stays — tool-use id, existence,
  // error state, duration — plus the flag and line count the modal needs. An
  // image-bearing result still goes through the block path first: its URLs are
  // tiny and the modal renders them from the same substituted JSON.
  if (!exempt && !rendersResultContentInline(toolName)) {
    const blocks = projectBlockArray(sessionId, result.content, "empty");
    if (blocks) {
      if (!blocks.sliced) {
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
    // Below the floor, stripping makes the payload BIGGER than leaving the body
    // in — `truncated`/`totalLines`/`totalBytes` outweigh a short result, and it
    // would buy a fetch round-trip to retrieve a handful of characters.
    if (Buffer.byteLength(result.content, "utf8") <= RESULT_STRIP_FLOOR_BYTES) return result;
    return {
      ...result,
      content: "",
      truncated: true,
      totalLines: countLines(result.content),
      totalBytes: Buffer.byteLength(result.content, "utf8"),
    };
  }

  // Block arrays (MCP image results) take the structure-preserving path, which
  // slices the text inside the blocks rather than the JSON string around them.
  const blocks = projectBlockArray(sessionId, result.content, exempt ? "keep" : "slice");
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
 * # The one rule: a body may only leave the wire once its row is committed
 *
 * Stripping a body replaces it with a fetch. If the row holding it is not on
 * disk yet, that fetch 404s — which breaks req 2 ("a body that is not
 * transferred up front must be fetchable on demand"). So what is safe to strip
 * depends entirely on *when the payload's row gets written*, and the classes
 * differ:
 *
 *   - **Top-level tool results** are committed by `replaceInProgress` inside
 *     the `agent_tool_result` handler, synchronously in the same tick as the
 *     emit (`agent-listeners.ts`). Safe everywhere.
 *   - **User-row images** are persisted when the turn opens. Safe everywhere.
 *   - **Edit/Write inputs** arrive on an `agent_assistant` event, and nothing
 *     commits that row until the *next* tool-result boundary.
 *   - **Results nested under a subagent** are worse: the `parentToolUseId`
 *     branch of the `agent_tool_result` handler calls
 *     `attachSubagentToolResults` and **returns**, skipping the
 *     `replaceInProgress` below it. They reach disk only at the next
 *     *top-level* boundary, which for a long Task is many tool calls later.
 *
 * The last two are therefore stripped on the **history path only**, where every
 * row is on disk by construction because the read came from the database. On
 * the live emit and the reconnect snapshot they stay inline, exactly as they
 * are today.
 *
 * That gives up part of the live-path saving. It is the right trade twice over:
 * an unfetchable body is a visible failure while a fatter live frame is not,
 * and the bytes this feature exists to remove accumulate across *reloads* — a
 * transcript is loaded many times and lived through once.
 *
 * The alternative — persisting nested results before emitting them — was
 * considered and rejected: `replaceInProgress` deletes and re-inserts every row
 * in the turn, re-serializing the whole `subagent_events` blob each time, so
 * calling it per nested result is quadratic in the number of subagent tool
 * calls. That cost lands hardest on exactly the Task-heavy turns this feature
 * targets. Making persistence incremental would change the trade, but that is
 * `ChatHistoryManager` work, not this feature's.
 *
 * Both earlier versions of this module got this wrong the same way: a guarantee
 * was verified on one code path and then written up as general. That is the
 * failure `CLAUDE.md` warns about, and it is why this is one explicit flag
 * rather than a comment asserting the paths are equivalent.
 */
export interface WireProjectionOptions {
  /**
   * Whether every row in `messages` is already committed to SQLite.
   *
   * True on the history path (the messages *came from* the database). False for
   * an in-flight turn — the live emit and the reconnect snapshot — where the
   * most recent groups may not be written yet.
   */
  allRowsPersisted?: boolean;
}

/**
 * Project a whole persisted transcript for delivery to the browser. Returns new
 * objects only where something changed, so untouched messages keep their
 * identity and the common all-small transcript allocates nothing.
 */
export function projectMessagesForWire(
  sessionId: string,
  messages: PersistedMessage[],
  { allRowsPersisted = true }: WireProjectionOptions = {},
): PersistedMessage[] {
  return messages.map((msg) => {
    const names = toolNamesFor(msg);
    let changed = false;

    const toolResults = msg.toolResults?.map((r) => {
      const projected = projectToolResult(sessionId, r, names.get(r.toolUseId));
      if (projected !== r) changed = true;
      return projected;
    });

    const toolUse = allRowsPersisted
      ? msg.toolUse?.map((t) => {
        const projected = projectToolUse(t);
        if (projected !== t) changed = true;
        return projected;
      })
      : msg.toolUse;

    const images = msg.images?.map((img) => {
      if (!img.data) return img;
      changed = true;
      return { mediaType: img.mediaType, src: imageUrl(sessionId, imageHash(img.data)) };
    });

    const subagentEvents = msg.subagentEvents?.map((ev) => {
      if (ev.kind === "tool_result") {
        // Nested results skip the `replaceInProgress` their top-level siblings
        // run through, so on an in-flight turn they may exist only in memory.
        if (!allRowsPersisted) return ev;
        const results = ev.toolResults.map((r) => projectToolResult(sessionId, r, names.get(r.toolUseId)));
        if (results.some((r, i) => r !== ev.toolResults[i])) {
          changed = true;
          return { ...ev, toolResults: results };
        }
        return ev;
      }
      const original = ev.toolUse;
      if (!original || !allRowsPersisted) return ev;
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
 *
 * TOP-LEVEL tool results only — the one payload class this handler commits in
 * the same tick as the emit. Two neighbours are deliberately left whole:
 *
 *   - An `agent_assistant` carrying an Edit/Write body, which nothing commits
 *     until the next tool-result boundary.
 *   - A nested (`parentToolUseId`) result, whose handler branch returns before
 *     `replaceInProgress` runs at all.
 *
 * Strip either here and the fetch behind it 404s. Both are still stripped on
 * every subsequent history load, which is where the bytes accumulate. See
 * {@link WireProjectionOptions} for the full rule.
 */
export function projectAgentEventForWire(
  sessionId: string,
  event: AgentEvent,
  toolNameOf: (id: string) => string | undefined,
): AgentEvent {
  if (event.type === "agent_tool_result") {
    // Nested subagent result: `attachSubagentToolResults` + `return`, no commit.
    if (event.parentToolUseId) return event;
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

  return event;
}

/**
 * Project the reconnect / session-switch `turn_snapshot` (req 6).
 *
 * This is the third browser-facing path, and it is easy to miss: it is built
 * from `runner.chatMessageGroups` rather than read from the DB, so it bypasses
 * `getChatHistory` entirely. Without this a reconnect mid-turn re-sent every
 * megabyte the projection had just removed.
 *
 * The snapshot describes an **in-flight** turn, so it is projected as
 * not-fully-persisted: top-level results and images are stripped, tool inputs
 * and nested subagent results are not. An earlier version claimed everything
 * here "reached the snapshot through a tool-result boundary that persisted it";
 * that is false for both of those classes, and stripping them handed the client
 * a lazy affordance backed by no row.
 *
 * This does resend some already-committed bodies — an Edit in an older group is
 * on disk by now, but the flag is per-call rather than per-group. Tightening it
 * needs a committed-prefix marker on the runner (`lastPersistedBufferIndex` is
 * a buffer index, not a group boundary), which is more machinery than the
 * duplicate bytes on a mid-turn reconnect are worth.
 */
export function projectTurnSnapshotForWire(sessionId: string, messages: PersistedMessage[]): PersistedMessage[] {
  return projectMessagesForWire(sessionId, messages, { allRowsPersisted: false });
}
