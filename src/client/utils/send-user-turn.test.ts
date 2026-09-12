import { describe, it, expect, beforeEach, vi } from "vitest";
import { usePrStore } from "../stores/pr-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { saveMergeContinueOptOut, getSavedMergeContinueOptOut } from "./local-storage.js";
import { sendGoalControlFrame, sendUserTurn } from "./send-user-turn.js";

const untick = (sessionId: string) => {
  usePrStore.getState().setMergeContinueOptOut(sessionId, "compact", true);
  usePrStore.getState().setMergeContinueOptOut(sessionId, "reset", true);
};

beforeEach(() => {
  usePrStore.setState({ mergeContinueOptOutBySession: {} });
  useSessionStore.setState({ sessionId: "s1", messages: [], isLoading: false });
  localStorage.clear();
});

/**
 * The defect these guard is the second shape of the same bug. Routing every
 * producer through a shared *builder* made the action-card path carry the
 * untick — and then never spend it, so one untick governed every later message.
 * Reading the intent and consuming it have to be one act.
 */
describe("sendUserTurn (docs/218 + docs/295)", () => {
  it("carries the untick and spends it, so it applies to that one message (req 5)", () => {
    untick("s1");
    const frames: Record<string, unknown>[] = [];
    const send = (frame: Record<string, unknown>) => {
      frames.push(frame);
      return true;
    };
    const turn = () =>
      sendUserTurn({
        sessionId: "s1",
        frame: { text: "go", sessionId: "s1" },
        bubble: { role: "user", text: "go" },
        activity: "Thinking...",
        dispatch: send,
      });

    expect(turn()).toBe(true);
    expect(frames[0]).toMatchObject({ compactContext: false, resetMergedBranch: false });

    // The message it was made for has gone. The next one is not governed by it.
    expect(turn()).toBe(true);
    expect(frames[1]).not.toHaveProperty("compactContext");
    expect(frames[1]).not.toHaveProperty("resetMergedBranch");
  });

  it("keeps the untick when the send never reached the wire", () => {
    // A refused send leaves the user's choice where they can still see it, for
    // the retry they are about to make.
    untick("s1");
    const sent = sendUserTurn({
      sessionId: "s1",
      frame: { text: "go", sessionId: "s1" },
      bubble: { role: "user", text: "go" },
      activity: "Thinking...",
      dispatch: () => false,
    });
    expect(sent).toBe(false);
    expect(usePrStore.getState().mergeContinueOptOutBySession.s1).toMatchObject({
      compact: true, reset: true,
    });
  });

  it("clears the durable mirror too, so a reload does not resurrect a spent untick", () => {
    saveMergeContinueOptOut("s1", { compact: true });
    usePrStore.setState({ mergeContinueOptOutBySession: {} });
    sendUserTurn({
      sessionId: "s1",
      frame: { text: "go", sessionId: "s1" },
      bubble: { role: "user", text: "go" },
      activity: "Thinking...",
      dispatch: () => true,
    });
    expect(getSavedMergeContinueOptOut("s1")).toEqual({});
  });

  it("carries nothing when the user unticked nothing", () => {
    const frames: Record<string, unknown>[] = [];
    sendUserTurn({
      sessionId: "s1",
      frame: { text: "go", sessionId: "s1" },
      bubble: { role: "user", text: "go" },
      activity: "Thinking...",
      dispatch: (f) => { frames.push(f); return true; },
    });
    expect(frames[0]).not.toHaveProperty("compactContext");
    expect(frames[0]).not.toHaveProperty("resetMergedBranch");
  });

  it("builds a frame with the type and a request id", () => {
    const frames: Record<string, unknown>[] = [];
    sendUserTurn({
      sessionId: "s1",
      frame: { text: "go", sessionId: "s1" },
      bubble: { role: "user", text: "go" },
      activity: "Thinking...",
      dispatch: (f) => { frames.push(f); return true; },
    });
    expect(frames[0]).toMatchObject({ type: "send_message", text: "go" });
    expect(typeof frames[0]!.requestId).toBe("string");
  });
});

describe("sendGoalControlFrame", () => {
  it("carries no intent and spends none — it starts no turn", () => {
    untick("s1");
    const frames: Record<string, unknown>[] = [];
    sendGoalControlFrame("/goal clear", "s1", (f: Record<string, unknown>) => {
      frames.push(f);
      return true;
    });
    expect(frames[0]).toEqual({ type: "send_message", text: "/goal clear", sessionId: "s1" });
    // Untouched: the user's untick is still waiting for their next real message.
    expect(usePrStore.getState().mergeContinueOptOutBySession.s1).toMatchObject({
      compact: true, reset: true,
    });
  });

  it("does not post an optimistic bubble", () => {
    sendGoalControlFrame("/goal clear", "s1", () => true);
    expect(useSessionStore.getState().messages).toEqual([]);
    expect(useSessionStore.getState().isLoading).toBe(false);
  });
});

describe("the HTTP dispatch path carries and spends it too", () => {
  it("carries the untick for a user-clicked dispatch and spends it on success", async () => {
    const { dispatchAgentMessage } = await import("./dispatch-agent-message.js");
    untick("s1");
    const bodies: unknown[] = [];
    const apiPost = vi.fn(async (_path: string, body?: unknown) => {
      bodies.push(body);
      return { ok: true, queued: false } as never;
    });
    await dispatchAgentMessage({
      sessionId: "s1", text: "fix it", activity: "Fixing…", apiPost, userInitiated: true,
    });
    expect(bodies[0]).toMatchObject({ compactContext: false, resetMergedBranch: false });
    expect(usePrStore.getState().mergeContinueOptOutBySession.s1).toEqual({});
  });

  it("carries nothing for a dispatch the user did not make (req 13)", async () => {
    const { dispatchAgentMessage } = await import("./dispatch-agent-message.js");
    untick("s1");
    const bodies: unknown[] = [];
    const apiPost = vi.fn(async (_path: string, body?: unknown) => {
      bodies.push(body);
      return { ok: true, queued: false } as never;
    });
    // A CI auto-fix, or a click inside an agent-built page: no checkbox, so the
    // global setting alone decides — and the user's untick is left for them.
    await dispatchAgentMessage({ sessionId: "s1", text: "auto", activity: "Fixing…", apiPost });
    expect(bodies[0]).not.toHaveProperty("compactContext");
    expect(usePrStore.getState().mergeContinueOptOutBySession.s1).toMatchObject({ compact: true });
  });

  it("does not spend an untick made WHILE the request was in flight", async () => {
    const { dispatchAgentMessage } = await import("./dispatch-agent-message.js");
    // Sent with both ticked; the user unticks while the POST is pending. That
    // choice belongs to their NEXT message and the response must not eat it.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const apiPost = vi.fn(async () => { await gate; return { ok: true, queued: false } as never; });
    const inFlight = dispatchAgentMessage({
      sessionId: "s1", text: "fix it", activity: "Fixing…",
      apiPost: apiPost as never, userInitiated: true,
    });
    untick("s1");
    release();
    await inFlight;
    expect(usePrStore.getState().mergeContinueOptOutBySession.s1).toMatchObject({
      compact: true, reset: true,
    });
  });

  it("keeps the untick when the dispatch failed", async () => {
    const { dispatchAgentMessage } = await import("./dispatch-agent-message.js");
    untick("s1");
    const apiPost = vi.fn(async () => { throw new Error("nope"); });
    await expect(dispatchAgentMessage({
      sessionId: "s1", text: "fix it", activity: "Fixing…",
      apiPost: apiPost as never, userInitiated: true,
    })).rejects.toThrow();
    expect(usePrStore.getState().mergeContinueOptOutBySession.s1).toMatchObject({ compact: true });
  });
});
