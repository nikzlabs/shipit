import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useMessageHandler } from "./useMessageHandler.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { useSessionStore } from "../stores/session-store.js";
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
