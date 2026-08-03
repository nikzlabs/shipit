import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { handleAgentEvent, CLIENT_CONTENT_CAP } from "./agent-event.js";
import type { HandlerContext } from "./types.js";
import type { WsAgentEvent } from "../../../server/shared/types.js";
import type { ChatMessage } from "../../components/MessageList.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

const assistantEvent = (text: string, toolUse: { id: string; name: string; input: Record<string, unknown> }[] = []): WsAgentEvent => ({
  type: "agent_event",
  event: {
    type: "agent_assistant",
    content: [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...toolUse.map((t) => ({ type: "tool_use" as const, ...t })),
    ],
  },
} as unknown as WsAgentEvent);

beforeEach(() => {
  useSessionStore.setState({ messages: [], historyLoaded: true });
});

describe("handleAgentEvent — card carrier message is never a merge target (SHI-112)", () => {
  // A permission card persisted in an in-progress turn comes back from
  // loadSessionHistory with `streaming: true` (inProgress → streaming). A
  // buffered pre-card `agent_assistant` replayed on switch/reconnect must NOT
  // merge into it — the merge rebuilds the message from a fixed field set and
  // would drop `permissionPrompt`, erasing the card (it reappeared only after
  // the agent stopped). The card must survive, and the replayed event appends
  // as its own message instead.
  it("does not drop permissionPrompt when a streaming agent_assistant follows the card", () => {
    const cardMsg: ChatMessage = {
      role: "assistant",
      text: "",
      streaming: true,
      permissionPrompt: { requestId: "p1" },
    } as unknown as ChatMessage;
    useSessionStore.setState({ messages: [cardMsg] });

    handleAgentEvent(ctx, assistantEvent("running the command", [{ id: "tu-1", name: "Bash", input: { command: "cd /workspace" } }]));

    const { messages } = useSessionStore.getState();
    const card = messages.find((m) => m.permissionPrompt?.requestId === "p1");
    expect(card).toBeTruthy();
    expect(card?.permissionPrompt?.requestId).toBe("p1");
    // The replayed assistant content landed in its own message, not folded into
    // (and erasing) the card.
    expect(messages.some((m) => m.text === "running the command")).toBe(true);
  });

  it("still merges consecutive streaming assistant text on a normal (non-card) bubble", () => {
    useSessionStore.setState({ messages: [{ role: "assistant", text: "Hello", streaming: true } as ChatMessage] });
    handleAgentEvent(ctx, assistantEvent(" world"));
    const { messages } = useSessionStore.getState();
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("Hello world");
  });
});

describe("the 1 MB client cap is fetchable, not a dead end (docs/244)", () => {
  /**
   * The cap is a backstop for the classes the serve-path projection leaves
   * inline — a subagent's exempt final report, and nested subagent results
   * before their row is committed. It used to clip the body and say nothing:
   * no `truncated`, no line count, so `ToolResult` rendered a silently
   * shortened body with no expand affordance and no way to recover the rest.
   *
   * The full body is in the persisted row regardless, so the cap's job is to
   * hand the expand path the same markers the server would have set.
   */
  const resultEvent = (content: string): WsAgentEvent => ({
    type: "agent_event",
    event: {
      type: "agent_tool_result",
      content: [{ type: "tool_result", tool_use_id: "tu-big", content }],
    },
  } as unknown as WsAgentEvent);

  // Results attach to the trailing assistant message, so the calling tool_use
  // has to already be on screen — same order the real event stream produces.
  beforeEach(() => {
    handleAgentEvent(ctx, assistantEvent("", [{ id: "tu-big", name: "Task", input: { prompt: "audit" } }]));
  });

  const resultFor = (id: string) =>
    useSessionStore.getState().messages
      .flatMap((m) => m.toolResults ?? [])
      .find((r) => r.toolUseId === id);

  it("marks a capped body truncated and reports the TRUE line count", () => {
    // 1.5 M chars across 30k lines — over the cap either way you measure it.
    const line = "x".repeat(49);
    const huge = Array.from({ length: 30_000 }, () => line).join("\n");
    expect(huge.length).toBeGreaterThan(CLIENT_CONTENT_CAP);

    handleAgentEvent(ctx, resultEvent(huge));

    const result = resultFor("tu-big");
    expect(result).toBeTruthy();
    expect(result!.truncated).toBe(true);
    // The label must describe the WHOLE body, not the clipped prefix — a count
    // taken after clipping is exactly the lie this test exists to prevent.
    expect(result!.totalLines).toBe(30_000);
    expect(result!.content.length).toBeLessThanOrEqual(CLIENT_CONTENT_CAP);
    expect(huge.startsWith(result!.content)).toBe(true);
  });

  it("leaves an under-cap body completely alone", () => {
    handleAgentEvent(ctx, resultEvent("small output"));

    const result = resultFor("tu-big");
    expect(result!.content).toBe("small output");
    expect(result!.truncated).toBeUndefined();
    expect(result!.totalLines).toBeUndefined();
  });

  it("does not clip mid-surrogate", () => {
    // An emoji straddling the cut would otherwise leave a lone high surrogate,
    // which renders as a replacement character at the end of every preview.
    const huge = `${"a".repeat(CLIENT_CONTENT_CAP - 1)}😀${"b".repeat(100)}`;
    handleAgentEvent(ctx, resultEvent(huge));

    const content = resultFor("tu-big")!.content;
    const last = content.charCodeAt(content.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    expect(huge.startsWith(content)).toBe(true);
  });

  it("prefers the server's markers over the cap's when both are present", () => {
    // A server-sliced result arrives well under the cap, so the cap must not
    // fire — but if it ever did, the server's true count wins.
    const event = {
      type: "agent_event",
      event: {
        type: "agent_tool_result",
        content: [{
          type: "tool_result",
          tool_use_id: "tu-big",
          content: "head slice",
          shipit_truncated: true,
          shipit_total_lines: 4_242,
          shipit_total_bytes: 999_999,
        }],
      },
    } as unknown as WsAgentEvent;

    handleAgentEvent(ctx, event);

    const result = resultFor("tu-big")!;
    expect(result.truncated).toBe(true);
    expect(result.totalLines).toBe(4_242);
    expect(result.totalBytes).toBe(999_999);
  });
});
