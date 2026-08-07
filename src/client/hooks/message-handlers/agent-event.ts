import type { WsAgentEvent, AgentContentBlock } from "../../../server/shared/types.js";
import type { ChatMessage, ToolResultBlock } from "../../components/MessageList.js";
import { activityFromTool } from "../../components/StreamingIndicator.js";
import { isTerminalTranscriptEntry } from "../../components/visual-elements.js";
import { shipsResultBodyWhole, SUBAGENT_REPORT_TOOL_NAMES } from "../../../server/shared/transcript-slice-tools.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * Hard ceiling on how much of a single tool result the live path keeps in
 * memory. A backstop, not the primary bound — docs/244's serve-path projection
 * slices heavy results before they are emitted. What still reaches this are the
 * classes that projection deliberately leaves inline (an `AskUserQuestion`
 * answer, and nested subagent results before their row is committed).
 *
 * Exported for the test that pins the cap's markers.
 */
export const CLIENT_CONTENT_CAP = 1_000_000;

/**
 * Largest index ≤ `max` that does not split a UTF-16 surrogate pair, so a
 * clipped body never ends in a lone surrogate (which renders as `�`).
 */
function safeCutAt(text: string, max: number): number {
  const code = text.charCodeAt(max - 1);
  // High surrogate at the boundary means its pair starts here — drop it.
  return code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
}

/**
 * Cap a JSON content-block array by shortening the TEXT inside it, leaving the
 * array itself valid JSON.
 *
 * An MCP result — a Playwright screenshot above all — is a
 * `JSON.stringify`'d array of `{type:"text"}` / `{type:"image"}` blocks, and it
 * is what `parseContentForImages` (`ToolResult.tsx`) re-parses to draw the
 * image. Being stringified it is ONE line of possibly megabytes, so the raw cap
 * below cuts it mid-array: the JSON no longer parses, the parse returns null,
 * and the tool-call modal renders the whole thing — base64 and all — as a wall
 * of raw JSON instead of the screenshot. That is the exact failure
 * `transcript-projection.ts`'s `projectBlockArray` was written to avoid on the
 * serve path ("a block array must never be sliced as a raw string"); the client
 * cap kept doing it, so every result the projection deliberately leaves inline
 * — a nested subagent's screenshot, most of all — degraded that way once its
 * base64 crossed the cap.
 *
 * Image blocks are kept WHOLE rather than counted against the budget. There is
 * nothing to substitute them with here: the `/images/:hash` URL the projection
 * uses is backed by the persisted row, and a nested result has no committed row
 * yet. So the choice is the image or nothing, and holding a screenshot the
 * transcript is about to draw is the point of having it. The bound this gives
 * up is recovered on the next history load, where the projection replaces the
 * payload with that URL.
 *
 * Returns undefined when `content` isn't a content-block array, leaving the raw
 * cap to handle it — an ordinary JSON payload from a tool that happens to
 * return an array is bounded exactly as before.
 */
function capContentBlocks(content: string, cap: number): { content: string; textRemoved: boolean; totalLines: number } | undefined {
  if (!content.startsWith("[")) return undefined;
  let blocks: unknown;
  try {
    blocks = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!Array.isArray(blocks)) return undefined;

  let isContentBlocks = false;
  let textRemoved = false;
  let budget = cap;
  // Counted over the TEXT, not the serialized array. `totalLines` labels a
  // "Show all N lines" button on the unwrapped text, and a stringified block
  // array is one physical line — so measuring `content` advertised "Show all 1
  // lines" for a body of thousands. Same units mismatch as the cap itself.
  let totalLines = 0;
  const capped = blocks.map((b): unknown => {
    if (typeof b !== "object" || b === null) return b;
    const block = b as Record<string, unknown>;
    if (block.type === "image") {
      isContentBlocks = true;
      return b;
    }
    if (block.type !== "text" || typeof block.text !== "string") return b;
    isContentBlocks = true;
    const text = block.text;
    // `parseContentForImages` joins text blocks with a newline, so each block
    // after the first contributes its own lines plus the joining one.
    totalLines += text.split("\n").length + (totalLines > 0 ? 1 : 0);
    if (text.length <= budget) {
      budget -= text.length;
      return b;
    }
    textRemoved = true;
    const head = text.slice(0, safeCutAt(text, budget));
    budget = 0;
    return { ...block, text: head };
  });
  if (!isContentBlocks) return undefined;
  return { content: JSON.stringify(capped), textRemoved, totalLines };
}

/**
 * Name of the tool that produced `toolUseId`, searched over the transcript the
 * result is about to be attached to. Needed to tell a body that must ship whole
 * from an ordinary result, since the tool_result block itself carries only the
 * id.
 */
function toolNameForResult(messages: ChatMessage[], toolUseId: string): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const top = msg.toolUse?.find((t) => t.id === toolUseId);
    if (top) return top.name;
    // A subagent can spawn a subagent, and the inner Task's tool_use lands in
    // `subagentEvents` rather than `toolUse`. Searching only the top level
    // resolved the inner Task to `undefined`, so its final report — nested AND
    // a final report at once — fell into the ordinary branch and was clipped.
    for (const ev of msg.subagentEvents ?? []) {
      if (ev.kind !== "assistant") continue;
      const nested = ev.toolUse?.find((t) => t.id === toolUseId);
      if (nested) return nested.name;
    }
  }
  return undefined;
}

export const handleAgentEvent: Handler<WsAgentEvent> = (_ctx, data) => {
  const session = useSessionStore.getState();
  // Guard: skip agent events until HTTP history is loaded. On WS reconnect,
  // events arrive immediately while loadSessionHistory() is still in-flight.
  // Without this guard, events processed before the HTTP response get
  // overwritten (lost) or events processed after it duplicate HTTP data.
  // The DB-backed history snapshot is the baseline; live events build on top.
  if (!session.historyLoaded) return;

  const event = data.event;

  if (event.type === "agent_assistant") {
    // Multiple text blocks within a single assistant event are distinct
    // preambles separated by tool_use blocks (common when a subagent runs
    // serial tool calls in one turn). Joining with "" runs them together
    // with no separator — "…cloaker.Now I have…". Use "\n\n" so each
    // preamble renders as its own paragraph under whitespace-pre-wrap.
    const textBlocks = (event.content ?? [])
      .filter((b: AgentContentBlock): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n\n");

    const toolUseBlocks = (event.content ?? [])
      // docs/244 — `bodyTruncated`/`diffStats` are added by the orchestrator's
      // wire projection for Edit/Write, whose file body is stripped. Named in
      // the predicate so they survive as types, not just at runtime.
      .filter((b: AgentContentBlock): b is {
        type: "tool_use";
        id: string;
        name: string;
        input: Record<string, unknown>;
        bodyTruncated?: true;
        diffStats?: { added: number; removed: number };
      } => b.type === "tool_use");

    // Subagent events (Task tool nested events) — attach to the parent
    // message's `subagentEvents` instead of the main message stream so the
    // SubagentCall renderer can show a nested tree (109 — subagent
    // transparency).
    const parentToolUseId = (event as { parentToolUseId?: string }).parentToolUseId;
    if (parentToolUseId) {
      session.setActivity({ label: "Subagent working..." });
      session.setMessages((prev) => attachSubagentAssistant(prev, parentToolUseId, textBlocks, toolUseBlocks));
    } else if (toolUseBlocks.length > 0) {
      const lastTool = toolUseBlocks[toolUseBlocks.length - 1];
      session.setActivity(activityFromTool(lastTool.name, lastTool.input));
    } else if (textBlocks) {
      session.setActivity({ label: "Thinking..." });
    }

    if (!parentToolUseId && toolUseBlocks.some((t) => t.name === "EnterPlanMode")) {
      useSettingsStore.getState().setPermissionMode(session.sessionId, "plan");
    }

    if (!parentToolUseId && (textBlocks || toolUseBlocks.length > 0)) {
      session.setMessages((prev) => {
        const last = prev[prev.length - 1];
        // A card-carrying message (permission prompt, voice note, etc.) or a
        // system notice is a terminal transcript entry, never a streaming-text
        // target. Either can carry `streaming: true` — a card after a history
        // reload of an in-progress turn (`loadSessionHistory` maps
        // `inProgress → streaming`), a notice as the last row of a running turn's
        // `turn_snapshot` — and the merge below rebuilds `last` from a fixed
        // field set, so merging into it would silently DROP the card/notice
        // fields. Exclude it from the merge so it survives (it falls to the
        // close-and-append branch, which preserves everything via `...m`). See
        // visual-elements' `isTerminalTranscriptEntry` for what qualifies and
        // why, and chat-card-persistence's buffer-cursor advance.
        const lastIsTerminal = !!last && isTerminalTranscriptEntry(last);
        const canMerge = last?.role === "assistant" && last.streaming && !lastIsTerminal
          && !(last.toolResults && last.toolResults.length > 0);
        // Standalone tools like ExitPlanMode and AskUserQuestion should stay
        // with the preceding assistant text even after tool results arrive.
        // Without this, the PlanApproval card renders in an empty bubble
        // disconnected from the plan text when the agent does research
        // (Read, Grep, etc.) between writing the plan and calling ExitPlanMode.
        const STANDALONE_MERGE = new Set(["EnterPlanMode", "ExitPlanMode", "AskUserQuestion"]);
        const isStandaloneOnly = !textBlocks && toolUseBlocks.length > 0
          && toolUseBlocks.every((t) => STANDALONE_MERGE.has(t.name));
        const forceMerge = isStandaloneOnly
          && last?.role === "assistant" && last.streaming && !lastIsTerminal;
        if (canMerge || forceMerge) {
          return [
            ...prev.slice(0, -1),
            {
              role: "assistant" as const,
              text: last.text + textBlocks,
              toolUse: [...(last.toolUse ?? []), ...toolUseBlocks],
              toolResults: last.toolResults,
              streaming: true,
            },
          ];
        }
        const closed = prev.map((m) =>
          m.role === "assistant" && m.streaming ? { ...m, streaming: false } : m
        );
        return [
          ...closed,
          {
            role: "assistant" as const,
            text: textBlocks,
            toolUse: toolUseBlocks,
            streaming: true,
          },
        ];
      });
    }
  }

  if (event.type === "agent_tool_result") {
    session.setActivity({ label: "Processing results..." });

    const results: ToolResultBlock[] = [];
    for (const block of (event.content ?? []) as Record<string, unknown>[]) {
      if (block.type === "tool_result" && block.tool_use_id) {
        const rawContent = block.content;
        let content: string;
        if (typeof rawContent === "string") {
          content = rawContent;
        } else if (rawContent === null || rawContent === undefined) {
          content = "";
        } else {
          content = JSON.stringify(rawContent);
        }
        // Backstop only. Since docs/244 the orchestrator already slices heavy
        // results before emitting, so this fires only for the classes the
        // projection leaves inline — and what to do differs per class, because
        // clipping is only acceptable when the body can be got back.
        //
        //   - A body in `WHOLE_RESULT_TOOL_NAMES` is exempt server-side
        //     precisely because the transcript renders it whole with no expand
        //     affordance and no fetch. Capping it here would re-truncate,
        //     permanently, the very bodies that exemption exists to protect —
        //     so it is not capped at all. Deliberately unbounded: the
        //     alternative is silently destroying the tail of a long
        //     `AskUserQuestion` answer (planning#293).
        //
        //     This used to test `SUBAGENT_TOOLS`, the *layout* set, which was
        //     wrong in both directions: it spared `Skill` (which renders no
        //     report and is sliced server-side anyway) while capping
        //     `AskUserQuestion` (which has no way to recover the tail). Client
        //     and server now read the same set.
        //
        //     A TOP-LEVEL subagent final report left that set with docs/109
        //     req 8: it clamps inline with a modal behind it, so it is capped
        //     here like anything else — and, being top-level, marked
        //     `truncated`, which is what points the modal at the fetch.
        //   - A NESTED result is capped, but NOT marked `truncated`. Its row is
        //     not committed until the next top-level boundary, so a fetch
        //     marker here would promise a body the endpoint would 404 on.
        //   - A NESTED final report (a subagent's subagent) gets neither: the
        //     two rules above disagree, and shipping it whole is the only
        //     option that loses nothing. Capping it is what the modal made
        //     acceptable for a top-level report, and the modal's fetch reads
        //     the persisted row — which for a nested result does not exist yet.
        //     So live, there is nothing to recover the tail from. It is bounded
        //     on the next history load instead, where the row IS committed and
        //     the server slices it properly.
        //   - Everything else is capped AND marked, because a top-level result
        //     is committed in the same tick as its emit, so the fetch resolves.
        //
        // Marking without fetchability and clipping without marking are both
        // wrong; which of the two a result gets depends on where its row is.
        const toolName = toolNameForResult(session.messages, block.tool_use_id as string);
        const isNested = typeof (event as { parentToolUseId?: string }).parentToolUseId === "string";
        const shipsWhole = shipsResultBodyWhole(toolName)
          || (isNested && !!toolName && SUBAGENT_REPORT_TOOL_NAMES.has(toolName));

        let capped: { totalLines: number } | undefined;
        if (!shipsWhole && content.length > CLIENT_CONTENT_CAP) {
          const totalLines = content.split("\n").length;
          // Structure-preserving first: a content-block array is capped through
          // its text so it stays parseable JSON and its image survives. Only a
          // body that is NOT one falls back to the raw clip.
          const blocks = capContentBlocks(content, CLIENT_CONTENT_CAP);
          if (blocks) {
            content = blocks.content;
            // The markers mean "this body was shortened, fetch the rest". An
            // image-only result loses nothing here, so claiming otherwise would
            // send the modal after a multi-megabyte body it already has.
            // The count comes from the blocks' own text — see `capContentBlocks`.
            if (blocks.textRemoved) capped = { totalLines: blocks.totalLines };
          } else {
            capped = { totalLines };
            content = content.slice(0, safeCutAt(content, CLIENT_CONTENT_CAP));
          }
        }
        const cappedAndFetchable = capped && !isNested;
        results.push({
          toolUseId: block.tool_use_id as string,
          content,
          isError: (block.is_error as boolean) ?? false,
          // docs/185 — per-tool duration the orchestrator stamped onto the
          // tool_result block before forwarding. Powers the detail-modal timing.
          ...(typeof block.duration_ms === "number" ? { durationMs: block.duration_ms } : {}),
          // docs/244 — the orchestrator sliced this body; carry the markers so
          // the "Show all N lines" label is honest and expanding fetches the
          // tail from the persisted row.
          ...(block.shipit_truncated === true || cappedAndFetchable ? { truncated: true as const } : {}),
          ...(typeof block.shipit_total_lines === "number"
            ? { totalLines: block.shipit_total_lines }
            : cappedAndFetchable
              ? { totalLines: capped!.totalLines }
              : {}),
          // Only the server sets `totalBytes` — it measures UTF-8 bytes, and the
          // client cap counts UTF-16 units, so filling it in here would report a
          // different quantity under the same name. `totalLines` is what the
          // "Show all N lines" label reads; nothing renders `totalBytes`.
          ...(typeof block.shipit_total_bytes === "number" ? { totalBytes: block.shipit_total_bytes } : {}),
        });
      }
    }

    // Subagent tool_result — attach to the parent message's
    // `subagentEvents` instead of `toolResults` so it shows up under the
    // SubagentCall's "work" timeline (109 — subagent transparency).
    const parentToolUseId = (event as { parentToolUseId?: string }).parentToolUseId;
    if (parentToolUseId && results.length > 0) {
      session.setMessages((prev) => attachSubagentToolResult(prev, parentToolUseId, results));
    } else if (results.length > 0) {
      session.setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant") {
          const existingResults = last.toolResults ?? [];
          return [
            ...prev.slice(0, -1),
            { ...last, toolResults: [...existingResults, ...results] },
          ];
        }
        return prev;
      });
    }
  }

  if (event.type === "agent_result") {
    session.setIsLoading(false);
    session.setActivity(undefined);
    session.setMessages((prev) =>
      prev.map((m) => {
        const closeStreaming = m.role === "assistant" && m.streaming;
        // Mirror the server: `agent_result` runs `finalizeInProgress`, which
        // drops the `in_progress` flag from every row of the turn. The client
        // must drop it too. `inProgress` is set by `loadSessionHistory` and by
        // `turn_snapshot`, and until now nothing ever cleared it — so rows of a
        // turn the viewer happened to be attached to kept the marking for the
        // rest of the session's life. A LATER `turn_snapshot` (any attach
        // during a subsequent turn) applies
        // `prev.filter((m) => !m.inProgress)`, which then deletes those
        // finished turns from the transcript along with the running one it
        // means to replace. Clearing here bounds the replace-filter to the turn
        // that is actually in flight.
        if (!closeStreaming && !m.inProgress) return m;
        return { ...m, ...(closeStreaming ? { streaming: false } : {}), inProgress: false };
      })
    );
  }
};

// ---------------------------------------------------------------------------
// Subagent event helpers (109 — subagent transparency)
// ---------------------------------------------------------------------------

/**
 * Append a subagent assistant event (text + tool calls) to the
 * `subagentEvents` of whichever message in `messages` contains the parent
 * Task tool. Falls back to no-op if the parent isn't found (e.g. the parent
 * was evicted from history). Returns a new messages array.
 */
function attachSubagentAssistant(
  messages: ChatMessage[],
  parentToolUseId: string,
  text: string,
  toolUse: { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }[],
): ChatMessage[] {
  const idx = findMessageIndexWithTool(messages, parentToolUseId);
  if (idx === -1) return messages;
  const parent = messages[idx];
  const next = [...messages];
  next[idx] = {
    ...parent,
    subagentEvents: [
      ...(parent.subagentEvents ?? []),
      { kind: "assistant", parentToolUseId, text, toolUse },
    ],
  };
  return next;
}

/**
 * Append a subagent tool_result event to the `subagentEvents` of whichever
 * message in `messages` contains the parent Task tool.
 */
function attachSubagentToolResult(
  messages: ChatMessage[],
  parentToolUseId: string,
  toolResults: ToolResultBlock[],
): ChatMessage[] {
  const idx = findMessageIndexWithTool(messages, parentToolUseId);
  if (idx === -1) return messages;
  const parent = messages[idx];
  const next = [...messages];
  next[idx] = {
    ...parent,
    subagentEvents: [
      ...(parent.subagentEvents ?? []),
      { kind: "tool_result", parentToolUseId, toolResults },
    ],
  };
  return next;
}

/**
 * Find the index of the message whose `toolUse` (or any subagent's nested
 * tool_use) contains the given id. Searches newest-first since subagent
 * events typically reference recent activity. Returns -1 if not found.
 */
function findMessageIndexWithTool(messages: ChatMessage[], toolUseId: string): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.toolUse?.some((t) => t.id === toolUseId)) return i;
    for (const ev of m.subagentEvents ?? []) {
      if (ev.kind === "assistant" && ev.toolUse.some((t) => t.id === toolUseId)) return i;
    }
  }
  return -1;
}
