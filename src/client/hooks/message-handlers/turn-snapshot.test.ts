import { describe, it, expect, beforeEach } from "vitest";
import { handleTurnSnapshot } from "./turn-snapshot.js";
import { handleAgentEvent } from "./agent-event.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { HandlerContext } from "./types.js";
import type { ChatMessage } from "../../components/MessageList.js";

const ctx = {} as HandlerContext;

const snapshot = (messages: { role: "user" | "assistant"; text: string }[]) => ({
  type: "turn_snapshot" as const,
  sessionId: "s1",
  messages: messages.map((m) => ({ ...m, inProgress: true })),
});

const texts = () => useSessionStore.getState().messages.map((m) => m.text);

beforeEach(() => {
  useSessionStore.setState({ sessionId: "s1", messages: [], historyLoaded: true });
});

describe("turn_snapshot handler", () => {
  it("replaces the in-progress rows a history load left behind", () => {
    // What `loadSessionHistory` produced: a finalized turn plus the running
    // turn's `in_progress` rows, which are stale by one persist boundary.
    useSessionStore.setState({
      messages: [
        { role: "user", text: "earlier question" },
        { role: "assistant", text: "earlier answer" },
        { role: "user", text: "Do the thing" },
        { role: "assistant", text: "GROUP-ONE", inProgress: true, streaming: true },
      ] as ChatMessage[],
    });

    handleTurnSnapshot(ctx, snapshot([
      { role: "assistant", text: "GROUP-ONE" },
      { role: "assistant", text: "GROUP-TWO" },
    ]));

    // The finalized turn and the turn-opening user message survive; the stale
    // in-progress tail is replaced rather than appended to (no duplicate
    // GROUP-ONE), and the slice the old two-source rebuild dropped is back.
    expect(texts()).toEqual([
      "earlier question",
      "earlier answer",
      "Do the thing",
      "GROUP-ONE",
      "GROUP-TWO",
    ]);
  });

  it("corrects a history baseline that ran AHEAD of the snapshot", () => {
    // The other ordering: the history read landed after a persist the attach
    // didn't see. The snapshot rolls the transcript back to the attach instant;
    // the live events that followed it on the wire replay the difference.
    useSessionStore.setState({
      messages: [
        { role: "user", text: "Do the thing" },
        { role: "assistant", text: "GROUP-ONE", inProgress: true },
        { role: "assistant", text: "GROUP-TWO", inProgress: true, streaming: true },
      ] as ChatMessage[],
    });

    handleTurnSnapshot(ctx, snapshot([{ role: "assistant", text: "GROUP-ONE" }]));
    expect(texts()).toEqual(["Do the thing", "GROUP-ONE"]);

    handleAgentEvent(ctx, {
      type: "agent_event",
      event: { type: "agent_assistant", content: [{ type: "text", text: "GROUP-TWO" }] },
    } as never);
    expect(texts()).toEqual(["Do the thing", "GROUP-ONEGROUP-TWO"]);
  });

  it("marks only the last row as streaming so earlier groups stop spinning", () => {
    handleTurnSnapshot(ctx, snapshot([
      { role: "assistant", text: "GROUP-ONE" },
      { role: "assistant", text: "GROUP-TWO" },
    ]));

    const messages = useSessionStore.getState().messages;
    expect(messages.map((m) => !!m.streaming)).toEqual([false, true]);
    expect(messages.every((m) => m.inProgress)).toBe(true);
  });

  it("clears a stale in-progress tail when the snapshot is empty", () => {
    useSessionStore.setState({
      messages: [
        { role: "user", text: "Do the thing" },
        { role: "assistant", text: "stale", inProgress: true },
      ] as ChatMessage[],
    });

    handleTurnSnapshot(ctx, snapshot([]));

    expect(texts()).toEqual(["Do the thing"]);
  });
});
