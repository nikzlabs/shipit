import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useMessageHandler } from "./useMessageHandler.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { resumeSessionInternal } from "../stores/actions/session-actions.js";
import type { WsServerMessage } from "../../server/shared/types.js";

function messageEvent(data: WsServerMessage): MessageEvent {
  return { data: JSON.stringify(data) } as MessageEvent;
}

describe("useMessageHandler", () => {
  beforeEach(() => {
    const session = useSessionStore.getState();
    session.reset();
    session.setSessionId("session-1");
    session.setMessages([]);
    session.setHistoryLoaded(false);
    useSettingsStore.setState({ permissionMode: "auto", permissionModeBySession: {} });
  });

  it("queues agent events until HTTP history has loaded", async () => {
    const event: WsServerMessage = {
      type: "agent_event",
      event: {
        type: "agent_assistant",
        content: [{ type: "text", text: "streamed while reconnecting" }],
      },
    };
    const queued = [messageEvent(event)];
    const drainMessages = vi.fn(() => queued.splice(0));

    renderHook(() =>
      useMessageHandler({
        lastMessage: messageEvent(event),
        drainMessages,
        send: vi.fn(),
        terminalRef: { current: null },
      })
    );

    expect(useSessionStore.getState().messages).toEqual([]);

    act(() => {
      useSessionStore.getState().setHistoryLoaded(true);
    });

    await waitFor(() => {
      expect(useSessionStore.getState().messages).toMatchObject([
        {
          role: "assistant",
          text: "streamed while reconnecting",
          streaming: true,
        },
      ]);
    });
  });

  it("queues a replayed sub-agent spawn until HTTP history has loaded", async () => {
    const event: WsServerMessage = {
      type: "sub_agent_spawn",
      sessionId: "session-1",
      spawnId: "spawn-1",
      subAgentId: "codex",
    };
    const queued = [messageEvent(event)];

    renderHook(() =>
      useMessageHandler({
        lastMessage: messageEvent(event),
        drainMessages: vi.fn(() => queued.splice(0)),
        send: vi.fn(),
        terminalRef: { current: null },
      })
    );

    expect(useSessionStore.getState().subAgentSpawns).toEqual({});

    act(() => {
      useSessionStore.getState().setHistoryLoaded(true);
    });

    await waitFor(() => {
      expect(useSessionStore.getState().subAgentSpawns["spawn-1"]).toMatchObject({
        subAgentId: "codex",
      });
    });
  });

  /**
   * The session-switch entry into the "switched away mid-turn, switched back,
   * and the earlier messages are gone" hole. The switch clears the transcript
   * and the incoming socket's attach sends `turn_snapshot` before the
   * `GET /history` round trip resolves — so the snapshot must be QUEUED and
   * replayed on top of the baseline, not applied under it.
   *
   * Deliberately driven without any WebSocket status transition: the
   * `closed`/`connecting` reset in `useConnectionSync` covers most switches,
   * but not one that starts while the socket is already connecting, so a test
   * that rendered that intermediate status would pass even with the bug.
   */
  it("queues the attach snapshot across a session switch with no connection-status transition", async () => {
    // Mid-turn on the outgoing session: its history is loaded.
    useSessionStore.getState().setSessionId("session-1");
    useSessionStore.getState().setHistoryLoaded(true);
    useSessionStore.getState().setMessages([
      { role: "assistant", text: "outgoing session" },
    ]);

    const snapshot: WsServerMessage = {
      type: "turn_snapshot",
      sessionId: "session-2",
      messages: [{ role: "assistant", text: "live tail" }],
    } as WsServerMessage;
    const queued: MessageEvent[] = [];
    const drainMessages = vi.fn(() => queued.splice(0));

    const { rerender } = renderHook(
      ({ last }: { last: MessageEvent | null }) =>
        useMessageHandler({
          lastMessage: last,
          drainMessages,
          send: vi.fn(),
          terminalRef: { current: null },
        }),
      { initialProps: { last: null as MessageEvent | null } },
    );

    act(() => {
      resumeSessionInternal("session-2");
    });

    // The incoming socket attaches and sends the running turn's snapshot.
    act(() => {
      queued.push(messageEvent(snapshot));
      rerender({ last: queued[0] });
    });
    expect(useSessionStore.getState().messages).toEqual([]);

    // The history response lands after it, carrying only the rows the DB held
    // at the last tool-result boundary.
    act(() => {
      useSessionStore.getState().setMessages([
        { role: "assistant", text: "stale baseline", inProgress: true },
      ]);
      useSessionStore.getState().setHistoryLoaded(true);
    });

    await waitFor(() => {
      expect(useSessionStore.getState().messages.map((m) => m.text)).toEqual(["live tail"]);
    });
  });

  it("syncs the session permission mode when the agent enters plan mode itself", async () => {
    const event: WsServerMessage = {
      type: "agent_event",
      event: {
        type: "agent_assistant",
        content: [{ type: "tool_use", id: "plan-1", name: "EnterPlanMode", input: {} }],
      },
    };
    const queued = [messageEvent(event)];

    useSessionStore.getState().setHistoryLoaded(true);

    renderHook(() =>
      useMessageHandler({
        lastMessage: queued[0],
        drainMessages: vi.fn(() => queued.splice(0)),
        send: vi.fn(),
        terminalRef: { current: null },
      })
    );

    await waitFor(() => {
      expect(useSettingsStore.getState().getPermissionMode("session-1")).toBe("plan");
      expect(useSessionStore.getState().messages).toMatchObject([
        {
          role: "assistant",
          toolUse: [{ id: "plan-1", name: "EnterPlanMode" }],
          streaming: true,
        },
      ]);
    });
  });
});
