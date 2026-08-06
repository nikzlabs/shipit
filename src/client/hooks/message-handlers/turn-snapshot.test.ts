import { describe, it, expect, beforeEach } from "vitest";
import { handleTurnSnapshot } from "./turn-snapshot.js";
import { handleAgentEvent } from "./agent-event.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { HandlerContext } from "./types.js";
import type { ChatMessage } from "../../components/MessageList.js";

const ctx = {} as HandlerContext;

const snapshot = (
  messages: { role: "user" | "assistant"; text: string; notice?: boolean; noticeLevel?: "info" | "warn"; noticeId?: string }[],
) => ({
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

  it("never marks a trailing notice row streaming, so live text can't fold into it", () => {
    // The production window: `emitNoticeInTurn` fires at env-prep, after
    // `resetRunnerTurnState`, so a viewer attaching before the agent's first
    // token gets a snapshot consisting of exactly one row — the notice. A notice
    // is complete when emitted and never written to incrementally, so it must
    // not come back open, however far along it sits in the snapshot.
    handleTurnSnapshot(ctx, snapshot([
      { role: "assistant", text: "Claude2 reached your usage cutoff — continuing this session on Claude1.", notice: true, noticeLevel: "warn", noticeId: "failover-1" },
    ]));

    const [notice] = useSessionStore.getState().messages;
    expect(notice.notice).toBe(true);
    expect(!!notice.streaming).toBe(false);
    expect(notice.inProgress).toBe(true);

    // End to end against the real merge path: the agent's first text opens its
    // own bubble instead of being concatenated onto the notice panel.
    handleAgentEvent(ctx, {
      type: "agent_event",
      event: { type: "agent_assistant", content: [{ type: "text", text: "I agree — 5b is the right one." }] },
    } as never);

    expect(texts()).toEqual([
      "Claude2 reached your usage cutoff — continuing this session on Claude1.",
      "I agree — 5b is the right one.",
    ]);
    expect(useSessionStore.getState().messages[0].noticeLevel).toBe("warn");
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

/**
 * The reported regression: reactivate the browser window and part of the
 * transcript vanishes, but a page reload brings it back.
 *
 * `inProgress` is the replace-filter's scope marker, and only two paths ever
 * set it — a history load of a running turn, and this snapshot. Nothing used to
 * clear it, so once a viewer had been attached mid-turn those rows carried the
 * marking for the rest of the session. Any later attach (a foreground
 * reconnect is one) sends a snapshot of whatever turn is running NOW, and its
 * `prev.filter((m) => !m.inProgress)` deleted the older, finished turns along
 * with the running one it means to replace. The DB was fine, so a reload
 * repaired it — matching the report exactly.
 */
describe("turn_snapshot — the replace-filter is scoped to the running turn", () => {
  it("does not delete a finished turn whose rows came from a history load", () => {
    // Turn 1, hydrated from `GET /history` while it was still running: its rows
    // arrive marked in-progress.
    useSessionStore.setState({
      messages: [
        { role: "user", text: "first question" },
        { role: "assistant", text: "FIRST-ANSWER", inProgress: true, streaming: true },
      ] as ChatMessage[],
    });

    // Turn 1 ends. The server drops `in_progress` from these rows in the DB
    // (`finalizeInProgress`); the client must drop it too.
    handleAgentEvent(ctx, {
      type: "agent_event",
      event: { type: "agent_result" },
    } as never);
    expect(useSessionStore.getState().messages.some((m) => m.inProgress)).toBe(false);

    // Turn 2 starts and the user reactivates the window: the reattach snapshot
    // covers turn 2 only.
    useSessionStore.setState({
      messages: [
        ...useSessionStore.getState().messages,
        { role: "user", text: "second question" } as ChatMessage,
      ],
    });
    handleTurnSnapshot(ctx, snapshot([{ role: "assistant", text: "SECOND-ANSWER" }]));

    expect(texts()).toEqual([
      "first question",
      "FIRST-ANSWER",
      "second question",
      "SECOND-ANSWER",
    ]);
  });

  it("still replaces the running turn's rows after an earlier turn finished", () => {
    useSessionStore.setState({
      messages: [
        { role: "assistant", text: "FIRST-ANSWER", inProgress: true, streaming: true },
      ] as ChatMessage[],
    });
    handleAgentEvent(ctx, { type: "agent_event", event: { type: "agent_result" } } as never);

    // Turn 2's own stale in-progress rows (a history load of the running turn)
    // are still the snapshot's business to replace.
    useSessionStore.setState({
      messages: [
        ...useSessionStore.getState().messages,
        { role: "assistant", text: "SECOND-ANSWER", inProgress: true, streaming: true } as ChatMessage,
      ],
    });
    handleTurnSnapshot(ctx, snapshot([
      { role: "assistant", text: "SECOND-ANSWER" },
      { role: "assistant", text: "SECOND-ANSWER-CONTINUED" },
    ]));

    expect(texts()).toEqual([
      "FIRST-ANSWER",
      "SECOND-ANSWER",
      "SECOND-ANSWER-CONTINUED",
    ]);
  });
});
