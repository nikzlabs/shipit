import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { handleAgentEvent } from "./agent-event.js";
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
