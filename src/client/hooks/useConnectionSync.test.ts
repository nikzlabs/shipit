import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

// Stub out the HTTP data loaders so the hook doesn't hit the network.
vi.mock("../utils/session-data.js", () => ({
  loadBootstrapData: vi.fn().mockResolvedValue(undefined),
  loadSessionHistory: vi.fn().mockResolvedValue(undefined),
}));

import { useConnectionSync } from "./useConnectionSync.js";
import { useSessionStore } from "../stores/session-store.js";

/**
 * docs/144 fix #2 — the delivery half of the silent-message-drop fix.
 *
 * App.handleSend stashes a message as `pendingWsMessage` when the WS isn't open
 * yet (e.g. a session just claimed on /{slug}/new). useConnectionSync must flush
 * that pending message the moment the WS opens — otherwise the user's first
 * message is silently dropped.
 */
describe("useConnectionSync — pending message flush (docs/144 fix #2)", () => {
  beforeEach(() => {
    // Reset the slice of session state the hook reads.
    useSessionStore.setState({
      sessionId: undefined,
      pendingWsMessage: undefined,
      sessions: [],
    });
  });

  it("flushes pendingWsMessage with the sessionId when the WS opens", async () => {
    useSessionStore.setState({
      sessionId: "s1",
      pendingWsMessage: { type: "send_message", text: "first message" },
    });

    const send = vi.fn();
    renderHook(() => useConnectionSync({ status: "open", send }));

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledWith({
      type: "send_message",
      text: "first message",
      sessionId: "s1",
    });
    // Pending must be cleared so it isn't re-sent on a later reconnect.
    expect(useSessionStore.getState().pendingWsMessage).toBeUndefined();
  });

  it("does not send anything while the WS is still connecting", () => {
    useSessionStore.setState({
      sessionId: "s1",
      pendingWsMessage: { type: "send_message", text: "queued" },
    });

    const send = vi.fn();
    renderHook(() => useConnectionSync({ status: "connecting", send }));

    expect(send).not.toHaveBeenCalled();
    // The message stays queued for the eventual open.
    expect(useSessionStore.getState().pendingWsMessage).toEqual({
      type: "send_message",
      text: "queued",
    });
  });

  it("is a no-op on open when there is no pending message", async () => {
    useSessionStore.setState({ sessionId: "s1", pendingWsMessage: undefined });

    const send = vi.fn();
    renderHook(() => useConnectionSync({ status: "open", send }));

    // Give the history-load microtask a chance to run; still nothing to send.
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
  });
});
