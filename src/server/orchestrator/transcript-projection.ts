/**
 * Serve-path projection for heavy transcript bodies (docs/244, planning#269).
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
 *   4. Two side-channel emits that carry transcript payload of their own and
 *      reach the browser without passing through any of the above: the
 *      `message_steered` echo (`ws-handlers/send-message.ts`, which substitutes
 *      its image URLs directly via {@link imageUrl}) and the
 *      `sub_agent_consult_card` (`services/sub-agent.ts`, via
 *      {@link projectConsultCardForWire}). planning#299.
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
import {
  sliceBody,
  subAgentPreviewLine,
  RESULT_STRIP_FLOOR_BYTES,
} from "../shared/transcript-slice.js";
import {
  shipsResultBodyWhole,
  rendersResultContentInline,
  SUBAGENT_REPORT_TOOL_NAMES,
} from "../shared/transcript-slice-tools.js";
import { sliceSubagentReport } from "../shared/subagent-report.js";
import {
  COMMAND_SUMMARY_CHARS,
  INPUT_STRIP_FLOOR_BYTES,
  inputKeyTreatment,
} from "../shared/transcript-input-policy.js";
import type { PersistedMessage } from "./chat-history.js";
import type { AgentEvent, SubAgentConsultCard } from "../shared/types.js";
import type { ToolResultEntry } from "./session-runner.js";

/** Tools whose *input* is a file body drawn as a one-line diff summary. */
const DIFF_INPUT_TOOLS = new Set(["Edit", "Write"]);

/** Input keys holding a file body, whose line stats survive the body's removal. */
const DIFF_BODY_KEYS = ["content", "old_string", "new_string"] as const;

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
 * and selects between three treatments:
 *
 *   - **`WHOLE_RESULT_TOOL_NAMES`** ship whole, because the transcript renders
 *     them in full with no expand affordance and no fetch path, so slicing cuts
 *     text with no way to get it back. `AskUserQuestion` only (planning#293).
 *   - **`SUBAGENT_REPORT_TOOL_NAMES`** get the report-shaped slice below.
 *   - **everything else** gets the generic slice, or no body at all when
 *     nothing draws its content without a click.
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

  // A final report is clamped inline and the rest opens in a modal (docs/109
  // req 8), so only the clamped part belongs on the wire. It cannot go through
  // either branch below: its normal encoding is a `JSON.stringify`'d block
  // array, which is ONE line, so the generic line cap never fires and the byte
  // backstop would cut mid-array — leaving JSON `parseSubagentReport` can't
  // parse and the card renders verbatim (the planning#289 bug, reintroduced). The
  // report slice works on the text inside the blocks and rebuilds the
  // structure, keeping the accounting footer whole for the header chips.
  if (toolName && SUBAGENT_REPORT_TOOL_NAMES.has(toolName)) {
    // Image substitution FIRST, and unconditionally: a subagent can return a
    // screenshot alongside its report, and those base64 payloads are the
    // heaviest thing in the message — the clamp bounds the text and would leave
    // them untouched. `substituteResultImages` is a no-op for the text-only
    // report that is the normal case.
    const withUrls = substituteResultImages(sessionId, result.content);
    const sliced = sliceSubagentReport(withUrls);
    if (!sliced) {
      return withUrls === result.content ? result : { ...result, content: withUrls };
    }
    return {
      ...result,
      content: sliced.content,
      truncated: true,
      totalLines: sliced.totalLines,
      totalBytes: sliced.totalBytes,
    };
  }

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

/** Byte cost of an input value on the wire — the string itself, or its JSON. */
function inputValueBytes(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (value === undefined || value === null) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    // A circular or otherwise unserializable value never made it into the row
    // in the first place (`toRow` stringifies it), so this is unreachable in
    // practice — treat it as weightless rather than throwing on a serve path.
    return 0;
  }
}

/** True when this key is both projectable and big enough to be worth projecting. */
function shouldProjectInput(tool: { name: string; input: Record<string, unknown> }, key: string): boolean {
  if (inputKeyTreatment(tool.name, key, tool.input) === "keep") return false;
  return inputValueBytes(tool.input[key]) > INPUT_STRIP_FLOOR_BYTES;
}

/**
 * The `+N -M` an Edit/Write draws inline, computed from the WHOLE body before
 * any of it leaves the payload. `DiffBlock` prefers these over recomputing from
 * the strings, and `countLines` here is a copy of `DiffBlock.countLines` — a
 * test pins them equal, because a mismatch changes the summary on reload.
 *
 * Returns undefined for anything that isn't a file write, and for a write with
 * no body at all (nothing to count, nothing stripped).
 */
function diffStatsFor(tool: { name: string; input: Record<string, unknown> }): { added: number; removed: number } | undefined {
  if (!DIFF_INPUT_TOOLS.has(tool.name)) return undefined;
  const str = (key: string): string => (typeof tool.input[key] === "string" ? tool.input[key] : "");
  if (!DIFF_BODY_KEYS.some((k) => str(k).length > 0)) return undefined;
  return {
    added: countLines(str("new_string") || str("content")),
    removed: countLines(str("old_string")),
  };
}

/**
 * Project a tool_use block: keep the input keys the transcript draws, shorten
 * the one it draws a fixed prefix of, and drop the rest — which is everything
 * the tool-call modal alone displays.
 *
 * Which key is which is `inputKeyTreatment`'s job (`transcript-input-policy.ts`,
 * planning#298); this function is only the mechanics. Edit/Write are no longer a
 * special case for *stripping* — their body keys are dropped by the ordinary
 * rule, and the special case that remains is the `+N -M` the summary needs,
 * which has to be computed before the body goes.
 *
 * Two properties worth keeping:
 *
 *   - the same reference comes back when nothing needed projecting, so the
 *     common small-input transcript allocates nothing; and
 *   - key order is preserved, because the modal renders `Object.keys(input)`.
 */
export function projectToolUse<T extends { name: string; input: Record<string, unknown> }>(
  tool: T,
): T & { bodyTruncated?: true; diffStats?: { added: number; removed: number }; inputChars?: Record<string, number> } {
  const keys = Object.keys(tool.input);
  if (!keys.some((k) => shouldProjectInput(tool, k))) return tool;

  // Rebuilt by filtering rather than `delete`-ing keys off a copy: a dynamic
  // delete is both slower (it deoptimizes the object's shape) and banned by
  // lint, and the projection runs over every tool_use in every served message.
  const input: Record<string, unknown> = {};
  const inputChars: Record<string, number> = {};
  for (const key of keys) {
    const value = tool.input[key];
    if (!shouldProjectInput(tool, key)) {
      input[key] = value;
      continue;
    }
    // The length the client would have measured, for the labels drawn from it
    // (`Prompt (N chars)` in `SubagentCall`). Only meaningful for strings; a
    // dropped object leaves no trace but the `bodyTruncated` flag.
    if (typeof value === "string") {
      inputChars[key] = value.length;
      if (inputKeyTreatment(tool.name, key, tool.input) === "head") {
        input[key] = value.slice(0, COMMAND_SUMMARY_CHARS);
      }
    }
  }

  const diffStats = diffStatsFor(tool);
  return {
    ...tool,
    input,
    bodyTruncated: true,
    ...(diffStats ? { diffStats } : {}),
    ...(Object.keys(inputChars).length > 0 ? { inputChars } : {}),
  };
}

/**
 * Project a sub-agent consult card (planning#299). The card face draws one collapsed
 * preview line; the rest of the output is modal-only, so under requirement 1 it
 * does not belong on the wire — `SubAgentConsultCardRow` fetches it from
 * `/api/sessions/:id/sub-agent-consults/:cardId` when the viewer opens.
 *
 * The server builds the preview rather than shipping a head slice, because the
 * card face is not a slice: it collapses whitespace, so a byte-equal preview has
 * to come from the same function the client draws with
 * ({@link subAgentPreviewLine}).
 *
 * Same floor as a tool-result body, for the same reason: below it, `truncated` +
 * a preview that is nearly the whole text costs more than it saves and buys a
 * round-trip for a couple of lines.
 *
 * Returns the same reference when nothing changed.
 */
export function projectConsultCardForWire(card: SubAgentConsultCard): SubAgentConsultCard {
  const output = card.outputMarkdown;
  if (!output) return card;
  if (Buffer.byteLength(output, "utf8") <= RESULT_STRIP_FLOOR_BYTES) return card;
  const preview = subAgentPreviewLine(output);
  if (preview === output) return card;
  return { ...card, outputMarkdown: preview, outputTruncated: true };
}

/**
 * The ids whose bodies are already on disk for the turn in flight (planning#299).
 *
 * The reconnect snapshot is built from the runner's in-memory groups, part of
 * which a boundary has already committed and part of which it has not. Without a
 * marker the snapshot cannot tell the halves apart, so it took the conservative
 * option for all of it and re-sent every already-committed tool input and nested
 * subagent result.
 *
 * This is an id set rather than the "events up to index N" cursor the issue
 * imagined, because a group is **mutated in place**: `attachToolResultsToGroup`
 * and `attachSubagentToolResults` append to a group that a boundary has already
 * persisted, and the standalone-merge branch of `accumulateAssistantGroups`
 * pushes a fresh `tool_use` into it. So "group index < N" does not imply "every
 * body inside it is on disk", while "this id was in the message set we handed
 * `replaceInProgress`" does.
 *
 * Inputs and results are tracked separately even though they share an id: a
 * subagent's `tool_use` can reach disk at one boundary while its result — which
 * skips `replaceInProgress` entirely — is still only in memory. One set would
 * let the second be stripped on the strength of the first, promising a fetch
 * that 404s.
 */
export interface CommittedBodyIds {
  /** tool_use ids whose INPUT body is in a persisted row. */
  toolInputs: Set<string>;
  /** tool_use ids whose RESULT is in a persisted row. */
  toolResults: Set<string>;
}

export function createCommittedBodyIds(): CommittedBodyIds {
  return { toolInputs: new Set(), toolResults: new Set() };
}

/** Turn start: nothing of the new turn is on disk yet. */
export function clearCommittedBodyIds(ids: CommittedBodyIds): void {
  ids.toolInputs.clear();
  ids.toolResults.clear();
}

/**
 * Record everything a just-written `replaceInProgress` put on disk. Called with
 * the exact message list that was persisted, so the set can only ever
 * under-report (a missed call site means fewer strips, never a promised fetch
 * that 404s).
 */
export function markMessagesCommitted(ids: CommittedBodyIds, messages: PersistedMessage[]): void {
  for (const msg of messages) {
    for (const t of msg.toolUse ?? []) ids.toolInputs.add(t.id);
    for (const r of msg.toolResults ?? []) ids.toolResults.add(r.toolUseId);
    for (const ev of msg.subagentEvents ?? []) {
      if (ev.kind === "assistant") {
        for (const t of ev.toolUse ?? []) ids.toolInputs.add(t.id);
      } else {
        for (const r of ev.toolResults) ids.toolResults.add(r.toolUseId);
      }
    }
  }
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
 *   - **Tool inputs** arrive on an `agent_assistant` event, and nothing commits
 *     that row until the *next* tool-result boundary.
 *   - **Results nested under a subagent** are worse: the `parentToolUseId`
 *     branch of the `agent_tool_result` handler calls
 *     `attachSubagentToolResults` and **returns**, skipping the
 *     `replaceInProgress` below it. They reach disk only at the next
 *     *top-level* boundary, which for a long Task is many tool calls later.
 *
 * The last two are therefore stripped on the **history path**, where every row
 * is on disk by construction because the read came from the database — and, on
 * the reconnect snapshot, for whichever of them a boundary has already written
 * ({@link CommittedBodyIds}, planning#299). On the live emit they stay inline: an
 * event being emitted right now is the one thing no boundary can have committed
 * yet.
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
  /**
   * planning#299 — the per-payload escape hatch from the blanket `false` above.
   *
   * An in-flight turn is not uniformly uncommitted: the boundaries it has
   * already passed wrote their groups to disk, and those bodies are as fetchable
   * as any history row. When supplied, an id in {@link CommittedBodyIds} is
   * treated exactly as `allRowsPersisted` treats everything — so a mid-turn
   * reconnect strips the committed prefix and keeps only the genuinely
   * in-memory tail inline. Omitted ⇒ the old all-or-nothing behavior.
   */
  committedBodyIds?: CommittedBodyIds;
}

/**
 * Project a whole persisted transcript for delivery to the browser. Returns new
 * objects only where something changed, so untouched messages keep their
 * identity and the common all-small transcript allocates nothing.
 */
export function projectMessagesForWire(
  sessionId: string,
  messages: PersistedMessage[],
  { allRowsPersisted = true, committedBodyIds }: WireProjectionOptions = {},
): PersistedMessage[] {
  // The two "is this body fetchable yet?" predicates. On the history path
  // everything is; on an in-flight turn only what a boundary already wrote.
  const inputCommitted = (id: string): boolean =>
    allRowsPersisted || (committedBodyIds?.toolInputs.has(id) ?? false);
  const resultCommitted = (id: string): boolean =>
    allRowsPersisted || (committedBodyIds?.toolResults.has(id) ?? false);

  return messages.map((msg) => {
    const names = toolNamesFor(msg);
    let changed = false;

    const toolResults = msg.toolResults?.map((r) => {
      const projected = projectToolResult(sessionId, r, names.get(r.toolUseId));
      if (projected !== r) changed = true;
      return projected;
    });

    const toolUse = msg.toolUse?.map((t) => {
      if (!inputCommitted(t.id)) return t;
      const projected = projectToolUse(t);
      if (projected !== t) changed = true;
      return projected;
    });

    const subAgentConsult = msg.subAgentConsult
      ? projectConsultCardForWire(msg.subAgentConsult)
      : undefined;
    if (subAgentConsult && subAgentConsult !== msg.subAgentConsult) changed = true;

    const images = msg.images?.map((img) => {
      if (!img.data) return img;
      changed = true;
      return { mediaType: img.mediaType, src: imageUrl(sessionId, imageHash(img.data)) };
    });

    const subagentEvents = msg.subagentEvents?.map((ev) => {
      if (ev.kind === "tool_result") {
        // Nested results skip the `replaceInProgress` their top-level siblings
        // run through, so on an in-flight turn they may exist only in memory —
        // unless a later top-level boundary has since swept them onto disk,
        // which is what the committed set records.
        const results = ev.toolResults.map((r) =>
          resultCommitted(r.toolUseId) ? projectToolResult(sessionId, r, names.get(r.toolUseId)) : r);
        if (results.some((r, i) => r !== ev.toolResults[i])) {
          changed = true;
          return { ...ev, toolResults: results };
        }
        return ev;
      }
      const original = ev.toolUse;
      if (!original) return ev;
      const tools = original.map((t) => (inputCommitted(t.id) ? projectToolUse(t) : t));
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
      ...(subAgentConsult ? { subAgentConsult } : {}),
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
 *   - An `agent_assistant` carrying any tool input, which nothing commits until
 *     the next tool-result boundary.
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
 * planning#299 — `committed` narrows that blanket exemption to the part of the turn
 * that genuinely is still in memory. An Edit from a group two boundaries back is
 * on disk, and now says so, so a mid-turn reconnect no longer re-sends it. Omit
 * the argument (tests, callers without a runner) and the conservative
 * all-or-nothing behavior is unchanged.
 */
export function projectTurnSnapshotForWire(
  sessionId: string,
  messages: PersistedMessage[],
  committed?: CommittedBodyIds,
): PersistedMessage[] {
  return projectMessagesForWire(sessionId, messages, {
    allRowsPersisted: false,
    ...(committed ? { committedBodyIds: committed } : {}),
  });
}
