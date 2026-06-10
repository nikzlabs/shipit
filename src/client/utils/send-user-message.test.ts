import { describe, it, expect, beforeEach } from "vitest";
import { sendUserMessage } from "./send-user-message.js";
import { useSessionStore } from "../stores/session-store.js";
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

    sendUserMessage({ bubble, activity: "Thinking...", dispatch: () => {} });

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
    };

    sendUserMessage({ bubble, activity: "Thinking...", dispatch });

    expect(runningAtDispatch).toBe(true);
  });

  it("does not add an entry when there is no active session (e.g. /new path)", () => {
    useSessionStore.setState({ sessionId: undefined });

    sendUserMessage({ bubble, activity: "Thinking...", dispatch: () => {} });

    expect(useSessionStore.getState().activeRunnerSessions.size).toBe(0);
  });

  it("is idempotent — re-sending does not churn the set identity", () => {
    useSessionStore.setState({ sessionId: "sess-1" });
    sendUserMessage({ bubble, activity: "Thinking...", dispatch: () => {} });
    const first = useSessionStore.getState().activeRunnerSessions;

    sendUserMessage({ bubble, activity: "Thinking...", dispatch: () => {} });
    const second = useSessionStore.getState().activeRunnerSessions;

    expect(second).toBe(first);
    expect(second.has("sess-1")).toBe(true);
  });
});
