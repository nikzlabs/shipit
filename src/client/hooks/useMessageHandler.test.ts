import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useMessageHandler } from "./useMessageHandler.js";
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
});
