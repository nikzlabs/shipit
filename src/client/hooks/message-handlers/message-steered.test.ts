import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { handleMessageSteered } from "./message-steered.js";
import type { HandlerContext } from "./types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

beforeEach(() => {
  useSessionStore.setState({ messages: [] });
});

describe("handleMessageSteered (echo reconciliation)", () => {
  it("appends the steered message for a viewer with no optimistic insert", () => {
    handleMessageSteered(ctx, {
      type: "message_steered",
      text: "steer mid-turn",
      sessionId: "s1",
    });
    const messages = useSessionStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "user", text: "steer mid-turn" });
  });

  it("does NOT double-render when the last user message already matches the echo", () => {

    useSessionStore.setState({
      messages: [
        { role: "user", text: "first turn" },
        { role: "assistant", text: "working on it", streaming: true },
        { role: "user", text: "steer mid-turn" },
      ],
    });
    handleMessageSteered(ctx, {
      type: "message_steered",
      text: "steer mid-turn",
      sessionId: "s1",
    });
    const messages = useSessionStore.getState().messages;

    expect(messages).toHaveLength(3);
    expect(messages.filter((m) => m.role === "user" && m.text === "steer mid-turn")).toHaveLength(1);
  });

  it("matches the LAST user message, not an earlier identical one", () => {
    // An earlier user turn happens to share the steer's text; the dedupe must

    useSessionStore.setState({
      messages: [
        { role: "user", text: "do the thing" },
        { role: "assistant", text: "done", streaming: true },
      ],
    });
    handleMessageSteered(ctx, {
      type: "message_steered",
      text: "do the thing",
      sessionId: "s1",
    });

    expect(useSessionStore.getState().messages).toHaveLength(2);
  });

  it("appends when the last user message differs from the echo", () => {
    useSessionStore.setState({
      messages: [
        { role: "user", text: "original prompt" },
        { role: "assistant", text: "thinking", streaming: true },
      ],
    });
    handleMessageSteered(ctx, {
      type: "message_steered",
      text: "a different steer",
      sessionId: "s1",
    });
    const messages = useSessionStore.getState().messages;
    expect(messages).toHaveLength(3);
    expect(messages[2]).toMatchObject({ role: "user", text: "a different steer" });
  });

  it("carries attachment fields through to the appended bubble", () => {
    const images = [{ data: "abc", mediaType: "image/png" }];
    handleMessageSteered(ctx, {
      type: "message_steered",
      text: "with an image",
      sessionId: "s1",
      images,
    });
    const messages = useSessionStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "user", text: "with an image", images });
  });

  it("carries inter-session provenance and reconciles it onto a matching bubble", () => {
    useSessionStore.setState({ messages: [{ role: "user", text: "same text" }] });
    handleMessageSteered(ctx, {
      type: "message_steered",
      text: "same text",
      sessionId: "child",
      messageOrigin: { sessionId: "parent", sessionTitle: "Parent", relation: "parent" },
    });

    expect(useSessionStore.getState().messages).toEqual([{
      role: "user",
      text: "same text",
      messageOrigin: { sessionId: "parent", sessionTitle: "Parent", relation: "parent" },
    }]);
  });
});
