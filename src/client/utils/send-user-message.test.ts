import { describe, it, expect, beforeEach } from "vitest";
import { sendUserMessage } from "./send-user-message.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUiStore } from "../stores/ui-store.js";
import type { ChatMessage } from "../components/MessageList.js";

/**
 * Repro for the bug where a session sometimes did not immediately drop its
 * sidebar "needs attention" marker when the user sent a turn. The marker
 * derives purely from `activeRunnerSessions.has(sessionId)` (see
 * useAttentionInfo), which the server only populates after the
 * `session_agent_started` SSE round-trip. Between hitting send and that echo,
 * the session still read as "Waiting for your input". `sendUserMessage` now
 * optimistically adds the active session so the marker clears instantly.
 */
describe("sendUserMessage — optimistic active-runner marking", () => {
  const bubble: ChatMessage = { role: "user", text: "hello" };

  beforeEach(() => {
    useSessionStore.getState().reset();
    // activeRunnerSessions lives outside initialResettableState, so reset()
    // leaves it untouched — clear it explicitly for test isolation.
    useSessionStore.setState({ activeRunnerSessions: new Set<string>() });
  });

  it("adds the active session to activeRunnerSessions immediately", () => {
    useSessionStore.setState({ sessionId: "sess-1" });

    sendUserMessage({ bubble, activity: "Thinking...", dispatch: () => true });

    expect(useSessionStore.getState().activeRunnerSessions.has("sess-1")).toBe(true);
    // The other optimistic signals still fire.
    expect(useSessionStore.getState().isLoading).toBe(true);
    expect(useSessionStore.getState().activity?.label).toBe("Thinking...");
  });

  it("marks the session as running before dispatch puts the frame on the wire", () => {
    useSessionStore.setState({ sessionId: "sess-1" });
    let runningAtDispatch = false;
    const dispatch = () => {
      runningAtDispatch = useSessionStore.getState().activeRunnerSessions.has("sess-1");
      return true;
    };

    sendUserMessage({ bubble, activity: "Thinking...", dispatch });

    expect(runningAtDispatch).toBe(true);
  });

  it("does not add an entry when there is no active session (e.g. /new path)", () => {
    useSessionStore.setState({ sessionId: undefined });

    sendUserMessage({ bubble, activity: "Thinking...", dispatch: () => true });

    expect(useSessionStore.getState().activeRunnerSessions.size).toBe(0);
  });

  it("is idempotent — re-sending does not churn the set identity", () => {
    useSessionStore.setState({ sessionId: "sess-1" });
    sendUserMessage({ bubble, activity: "Thinking...", dispatch: () => true });
    const first = useSessionStore.getState().activeRunnerSessions;

    sendUserMessage({ bubble, activity: "Thinking...", dispatch: () => true });
    const second = useSessionStore.getState().activeRunnerSessions;

    expect(second).toBe(first);
    expect(second.has("sess-1")).toBe(true);
  });
});

/**
 * A `dispatch` that reports `false` means the frame never left the browser —
 * `useWebSocket.send` drops silently on a non-OPEN socket. The optimistic state
 * must be rolled back rather than left as a permanent bubble + spinner, and the
 * caller must learn about it so it can't render a "Submitted" ack (the
 * action-checklist card bug).
 */
describe("sendUserMessage — undelivered send rolls back", () => {
  const bubble: ChatMessage = { role: "user", text: "hello" };

  beforeEach(() => {
    useSessionStore.getState().reset();
    useSessionStore.setState({ activeRunnerSessions: new Set<string>() });
    useUiStore.setState({ toast: null });
  });

  it("returns true and keeps the optimistic state when the frame reached the wire", () => {
    useSessionStore.setState({ sessionId: "sess-1" });

    const ok = sendUserMessage({ bubble, activity: "Thinking...", dispatch: () => true });

    expect(ok).toBe(true);
    expect(useSessionStore.getState().messages).toHaveLength(1);
    expect(useSessionStore.getState().isLoading).toBe(true);
    expect(useUiStore.getState().toast).toBeNull();
  });

  it("returns false and removes the bubble, spinner and runner mark when the send is dropped", () => {
    useSessionStore.setState({ sessionId: "sess-1" });

    const ok = sendUserMessage({ bubble, activity: "Thinking...", dispatch: () => false });

    expect(ok).toBe(false);
    expect(useSessionStore.getState().messages).toHaveLength(0);
    expect(useSessionStore.getState().isLoading).toBe(false);
    expect(useSessionStore.getState().activity).toBeUndefined();
    expect(useSessionStore.getState().activeRunnerSessions.has("sess-1")).toBe(false);
  });

  it("tells the user instead of failing silently", () => {
    useSessionStore.setState({ sessionId: "sess-1" });

    sendUserMessage({ bubble, activity: "Thinking...", dispatch: () => false });

    expect(useUiStore.getState().toast?.message).toMatch(/wasn't sent/i);
  });

  it("only rolls back the bubble it added, leaving earlier messages alone", () => {
    const earlier: ChatMessage = { role: "user", text: "earlier" };
    useSessionStore.setState({ sessionId: "sess-1", messages: [earlier] });

    sendUserMessage({ bubble, activity: "Thinking...", dispatch: () => false });

    expect(useSessionStore.getState().messages).toEqual([earlier]);
  });

  it("restores a genuinely-running turn's spinner rather than forcing it off", () => {
    // The user typed a follow-up while a turn was already in flight; a dropped
    // send must not make the running turn look finished.
    useSessionStore.setState({
      sessionId: "sess-1",
      isLoading: true,
      activity: { label: "Reviewing..." },
      activeRunnerSessions: new Set(["sess-1"]),
    });

    sendUserMessage({ bubble, activity: "Thinking...", dispatch: () => false });

    expect(useSessionStore.getState().isLoading).toBe(true);
    expect(useSessionStore.getState().activity?.label).toBe("Reviewing...");
    // The mark predates this send, so the rollback must leave it in place.
    expect(useSessionStore.getState().activeRunnerSessions.has("sess-1")).toBe(true);
  });
});
