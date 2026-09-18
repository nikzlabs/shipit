import type { WsAgentEvent, AgentContentBlock } from "../../../server/shared/types.js";
import type { ChatMessage, ToolResultBlock } from "../../components/MessageList.js";
import { activityFromTool } from "../../components/StreamingIndicator.js";
import { isTerminalTranscriptEntry } from "../../components/visual-elements.js";
import { shipsResultBodyWhole, SUBAGENT_REPORT_TOOL_NAMES } from "../../../server/shared/transcript-slice-tools.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const CLIENT_CONTENT_CAP = 1_000_000;

/**
 * Largest index ≤ `max` that does not split a UTF-16 surrogate pair, so a
 * clipped body never ends in a lone surrogate (which renders as `�`).
 */
function safeCutAt(text: string, max: number): number {
  const code = text.charCodeAt(max - 1);

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

function indexOfToolUse(messages: ChatMessage[], toolUseId: string): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].toolUse?.some((t) => t.id === toolUseId)) return i;
  }
  return -1;
}

function fallbackResultTarget(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (isTerminalTranscriptEntry(msg)) continue;
    return msg.role === "assistant" ? i : -1;
  }
  return -1;
}

function toolNameForResult(messages: ChatMessage[], toolUseId: string): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const top = msg.toolUse?.find((t) => t.id === toolUseId);
    if (top) return top.name;

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

  if (!session.historyLoaded) return;

  const event = data.event;

  if (event.type === "agent_assistant") {

    const textBlocks = (event.content ?? [])
      .filter((b: AgentContentBlock): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n\n");

    const toolUseBlocks = (event.content ?? [])

      .filter((b: AgentContentBlock): b is {
        type: "tool_use";
        id: string;
        name: string;
        input: Record<string, unknown>;
        bodyTruncated?: true;
        diffStats?: { added: number; removed: number };
        startedAt?: string;
      } => b.type === "tool_use");

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

        // system notice is a terminal transcript entry, never a streaming-text

        const lastIsTerminal = !!last && isTerminalTranscriptEntry(last);
        const canMerge = last?.role === "assistant" && last.streaming && !lastIsTerminal
          && !(last.toolResults && last.toolResults.length > 0);

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

        // projection leaves inline — and what to do differs per class, because

        //     precisely because the transcript renders it whole with no expand

        //   - Everything else is capped AND marked, because a top-level result

        const toolName = toolNameForResult(session.messages, block.tool_use_id as string);
        const isNested = typeof (event as { parentToolUseId?: string }).parentToolUseId === "string";
        const shipsWhole = shipsResultBodyWhole(toolName)
          || (isNested && !!toolName && SUBAGENT_REPORT_TOOL_NAMES.has(toolName));

        let capped: { totalLines: number } | undefined;
        if (!shipsWhole && content.length > CLIENT_CONTENT_CAP) {
          const totalLines = content.split("\n").length;

          const blocks = capContentBlocks(content, CLIENT_CONTENT_CAP);
          if (blocks) {
            content = blocks.content;

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

          ...(typeof block.duration_ms === "number" ? { durationMs: block.duration_ms } : {}),

          ...(block.shipit_truncated === true || cappedAndFetchable ? { truncated: true as const } : {}),
          ...(typeof block.shipit_total_lines === "number"
            ? { totalLines: block.shipit_total_lines }
            : cappedAndFetchable
              ? { totalLines: capped!.totalLines }
              : {}),

          ...(typeof block.shipit_total_bytes === "number" ? { totalBytes: block.shipit_total_bytes } : {}),
        });
      }
    }

    const parentToolUseId = (event as { parentToolUseId?: string }).parentToolUseId;
    if (parentToolUseId && results.length > 0) {
      session.setMessages((prev) => attachSubagentToolResult(prev, parentToolUseId, results));
    } else if (results.length > 0) {
      session.setMessages((prev) => {

        const byIndex = new Map<number, ToolResultBlock[]>();
        let fallback: number | undefined;
        for (const r of results) {
          let idx = indexOfToolUse(prev, r.toolUseId);
          if (idx < 0) idx = fallback ??= fallbackResultTarget(prev);
          if (idx < 0) continue;
          const bucket = byIndex.get(idx);
          if (bucket) bucket.push(r);
          else byIndex.set(idx, [r]);
        }
        if (byIndex.size === 0) return prev;
        return prev.map((m, i) => {
          const add = byIndex.get(i);
          return add ? { ...m, toolResults: [...(m.toolResults ?? []), ...add] } : m;
        });
      });
    }
  }

  if (event.type === "agent_result") {
    session.setIsLoading(false);
    session.setActivity(undefined);
    session.setMessages((prev) =>
      prev.map((m) => {
        const closeStreaming = m.role === "assistant" && m.streaming;

        // must drop it too. `inProgress` is set by `loadSessionHistory` and by

        if (!closeStreaming && !m.inProgress) return m;
        return { ...m, ...(closeStreaming ? { streaming: false } : {}), inProgress: false };
      })
    );
  }
};

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
