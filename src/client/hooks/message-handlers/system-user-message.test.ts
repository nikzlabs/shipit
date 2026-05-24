import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { handleSystemUserMessage } from "./system-user-message.js";
import type { HandlerContext } from "./types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

beforeEach(() => {
  useSessionStore.setState({ messages: [] });
});

describe("handleSystemUserMessage (docs/150 dedupe)", () => {
  it("appends when no optimistic bubble matches (server-only dispatch path)", () => {
    handleSystemUserMessage(ctx, {
      type: "system_user_message",
      text: "Auto-fixing CI…",
      activity: "Auto-fixing CI...",
    });
    const messages = useSessionStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "user", text: "Auto-fixing CI…" });
    expect(messages[0].pendingDispatch).toBeUndefined();
  });

  it("dedupes against the tail pendingDispatch bubble (HTTP-dispatch path)", () => {
    // Simulate the optimistic append from `dispatchAgentMessage`.
    useSessionStore.setState({
      messages: [{ role: "user", text: "Create the PR", pendingDispatch: true }],
    });
    handleSystemUserMessage(ctx, {
      type: "system_user_message",
      text: "Create the PR",
      activity: "Creating PR…",
    });
    const messages = useSessionStore.getState().messages;
    // No duplicate appended; the pendingDispatch flag is cleared in place.
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "user", text: "Create the PR" });
    expect(messages[0].pendingDispatch).toBeUndefined();
  });

  it("does NOT dedupe when the tail bubble's text differs (distinct dispatch)", () => {
    useSessionStore.setState({
      messages: [{ role: "user", text: "Create the PR", pendingDispatch: true }],
    });
    handleSystemUserMessage(ctx, {
      type: "system_user_message",
      text: "Auto-fixing CI…",
    });
    const messages = useSessionStore.getState().messages;
    expect(messages).toHaveLength(2);
    // The first message keeps its pendingDispatch flag until its own echo arrives.
    expect(messages[0].pendingDispatch).toBe(true);
    expect(messages[1]).toMatchObject({ role: "user", text: "Auto-fixing CI…" });
  });

  it("does NOT dedupe a regular optimistic bubble without pendingDispatch", () => {
    // WS `send_message` optimistic bubbles do NOT carry pendingDispatch; their
    // dedupe path is `message_queued` (when queued) and the chat-history
    // replay (when not queued). The dispatch dedupe must not steal those.
    useSessionStore.setState({
      messages: [{ role: "user", text: "Manual user input" }],
    });
    handleSystemUserMessage(ctx, {
      type: "system_user_message",
      text: "Manual user input",
    });
    const messages = useSessionStore.getState().messages;
    expect(messages).toHaveLength(2);
  });
});
