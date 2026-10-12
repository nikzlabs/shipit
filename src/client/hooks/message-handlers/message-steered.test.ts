import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { handleMessageSteered } from "./message-steered.js";
import type { HandlerContext } from "./types.js";

const ctx = (): HandlerContext => ({
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
});

beforeEach(() => {
  useSessionStore.setState({ messages: [], queuedMessages: [] });
});

describe("handleMessageSteered (planning#691: matched by id)", () => {
  it("appends the steered message for a viewer with no bubble of it", () => {
    handleMessageSteered(ctx(), {
      type: "message_steered",
      text: "steer mid-turn",
      sessionId: "s1",
      clientRequestId: "r1",
    });
    expect(useSessionStore.getState().messages).toEqual([
      { role: "user", text: "steer mid-turn", clientRequestId: "r1" },
    ]);
  });

  it("does not draw a second bubble for the sender, whose bubble has the id", () => {
    useSessionStore.setState({
      messages: [
        { role: "user", text: "first turn", clientRequestId: "r0" },
        { role: "assistant", text: "working on it", streaming: true },
        { role: "user", text: "steer mid-turn", clientRequestId: "r1" },
      ],
    });
    handleMessageSteered(ctx(), {
      type: "message_steered",
      text: "steer mid-turn",
      sessionId: "s1",
      clientRequestId: "r1",
    });
    expect(useSessionStore.getState().messages).toHaveLength(3);
  });

  it("keeps two messages with the same text as two bubbles", () => {
    // The earlier message is the last user bubble and has the same text; the old
    // text match took it for the steer and drew nothing.
    useSessionStore.setState({
      messages: [
        { role: "user", text: "do the thing", clientRequestId: "r0" },
        { role: "assistant", text: "done", streaming: true },
      ],
    });
    handleMessageSteered(ctx(), {
      type: "message_steered",
      text: "do the thing",
      sessionId: "s1",
      clientRequestId: "r1",
    });

    const users = useSessionStore.getState().messages.filter((m) => m.role === "user");
    expect(users.map((m) => m.clientRequestId)).toEqual(["r0", "r1"]);
  });

  it("gives every viewer the attachments of the steer", () => {
    const images = [{ src: "/img/abc", mediaType: "image/png" }];
    const files = [{ path: "src/a.ts", contentPreview: "export" }];
    handleMessageSteered(ctx(), {
      type: "message_steered",
      text: "with an image",
      sessionId: "s1",
      clientRequestId: "r1",
      images,
      files,
      uploadPaths: ["/uploads/a.png"],
    });
    expect(useSessionStore.getState().messages).toEqual([{
      role: "user",
      text: "with an image",
      clientRequestId: "r1",
      images,
      files,
      uploadPaths: ["/uploads/a.png"],
    }]);
  });

  it("adds the attachments to a bubble of the same id that has the text alone", () => {
    useSessionStore.setState({ messages: [{ role: "user", text: "look", clientRequestId: "r1" }] });
    const images = [{ src: "/img/abc", mediaType: "image/png" }];
    handleMessageSteered(ctx(), {
      type: "message_steered", text: "look", sessionId: "s1", clientRequestId: "r1", images,
    });
    expect(useSessionStore.getState().messages).toEqual([
      { role: "user", text: "look", clientRequestId: "r1", images },
    ]);
  });

  it("leaves the sender's composed attachments as they were drawn", () => {
    const composed = [{ data: "base64", mediaType: "image/png" }];
    useSessionStore.setState({
      messages: [{ role: "user", text: "look", clientRequestId: "r1", images: composed }],
    });
    handleMessageSteered(ctx(), {
      type: "message_steered",
      text: "look",
      sessionId: "s1",
      clientRequestId: "r1",
      images: [{ src: "/img/abc", mediaType: "image/png" }],
    });
    expect(useSessionStore.getState().messages[0]?.images).toEqual(composed);
  });

  it("carries inter-session provenance onto the bubble of the same id", () => {
    useSessionStore.setState({ messages: [{ role: "user", text: "same text", clientRequestId: "r1" }] });
    handleMessageSteered(ctx(), {
      type: "message_steered",
      text: "same text",
      sessionId: "child",
      clientRequestId: "r1",
      messageOrigin: { sessionId: "parent", sessionTitle: "Parent", relation: "parent" },
    });

    expect(useSessionStore.getState().messages).toEqual([{
      role: "user",
      text: "same text",
      clientRequestId: "r1",
      messageOrigin: { sessionId: "parent", sessionTitle: "Parent", relation: "parent" },
    }]);
  });

  it("drops the stashed bubble of a queued message that the steer delivered", () => {
    const c = ctx();
    c.queuedMessageStash.set("r1", { role: "user", text: "queued", clientRequestId: "r1" });
    c.queuedMessageStash.set("r2", { role: "user", text: "still queued", clientRequestId: "r2" });
    handleMessageSteered(c, { type: "message_steered", text: "queued", sessionId: "s1", clientRequestId: "r1" });
    expect([...c.queuedMessageStash.keys()]).toEqual(["r2"]);
  });
});
