/**
 * planning#691 — a queued message that leaves the queue. Each case runs where its defect
 * shows: a session switch for the scope, two viewers for the bubble, two messages with the
 * same text for the identity.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { WsServerMessage } from "../../../server/shared/types.js";
import type { ChatMessage } from "../../components/MessageList.js";
import { useSessionStore } from "../../stores/session-store.js";
import { dispatchMessage } from "./index.js";
import type { HandlerContext } from "./types.js";

const ctx = (): HandlerContext => ({ terminalRef: { current: null }, queuedMessageStash: new Map() });

const IMAGE_SRC = [{ mediaType: "image/png", src: "/api/sessions/A/images/abc" }];
const COMPOSED_IMAGE = [{ mediaType: "image/png", data: "base64" }];

beforeEach(() => {
  useSessionStore.getState().reset();
  useSessionStore.setState({ sessionId: "A", messages: [], queuedMessages: [] });
});

/** Runs the same server events on a viewer and returns what its transcript shows. */
function onViewer(start: ChatMessage[], events: WsServerMessage[]): ChatMessage[] {
  useSessionStore.setState({ sessionId: "A", messages: start, queuedMessages: [] });
  const c = ctx();
  for (const event of events) dispatchMessage(c, event);
  return useSessionStore.getState().messages;
}

const userBubbles = (messages: ChatMessage[]) =>
  messages.filter((m) => m.role === "user").map((m) => ({
    id: m.clientRequestId,
    text: m.text,
    images: m.images?.length ?? 0,
    files: m.files?.length ?? 0,
  }));

describe("an event of another session (point 1)", () => {
  it("changes neither the queue strip nor the transcript of the open session", () => {
    useSessionStore.setState({
      sessionId: "B",
      messages: [{ role: "user", text: "B's message", clientRequestId: "b0" }],
      queuedMessages: [{ id: "b1", text: "B waits", position: 1 }],
    });
    const before = useSessionStore.getState();
    const c = ctx();

    dispatchMessage(c, { type: "message_queued", sessionId: "A", id: "a1", text: "A waits", position: 1 });
    dispatchMessage(c, {
      type: "queue_updated", sessionId: "A", queue: [], dequeued: { id: "a1", text: "A waits" },
    });
    dispatchMessage(c, { type: "agent_interrupted", sessionId: "A" });

    const after = useSessionStore.getState();
    expect(after.messages).toBe(before.messages);
    expect(after.queuedMessages).toBe(before.queuedMessages);
  });

  it("is applied when it is the open session's own", () => {
    useSessionStore.setState({ sessionId: "B", queuedMessages: [{ id: "b1", text: "B waits", position: 1 }] });
    dispatchMessage(ctx(), {
      type: "queue_updated", sessionId: "B", queue: [], dequeued: { id: "b1", text: "B waits" },
    });
    expect(useSessionStore.getState().queuedMessages).toEqual([]);
    expect(useSessionStore.getState().messages).toEqual([{ role: "user", text: "B waits", clientRequestId: "b1" }]);
  });
});

describe("a Stop (docs/330-stop-returns-queued-messages)", () => {
  it("hands the returned messages of the open session to its composer", () => {
    useSessionStore.setState({ queuedMessages: [{ id: "a1", text: "A waits", position: 1 }] });

    dispatchMessage(ctx(), {
      type: "queue_updated", sessionId: "A", queue: [], returned: [{ id: "a1", text: "A waits" }],
    });

    expect(useSessionStore.getState().queuedMessages).toEqual([]);
    expect(useSessionStore.getState().returnedToComposer).toEqual({
      sessionId: "A",
      messages: [{ id: "a1", text: "A waits" }],
    });
    expect(useSessionStore.getState().messages).toEqual([]);
  });

  it("does not hand the returned messages of another session to the open one", () => {
    useSessionStore.setState({ sessionId: "B" });

    dispatchMessage(ctx(), {
      type: "queue_updated", sessionId: "A", queue: [], returned: [{ id: "a1", text: "A waits" }],
    });

    expect(useSessionStore.getState().returnedToComposer).toBeUndefined();
  });

  // The server says what the queue holds; a row that the user sent after the Stop stays.
  it("leaves the queue rows to the server's own update", () => {
    useSessionStore.setState({ queuedMessages: [{ text: "sent after the Stop", position: 1, requestId: "r2" }] });

    dispatchMessage(ctx(), { type: "agent_interrupted", sessionId: "A" });

    expect(useSessionStore.getState().queuedMessages).toEqual([
      { text: "sent after the Stop", position: 1, requestId: "r2" },
    ]);
    expect(useSessionStore.getState().isLoading).toBe(false);
  });
});

describe("every viewer shows the same bubble, with attachments (point 2)", () => {
  const sender: ChatMessage[] = [{ role: "user", text: "look", clientRequestId: "r1", images: COMPOSED_IMAGE }];

  it("for a message that a waiting delivery steers into the turn", () => {
    const events: WsServerMessage[] = [
      { type: "message_queued", sessionId: "A", id: "r1", text: "look", position: 1 },
      { type: "queue_updated", sessionId: "A", queue: [] },
      { type: "message_steered", sessionId: "A", clientRequestId: "r1", text: "look", images: IMAGE_SRC },
    ];

    const onSender = onViewer(sender, events);
    const onSecond = onViewer([], events);

    expect(onSecond).toEqual(onSender);
    expect(userBubbles(onSecond)).toEqual([{ id: "r1", text: "look", images: 1, files: 0 }]);
  });

  it("for a message that the queue's drain starts as a turn", () => {
    const events: WsServerMessage[] = [
      { type: "message_queued", sessionId: "A", id: "r1", text: "look", position: 1 },
      { type: "queue_updated", sessionId: "A", queue: [], dequeued: { id: "r1", text: "look" } },
      { type: "system_user_message", sessionId: "A", clientRequestId: "r1", text: "look", images: IMAGE_SRC },
    ];

    const onSender = onViewer(sender, events);
    const onSecond = onViewer([], events);

    expect(userBubbles(onSecond)).toEqual(userBubbles(onSender));
    expect(userBubbles(onSecond)).toEqual([{ id: "r1", text: "look", images: 1, files: 0 }]);
    // The sender's bubble stays the one it composed.
    expect(onSender[0]?.images).toEqual(COMPOSED_IMAGE);
  });

  it("draws it once when a reconnect replays the events over a transcript that has it", () => {
    const events: WsServerMessage[] = [
      { type: "queue_updated", sessionId: "A", queue: [], dequeued: { id: "r1", text: "look" } },
      { type: "message_steered", sessionId: "A", clientRequestId: "r2", text: "more" },
    ];
    const loaded: ChatMessage[] = [
      { role: "user", text: "look", clientRequestId: "r1", images: IMAGE_SRC },
      { role: "user", text: "more", clientRequestId: "r2" },
    ];

    expect(userBubbles(onViewer(loaded, events)).map((b) => b.id)).toEqual(["r1", "r2"]);
  });
});

describe("two messages with the same text stay two bubbles (point 2)", () => {
  it("on a viewer that did not send the second one", () => {
    const earlier: ChatMessage[] = [{ role: "user", text: "continue", clientRequestId: "r0" }];
    const transcript = onViewer(earlier, [
      { type: "message_queued", sessionId: "A", id: "r1", text: "continue", position: 1 },
      { type: "queue_updated", sessionId: "A", queue: [], dequeued: { id: "r1", text: "continue" } },
      { type: "system_user_message", sessionId: "A", clientRequestId: "r1", text: "continue", images: IMAGE_SRC },
    ]);

    expect(userBubbles(transcript)).toEqual([
      { id: "r0", text: "continue", images: 0, files: 0 },
      { id: "r1", text: "continue", images: 1, files: 0 },
    ]);
  });

  it("when one of them is steered while the other is in the transcript", () => {
    const earlier: ChatMessage[] = [
      { role: "user", text: "continue", clientRequestId: "r0" },
      { role: "assistant", text: "working" },
    ];
    const transcript = onViewer(earlier, [
      { type: "message_steered", sessionId: "A", clientRequestId: "r1", text: "continue" },
    ]);

    expect(userBubbles(transcript).map((b) => b.id)).toEqual(["r0", "r1"]);
  });
});

describe("a refused steer keeps the user's order (point 3)", () => {
  it("goes back to the row the server names, in front of a later message", () => {
    useSessionStore.setState({
      sessionId: "A",
      messages: [{ role: "user", text: "A", clientRequestId: "a" }],
      queuedMessages: [{ id: "b", text: "B", position: 1 }],
    });
    const c = ctx();

    dispatchMessage(c, { type: "message_queued", sessionId: "A", id: "a", text: "A", position: 1 });

    expect(useSessionStore.getState().queuedMessages).toEqual([
      { id: "a", text: "A", position: 1 },
      { id: "b", text: "B", position: 2 },
    ]);
    expect(useSessionStore.getState().messages).toEqual([]);
    expect(c.queuedMessageStash.get("a")).toMatchObject({ text: "A" });
  });
});
