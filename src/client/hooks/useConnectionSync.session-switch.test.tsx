import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { useSessionWebSocket } from "./useSessionWebSocket.js";
import { useConnectionSync } from "./useConnectionSync.js";
import { useMessageHandler } from "./useMessageHandler.js";
import { useSessionStore } from "../stores/session-store.js";
import { resumeSessionInternal } from "../stores/actions/session-actions.js";

/**
 * Reachability guard for the session-switch entry into the transcript hole:
 * switch away mid-turn, switch back, and part of the running turn is gone
 * until a reload.
 *
 * `historyLoaded` is the ordering guard that makes the attach-time
 * `turn_snapshot` land ON TOP of the `GET /history` baseline rather than under
 * it (`useMessageHandler` queues the snapshot only while the flag is false).
 * `useConnectionSync` clears the flag on a `closed`/`connecting` status
 * transition, which covers a switch that starts from an open socket — so it is
 * tempting to conclude `resumeSessionInternal` needn't clear it as well.
 *
 * It must. This test drives the one sequence where the status transition never
 * happens: a switch that starts while the socket is ALREADY connecting, so
 * `setStatus("connecting")` is a no-op and the effect never re-runs. Reached by
 * an ordinary reconnect whose in-flight history load resolves late (raising the
 * flag while connecting) — the same late-resolving load `historyLoadSeq`
 * exists for. Without the reset in `resumeSessionInternal` the snapshot applies
 * immediately and the history response then overwrites it.
 */

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send = vi.fn();
  close() { this.readyState = FakeWebSocket.CLOSED; }

  simulateOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

/** Resolvers for the deferred `GET /history` responses, in issue order. */
let historyResolvers: ((payload: unknown) => void)[] = [];

/** The three hooks App composes for a session's transport, in App's order. */
function useConnectionStack(sessionId: string) {
  const ws = useSessionWebSocket(sessionId);
  useConnectionSync({ status: ws.status, send: ws.send });
  const terminalRef = useRef(null);
  useMessageHandler({
    lastMessage: ws.lastMessage,
    drainMessages: ws.drainMessages,
    send: ws.send as never,
    terminalRef,
  });
  return ws;
}

/** A running turn's persisted rows: in-progress, so a snapshot replaces them. */
function historyPayload(texts: string[]) {
  return {
    messages: texts.map((text) => ({ role: "assistant", text, inProgress: true })),
    commits: [],
    fileTree: [],
    agentRunning: true,
  };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  historyResolvers = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url.includes("/history")) {
      return Promise.resolve({
        ok: true,
        json: () => new Promise((resolve) => historyResolvers.push(resolve)),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ sessions: [], repos: [], agents: [] }) });
  }));
  useSessionStore.getState().reset();
  useSessionStore.setState({ sessions: [] });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("session switch that skips the connecting status transition", () => {
  it("keeps the incoming session's attach snapshot instead of its stale history baseline", async () => {
    useSessionStore.getState().setSessionId("A");
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useConnectionStack(id),
      { initialProps: { id: "A" } },
    );

    // A's socket opens; its history load goes out and stays in flight.
    await act(async () => { FakeWebSocket.instances[0].simulateOpen(); });
    await waitFor(() => expect(historyResolvers).toHaveLength(1));

    // A reconnect (the Reconnect button, or the foreground force-reconnect)
    // while that load is in flight: open -> connecting.
    await act(async () => { result.current.reconnect(); });
    expect(result.current.status).toBe("connecting");
    expect(useSessionStore.getState().historyLoaded).toBe(false);

    // The load lands late and raises the flag while the socket is connecting.
    await act(async () => { historyResolvers[0](historyPayload(["A baseline"])); });
    expect(useSessionStore.getState().historyLoaded).toBe(true);

    // Now switch to B. The new URL rebuilds the socket, but `setStatus` is
    // handed the value it already holds, so `useConnectionSync` never re-runs.
    await act(async () => {
      resumeSessionInternal("B");
      rerender({ id: "B" });
    });
    expect(result.current.status).toBe("connecting");
    expect(useSessionStore.getState().historyLoaded).toBe(false);

    // B's socket attaches mid-turn: snapshot on the wire first, history after.
    const socketB = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    await act(async () => { socketB.simulateOpen(); });
    await waitFor(() => expect(historyResolvers).toHaveLength(2));
    await act(async () => {
      socketB.simulateMessage({
        type: "turn_snapshot",
        sessionId: "B",
        messages: [{ role: "assistant", text: "B live tail" }],
      });
    });
    await act(async () => { historyResolvers[1](historyPayload(["B stale baseline"])); });

    // The snapshot is authoritative for the running turn: the baseline's
    // in-progress rows are replaced, not the other way round.
    await waitFor(() => {
      expect(useSessionStore.getState().messages.map((m) => m.text)).toEqual(["B live tail"]);
    });
  });
});
