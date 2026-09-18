import { describe, it, expect, beforeEach } from "vitest";
import { usePrStore } from "../stores/pr-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { useUiStore } from "../stores/ui-store.js";
import type { AgentOption } from "../agent-types.js";
import { handleError } from "../hooks/message-handlers/error.js";
import { handleMessageQueued } from "../hooks/message-handlers/message-queued.js";
import { handleMessageSteered } from "../hooks/message-handlers/message-steered.js";
import { handleQueueUpdated } from "../hooks/message-handlers/queue-updated.js";
import { handleSystemUserMessage } from "../hooks/message-handlers/system-user-message.js";
import type { HandlerContext } from "../hooks/message-handlers/types.js";
import { compactRunsBeforeTurn } from "./merge-continue-intent.js";
import { sendUserTurn } from "./send-user-turn.js";

const ctx = (): HandlerContext => ({
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
});

const agent = (over: Partial<AgentOption> = {}): AgentOption => ({
  id: "claude",
  name: "Claude",
  installed: true,
  hasRunnableModels: true,
  models: [],
  supportsReview: true,
  supportsCompaction: true,
  ...over,
});

/** The state in which the composer is showing a ticked "Compact the context". */
const offeringCompaction = () => {
  usePrStore.setState({ resetEligibleBySession: { s1: true }, mergeContinueOptOutBySession: {} });
  useSettingsStore.setState({ autoResetMergedBranch: true });
  useUiStore.setState({ agentList: [agent()], activeAgentId: "claude" });
};

const send = (text = "next slice", dispatch: () => boolean = () => true) =>
  sendUserTurn({
    sessionId: "s1",
    frame: { text, sessionId: "s1" },
    bubble: { role: "user", text },
    activity: "Thinking...",
    dispatch,
  });

beforeEach(() => {
  usePrStore.setState({ resetEligibleBySession: {}, mergeContinueOptOutBySession: {} });
  useSettingsStore.setState({ autoResetMergedBranch: true });
  useUiStore.setState({ agentList: [agent()], activeAgentId: "claude" });
  useSessionStore.setState({ sessionId: "s1", messages: [], queuedMessages: [], isLoading: false });
  localStorage.clear();
});

describe("compactRunsBeforeTurn", () => {
  it("is true exactly when the composer offers a ticked compaction control", () => {
    offeringCompaction();
    expect(compactRunsBeforeTurn("s1", "next slice")).toBe(true);
  });

  it("is false when the session is not reset-eligible", () => {
    offeringCompaction();
    usePrStore.setState({ resetEligibleBySession: {} });
    expect(compactRunsBeforeTurn("s1", "next slice")).toBe(false);
  });

  it("is false when the one global setting is off — neither control is offered", () => {
    offeringCompaction();
    useSettingsStore.setState({ autoResetMergedBranch: false });
    expect(compactRunsBeforeTurn("s1", "next slice")).toBe(false);
  });

  it("is false when the backend cannot compact (docs/295 req 10)", () => {
    offeringCompaction();
    useUiStore.setState({ agentList: [agent({ supportsCompaction: false })] });
    expect(compactRunsBeforeTurn("s1", "next slice")).toBe(false);
  });

  it("is false once the user unticks the control, for that one message", () => {
    offeringCompaction();
    usePrStore.getState().setMergeContinueOptOut("s1", "compact", true);
    expect(compactRunsBeforeTurn("s1", "next slice")).toBe(false);
  });

  it("is false for the commands the server skips the whole hook for", () => {
    offeringCompaction();
    expect(compactRunsBeforeTurn("s1", "/compact tighten it up")).toBe(false);
    expect(compactRunsBeforeTurn("s1", "/goal clear")).toBe(false);
  });

  it("is false while a turn runs — that send is queued or STEERED, not compacted", () => {
    // Reachable with the offer still standing: a manual `/compact` leaves the
    // session eligible, so the very next message can be sent mid-turn.
    offeringCompaction();
    useSessionStore.setState({ isLoading: true });
    expect(compactRunsBeforeTurn("s1", "next slice")).toBe(false);
  });
});

/**
 * The flicker this replaces: the message was rendered as an ordinary bubble,
 * the server spent a git read and a PR re-verification deciding, and the bubble
 * then collapsed into the queue strip. Nothing about the message had changed —
 * only what the UI knew — so the first state was never true.
 */
describe("a send that a compaction will run ahead of", () => {
  it("opens in the queue strip and never as a transcript bubble", () => {
    offeringCompaction();
    expect(send()).toBe(true);

    const state = useSessionStore.getState();
    expect(state.messages).toEqual([]);
    expect(state.queuedMessages).toMatchObject([{ text: "next slice", position: 1 }]);
    expect(state.isLoading).toBe(true);
  });

  it("still bubbles when no compaction is coming", () => {
    expect(send()).toBe(true);
    expect(useSessionStore.getState().messages).toMatchObject([{ role: "user", text: "next slice" }]);
    expect(useSessionStore.getState().queuedMessages).toEqual([]);
  });

  it("takes the row back when the frame never left the browser", () => {
    offeringCompaction();
    expect(send("next slice", () => false)).toBe(false);
    expect(useSessionStore.getState().queuedMessages).toEqual([]);
    expect(useSessionStore.getState().messages).toEqual([]);
    expect(useSessionStore.getState().isLoading).toBe(false);
  });

  it("is adopted by the server's own message_queued rather than duplicated", () => {
    offeringCompaction();
    send();
    const c = ctx();
    handleMessageQueued(c, { type: "message_queued", text: "next slice", position: 1 });

    expect(useSessionStore.getState().queuedMessages).toEqual([
      { text: "next slice", position: 1 },
    ]);
    expect(useSessionStore.getState().messages).toEqual([]);
  });

  it("restores the message the user actually composed when the queue drains", () => {
    offeringCompaction();
    sendUserTurn({
      sessionId: "s1",
      frame: { text: "look at this", sessionId: "s1" },
      bubble: { role: "user", text: "look at this", uploadPaths: ["/uploads/shot.png"] },
      activity: "Thinking...",
      dispatch: () => true,
    });
    const c = ctx();
    handleMessageQueued(c, { type: "message_queued", text: "look at this", position: 1 });
    handleQueueUpdated(c, { type: "queue_updated", queue: [], dequeued: "look at this" });

    // Without the bubble the prediction carried, the restore would invent a
    // bare `{role, text}` and the attachment would be gone from the transcript.
    expect(useSessionStore.getState().messages).toMatchObject([
      { role: "user", text: "look at this", uploadPaths: ["/uploads/shot.png"] },
    ]);
    expect(useSessionStore.getState().queuedMessages).toEqual([]);
  });

  /**
   * The server's decision has clauses the browser cannot see — a replay seed,
   * background work on the resident process, a merge that will not settle — so
   * the prediction is sometimes wrong. The echo the turn already emits is what
   * corrects it, in both directions at once.
   */
  it("is corrected by the turn's echo when the server runs the message instead", () => {
    offeringCompaction();
    send();
    const requestId = useSessionStore.getState().queuedMessages[0]?.requestId;
    expect(requestId).toBeDefined();

    handleSystemUserMessage(ctx(), {
      type: "system_user_message",
      sessionId: "s1",
      text: "next slice",
      clientRequestId: requestId!,
    });

    expect(useSessionStore.getState().queuedMessages).toEqual([]);
    expect(useSessionStore.getState().messages).toMatchObject([
      { role: "user", text: "next slice" },
    ]);
  });

  /**
   * Most refusals carry no request id — an unresolvable attachment, an absent
   * workspace, a refused agent all reach `ctx.send({ type: "error" })` with
   * nothing to correlate on. The row has to go anyway, or it sits above the
   * composer claiming a message is queued for a turn that will never run.
   */
  it("puts the message back above the error when the server refuses it", () => {
    offeringCompaction();
    send();
    handleError(ctx(), { type: "error", message: "That file does not exist" });

    expect(useSessionStore.getState().queuedMessages).toEqual([]);
    expect(useSessionStore.getState().messages).toMatchObject([
      { role: "user", text: "next slice" },
      { role: "assistant", isError: true },
    ]);
  });

  it("restores the message once when the server steers it into a running turn", () => {
    offeringCompaction();
    send();
    handleMessageSteered(ctx(), { type: "message_steered", sessionId: "s1", text: "next slice" });

    expect(useSessionStore.getState().queuedMessages).toEqual([]);
    // Restoring it first is what lets the steer handler's own dedupe recognise
    // it; without that the transcript would carry the message twice.
    expect(useSessionStore.getState().messages).toMatchObject([
      { role: "user", text: "next slice" },
    ]);
  });

  /**
   * `runCompactionAhead` emits `message_queued` before the compaction starts,
   * and the turn executor then clears the event buffer — so a tab that
   * reconnects mid-compaction gets the queue SNAPSHOT and never that message.
   * The snapshot used to replace the predicted row outright, which threw away
   * the composed bubble before it reached the stash.
   */
  it("keeps the composed message when only a queue snapshot confirms the row", () => {
    offeringCompaction();
    sendUserTurn({
      sessionId: "s1",
      frame: { text: "look at this", sessionId: "s1" },
      bubble: { role: "user", text: "look at this", uploadPaths: ["/uploads/shot.png"] },
      activity: "Thinking...",
      dispatch: () => true,
    });
    const c = ctx();
    handleQueueUpdated(c, {
      type: "queue_updated",
      queue: [{ text: "look at this", position: 1 }],
    });
    handleQueueUpdated(c, { type: "queue_updated", queue: [], dequeued: "look at this" });

    expect(useSessionStore.getState().messages).toMatchObject([
      { role: "user", text: "look at this", uploadPaths: ["/uploads/shot.png"] },
    ]);
  });

  it("survives a snapshot that predates it rather than being erased by one", () => {
    offeringCompaction();
    send();
    // The server's answer to something else — a cancel, another tab's dequeue —
    // is not evidence that this send was refused.
    handleQueueUpdated(ctx(), { type: "queue_updated", queue: [] });

    expect(useSessionStore.getState().queuedMessages).toMatchObject([{ text: "next slice" }]);
  });
});
