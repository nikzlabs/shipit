import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useMessageHandler } from "./useMessageHandler.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { resumeSessionInternal } from "../stores/actions/session-actions.js";
import type { WsServerMessage } from "../../server/shared/types.js";
import type { ChatMessage } from "../components/MessageList.js";
import { usePlaybackStore } from "../voice/playback-store.js";
import { armAutoplay, __resetVoiceNotesStateForTest } from "../voice/voice-notes.js";

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
      sessionId: "session-1",
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

  it("queues a user-message echo until HTTP history has loaded", async () => {

    // bubble is wiped by the load that follows — the same "my message never

    const event: WsServerMessage = {
      type: "system_user_message",
      sessionId: "session-1",
      text: "sent from my phone",
      clientRequestId: "req-phone",
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
      useSessionStore.getState().setMessages([{ role: "user", text: "earlier turn" }]);
      useSessionStore.getState().setHistoryLoaded(true);
    });

    await waitFor(() => {
      expect(useSessionStore.getState().messages).toMatchObject([
        { role: "user", text: "earlier turn" },
        { role: "user", text: "sent from my phone", clientRequestId: "req-phone" },
      ]);
    });
  });

  // planning#691 — the steer of a reconnecting viewer is applied on top of the history.
  it("queues a steer until HTTP history has loaded, and keeps its attachment", async () => {
    const images = [{ mediaType: "image/png", src: "/img/abc" }];
    const event: WsServerMessage = {
      type: "message_steered", sessionId: "session-1", clientRequestId: "r1", text: "look", images,
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

    act(() => {
      useSessionStore.getState().setMessages([{ role: "user", text: "earlier turn" }]);
      useSessionStore.getState().setHistoryLoaded(true);
    });

    await waitFor(() => {
      expect(useSessionStore.getState().messages).toEqual([
        { role: "user", text: "earlier turn" },
        { role: "user", text: "look", clientRequestId: "r1", images, steered: true },
      ]);
    });
  });

  it("drops a queued echo whose row the history load already carried", async () => {

    const event: WsServerMessage = {
      type: "system_user_message",
      sessionId: "session-1",
      text: "sent from my phone",
      clientRequestId: "req-phone",
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

    act(() => {
      useSessionStore.getState().setMessages([
        { role: "user", text: "sent from my phone", clientRequestId: "req-phone" },
      ]);
      useSessionStore.getState().setHistoryLoaded(true);
    });

    await waitFor(() => {
      expect(useSessionStore.getState().messages).toHaveLength(1);
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

    act(() => {
      queued.push(messageEvent(snapshot));
      rerender({ last: queued[0] });
    });
    expect(useSessionStore.getState().messages).toEqual([]);

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

  /**
   * Two `shipit settings propose` calls in one Bash command, the first landing
   * while a reconnect's history load is in flight. Applied at once, the first
   * card was erased by the history install and again by the attach snapshot,
   * which was taken before it existed; only the second card showed.
   */
  it.each([
    ["read before the card was saved", false],
    ["already carrying the card as an in-progress row", true],
  ])("keeps a card that arrives during the history load, beside the next card (history %s)", async (_label, historyHasCard) => {
    const card = (cardId: string, item: string) => ({
      type: "settings_proposal_card" as const,
      sessionId: "session-1",
      card: {
        cardId,
        target: { key: "roles[].harness", item },
        label: "Harness",
        description: "The agent CLI the role runs.",
        path: "Settings › Roles",
        from: "claude",
        to: "opencode2",
        phase: "pending" as const,
        createdAt: "2026-11-10T09:31:12.502Z",
      },
    }) as WsServerMessage;
    const bash = {
      role: "assistant" as const,
      text: "",
      toolUse: [{ type: "tool_use" as const, id: "bash-1", name: "Bash", input: { command: "shipit settings propose …" } }],
    };
    const queued: MessageEvent[] = [];
    const drainMessages = vi.fn(() => queued.splice(0));
    const { rerender } = renderHook(
      ({ last }: { last: MessageEvent | null }) =>
        useMessageHandler({ lastMessage: last, drainMessages, send: vi.fn(), terminalRef: { current: null } }),
      { initialProps: { last: null as MessageEvent | null } },
    );
    const deliver = (msg: WsServerMessage) => {
      act(() => {
        queued.push(messageEvent(msg));
        rerender({ last: queued[queued.length - 1] });
      });
    };

    useSessionStore.getState().setMessages([{ role: "user", text: "switch both roles" }]);
    deliver({ type: "turn_snapshot", sessionId: "session-1", messages: [bash] } as WsServerMessage);
    deliver(card("set-a", "AstraOpenCode"));

    act(() => {
      useSessionStore.getState().setMessages([
        { role: "user", text: "switch both roles" },
        { ...bash, inProgress: true },
        ...(historyHasCard
          ? [{ role: "assistant" as const, text: "", inProgress: true, settingsProposal: (card("set-a", "AstraOpenCode") as { card: NonNullable<ChatMessage["settingsProposal"]> }).card }]
          : []),
      ]);
      useSessionStore.getState().setHistoryLoaded(true);
    });
    deliver(card("set-b", "DeepSeek Flash Max"));

    await waitFor(() => {
      expect(useSessionStore.getState().messages.map((m) => m.settingsProposal?.target.item ?? m.text))
        .toEqual(["switch both roles", "", "AstraOpenCode", "DeepSeek Flash Max"]);
    });
  });

  it("syncs the session permission mode when the agent enters plan mode itself", async () => {
    const event: WsServerMessage = {
      type: "agent_event",
      sessionId: "session-1",
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

  /** Delivers each message as the socket would, while the history load is still in flight. */
  function renderDuringHistoryLoad() {
    const queued: MessageEvent[] = [];
    const { rerender } = renderHook(
      ({ last }: { last: MessageEvent | null }) =>
        useMessageHandler({ lastMessage: last, drainMessages: () => queued.splice(0), send: vi.fn(), terminalRef: { current: null } }),
      { initialProps: { last: null as MessageEvent | null } },
    );
    return (msg: WsServerMessage) => {
      act(() => {
        queued.push(messageEvent(msg));
        rerender({ last: queued[queued.length - 1] });
      });
    };
  }

  it("plays a voice note that arrives during the history load once, though the load already holds it", async () => {
    __resetVoiceNotesStateForTest();
    useSettingsStore.setState({ voiceHandsFree: true });
    armAutoplay();
    const play = vi.fn(async () => undefined);
    usePlaybackStore.setState({ play });
    const note = { id: "voice-1", headline: "Which harness?", kind: "ask" as const, createdAt: "t" };

    renderDuringHistoryLoad()({ type: "voice_note", sessionId: "session-1", ...note });
    expect(play).toHaveBeenCalledTimes(1);

    act(() => {
      useSessionStore.getState().setMessages([{ role: "assistant", text: "", voiceNote: note }]);
      useSessionStore.getState().setHistoryLoaded(true);
    });

    await waitFor(() => expect(useSessionStore.getState().messages).toHaveLength(1));
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("applies an update that follows its card during the history load, after the card", async () => {
    const card = {
      cardId: "set-a",
      target: { key: "roles[].harness", item: "AstraOpenCode" },
      label: "Harness",
      description: "d",
      path: "Settings › Roles",
      from: "claude",
      to: "opencode2",
      phase: "pending" as const,
      createdAt: "t",
    };
    const deliver = renderDuringHistoryLoad();
    deliver({ type: "settings_proposal_card", sessionId: "session-1", card });
    deliver({ type: "settings_proposal_update", sessionId: "session-1", cardId: "set-a", card: { ...card, phase: "dismissed" } });

    act(() => {
      useSessionStore.getState().setMessages([]);
      useSessionStore.getState().setHistoryLoaded(true);
    });

    await waitFor(() => {
      expect(useSessionStore.getState().messages.map((m) => m.settingsProposal?.phase)).toEqual(["dismissed"]);
    });
  });

  const proposal = (phase: NonNullable<ChatMessage["settingsProposal"]>["phase"]) => ({
    cardId: "set-a",
    target: { key: "roles[].harness", item: "AstraOpenCode" },
    label: "Harness",
    description: "d",
    path: "Settings › Roles",
    from: "claude",
    to: "opencode2",
    phase,
    createdAt: "t",
  });
  const update = (phase: NonNullable<ChatMessage["settingsProposal"]>["phase"]): WsServerMessage => ({
    type: "settings_proposal_update", sessionId: "session-1", cardId: "set-a", card: proposal(phase),
  });
  const phases = () => useSessionStore.getState().messages.map((m) => m.settingsProposal?.phase);

  it("keeps an update made during the history load over a history read before it", async () => {
    useSessionStore.getState().setMessages([{ role: "assistant", text: "", settingsProposal: proposal("pending") }]);
    renderDuringHistoryLoad()(update("dismissed"));

    act(() => {
      useSessionStore.getState().setMessages([{ role: "assistant", text: "", settingsProposal: proposal("pending") }]);
      useSessionStore.getState().setHistoryLoaded(true);
    });

    await waitFor(() => expect(phases()).toEqual(["dismissed"]));
  });

  it("keeps an update made during the history load over the older attach snapshot", async () => {
    const row = (phase: NonNullable<ChatMessage["settingsProposal"]>["phase"]) =>
      ({ role: "assistant" as const, text: "", settingsProposal: proposal(phase) });
    const deliver = renderDuringHistoryLoad();
    deliver({ type: "turn_snapshot", sessionId: "session-1", messages: [row("pending")] } as WsServerMessage);
    deliver(update("dismissed"));

    act(() => {
      useSessionStore.getState().setMessages([{ ...row("dismissed"), inProgress: true }]);
      useSessionStore.getState().setHistoryLoaded(true);
    });

    await waitFor(() => expect(phases()).toEqual(["dismissed"]));
  });

  it("ends a replayed run of updates at the newest state the history load holds", async () => {
    const deliver = renderDuringHistoryLoad();
    deliver(update("applying"));
    deliver(update("applied"));

    act(() => {
      useSessionStore.getState().setMessages([{ role: "assistant", text: "", settingsProposal: proposal("applied") }]);
      useSessionStore.getState().setHistoryLoaded(true);
    });

    await waitFor(() => expect(phases()).toEqual(["applied"]));
  });

  it("drops a fork breadcrumb for another session", () => {
    const message = { role: "assistant" as const, text: "", forkChild: { childSessionId: "child-1", title: "Fork", branch: "b" } };
    useSessionStore.getState().setHistoryLoaded(true);
    renderDuringHistoryLoad()({ type: "fork_breadcrumb", parentSessionId: "session-other", message });

    expect(useSessionStore.getState().messages).toEqual([]);
  });

  it("keeps a fork breadcrumb that arrives during the history load, once", async () => {
    const message = { role: "assistant" as const, text: "", forkChild: { childSessionId: "child-1", title: "Fork", branch: "b" } };
    const deliver = renderDuringHistoryLoad();
    deliver({ type: "fork_breadcrumb", parentSessionId: "session-1", message });
    deliver({ type: "fork_breadcrumb", parentSessionId: "session-1", message });

    act(() => {
      useSessionStore.getState().setMessages([{ role: "user", text: "fork here" }]);
      useSessionStore.getState().setHistoryLoaded(true);
    });

    await waitFor(() => {
      expect(useSessionStore.getState().messages.map((m) => m.forkChild?.childSessionId ?? m.text)).toEqual(["fork here", "child-1"]);
    });
  });
});
