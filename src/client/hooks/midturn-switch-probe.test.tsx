import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { useSessionWebSocket } from "./useSessionWebSocket.js";
import { useConnectionSync } from "./useConnectionSync.js";
import { useMessageHandler } from "./useMessageHandler.js";
import { useSessionStore } from "../stores/session-store.js";
import { resumeSessionInternal } from "../stores/actions/session-actions.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

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
  constructor(url: string) { this.url = url; FakeWebSocket.instances.push(this); }
  send = vi.fn();
  close() { this.readyState = FakeWebSocket.CLOSED; }
  simulateOpen() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  simulateMessage(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
}

/** Per-session fake history payloads keyed by session id. */
const histories: Record<string, Any> = {};

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("fetch", vi.fn(async (input: Any) => {
    const url = String(input);
    const m = /\/api\/sessions\/([^/]+)\/history/.exec(url);
    if (m) {
      return { ok: true, json: async () => histories[m[1]] ?? { messages: [], commits: [], fileTree: [] } } as Any;
    }
    if (url.includes("/api/bootstrap")) {
      return { ok: true, json: async () => ({
        sessions: [], repos: [], agents: [], templates: [],
        githubStatus: { authenticated: false },
        settings: { gitIdentity: { name: "t", email: "t@t" }, systemPrompt: "" },
      }) } as Any;
    }
    if (url.includes("preview-status")) {
      return { ok: true, json: async () => ({ known: false }) } as Any;
    }
    return { ok: true, json: async () => ({}) } as Any;
  }));
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  useSessionStore.setState({ sessionId: undefined, messages: [], historyLoaded: false, isLoading: false, sessions: [] });
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function useHarness(sessionId: string | undefined) {
  const ws = useSessionWebSocket(sessionId);
  const terminalRef = useRef(null);
  useConnectionSync({ status: ws.status, send: ws.send });
  useMessageHandler({
    lastMessage: ws.lastMessage,
    drainMessages: ws.drainMessages,
    send: ws.send,
    terminalRef,
  });
  return ws;
}

const latest = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

describe("PROBE: client mid-turn session switch", () => {
  it("keeps the in-progress turn's earlier messages after switching away and back", async () => {
    // Session A is mid-turn: user msg + one persisted in-progress assistant group.
    histories.A = {
      messages: [
        { role: "user", text: "Do the thing" },
        { role: "assistant", text: "FIRST chunk", toolUse: [{ id: "t1", name: "Read", input: {} }], toolResults: [{ toolUseId: "t1", content: "bytes" }], inProgress: true },
      ],
      commits: [], fileTree: [], agentRunning: true,
    };
    histories.B = { messages: [{ role: "user", text: "other session" }], commits: [], fileTree: [] };

    useSessionStore.setState({ sessionId: "A" });
    const { rerender } = renderHook(({ sid }) => useHarness(sid), { initialProps: { sid: "A" as string | undefined } });

    await act(async () => { latest().simulateOpen(); });
    await waitFor(() => expect(useSessionStore.getState().historyLoaded).toBe(true));

    // Live event arrives mid-turn.
    await act(async () => {
      latest().simulateMessage({
        type: "agent_event",
        sessionId: "A",
        event: { type: "agent_assistant", content: [{ type: "text", text: "SECOND chunk" }] },
      });
    });
    const before = useSessionStore.getState().messages;
    expect(before.map((m) => m.text)).toEqual(["Do the thing", "FIRST chunk", "SECOND chunk"]);

    // ---- switch to B ----
    act(() => { resumeSessionInternal("B"); });
    rerender({ sid: "B" });
    await act(async () => { latest().simulateOpen(); });
    await waitFor(() => expect(useSessionStore.getState().historyLoaded).toBe(true));

    // ---- switch back to A (server replays the post-persist tail) ----
    // Server-side history is now what the DB had at last persist boundary.
    act(() => { resumeSessionInternal("A"); });
    rerender({ sid: "A" });
    const wsA = latest();
    await act(async () => { wsA.simulateOpen(); });
    // Buffer replay of the un-persisted tail lands right after open.
    await act(async () => {
      wsA.simulateMessage({
        type: "agent_event",
        sessionId: "A",
        event: { type: "agent_assistant", content: [{ type: "text", text: "SECOND chunk" }] },
      });
    });
    await waitFor(() => expect(useSessionStore.getState().historyLoaded).toBe(true));
    await act(async () => { await Promise.resolve(); });

    const after = useSessionStore.getState().messages;
    // eslint-disable-next-line no-console
    console.log("AFTER SWITCH BACK:", JSON.stringify(after.map((m) => ({ role: m.role, text: m.text, streaming: m.streaming })), null, 2));
    expect(after.map((m) => m.text)).toEqual(["Do the thing", "FIRST chunk", "SECOND chunk"]);
  });
});
