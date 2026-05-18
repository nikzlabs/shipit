import type { WsAgentEvent, AgentContentBlock } from "../../../server/shared/types.js";
import type { ChatMessage, ToolResultBlock } from "../../components/MessageList.js";
import { activityFromTool } from "../../components/StreamingIndicator.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleAgentEvent: Handler<WsAgentEvent> = (ctx, data) => {
  const session = useSessionStore.getState();
  // Guard: skip agent events until HTTP history is loaded. On WS reconnect,
  // events arrive immediately while loadSessionHistory() is still in-flight.
  // Without this guard, events processed before the HTTP response get
  // overwritten (lost) or events processed after it duplicate HTTP data.
  // The DB-backed history snapshot is the baseline; live events build on top.
  if (!session.historyLoaded) return;

  const event = data.event;

  if (event.type === "agent_assistant") {
    const textBlocks = (event.content ?? [])
      .filter((b: AgentContentBlock): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");

    const toolUseBlocks = (event.content ?? [])
      .filter((b: AgentContentBlock): b is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } => b.type === "tool_use");

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

      if (toolUseBlocks.some((b) => b.name === "ExitPlanMode")) {
        ctx.notify("The agent has a plan ready for review.", ctx.buildNotifyContext());
      }
    } else if (textBlocks) {
      session.setActivity({ label: "Thinking..." });
    }

    if (!parentToolUseId && (textBlocks || toolUseBlocks.length > 0)) {
      session.setMessages((prev) => {
        const last = prev[prev.length - 1];
        const canMerge = last?.role === "assistant" && last.streaming
          && !(last.toolResults && last.toolResults.length > 0);
        // Standalone tools like ExitPlanMode and AskUserQuestion should stay
        // with the preceding assistant text even after tool results arrive.
        // Without this, the PlanApproval card renders in an empty bubble
        // disconnected from the plan text when the agent does research
        // (Read, Grep, etc.) between writing the plan and calling ExitPlanMode.
        const STANDALONE_MERGE = new Set(["ExitPlanMode", "AskUserQuestion"]);
        const isStandaloneOnly = !textBlocks && toolUseBlocks.length > 0
          && toolUseBlocks.every((t) => STANDALONE_MERGE.has(t.name));
        const forceMerge = isStandaloneOnly
          && last?.role === "assistant" && last.streaming;
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
        if (content.length > 1_000_000) {
          content = `${content.slice(0, 1_000_000)  }\n... (output truncated — exceeded 1MB)`;
        }
        results.push({
          toolUseId: block.tool_use_id as string,
          content,
          isError: (block.is_error as boolean) ?? false,
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
    ctx.notify("The agent has finished responding.", ctx.buildNotifyContext());
    session.setMessages((prev) =>
      prev.map((m) =>
        m.role === "assistant" && m.streaming ? { ...m, streaming: false } : m
      )
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
