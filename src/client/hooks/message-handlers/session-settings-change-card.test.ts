import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { handleSessionSettingsChangeCard } from "./session-settings-change-card.js";
import { dispatchMessage } from "./index.js";
import type { HandlerContext } from "./types.js";
import type { WsSessionSettingsChangeCard } from "../../../server/shared/types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

const event = (
  over: Partial<WsSessionSettingsChangeCard["card"]> = {},
): WsSessionSettingsChangeCard => ({
  type: "session_settings_change_card",
  sessionId: "s1",
  card: {
    cardId: "ssc-1",
    scope: "sandbox-capabilities",
    changes: [{ label: "Docker access", from: "off", to: "on", granted: true }],
    pendingRestart: true,
    createdAt: "2026-08-21T11:34:00.000Z",
    ...over,
  },
});

beforeEach(() => {
  useSessionStore.setState({ messages: [] });
});

describe("handleSessionSettingsChangeCard (docs/279)", () => {
  it("appends a marker message carrying the full immutable payload", () => {
    handleSessionSettingsChangeCard(ctx, event());
    const messages = useSessionStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      text: "",
      sessionSettingsChange: { cardId: "ssc-1", scope: "sandbox-capabilities", pendingRestart: true },
    });
  });

  it("is idempotent by cardId — a reconnect replay appends once", () => {
    handleSessionSettingsChangeCard(ctx, event());
    handleSessionSettingsChangeCard(ctx, event());
    expect(useSessionStore.getState().messages).toHaveLength(1);
  });

  it("does not duplicate when the marker already came from persisted history", () => {
    useSessionStore.setState({
      messages: [{ role: "assistant", text: "", sessionSettingsChange: event().card }],
    });
    handleSessionSettingsChangeCard(ctx, event());
    expect(useSessionStore.getState().messages).toHaveLength(1);
  });

  it("appends distinct cards with different ids", () => {
    handleSessionSettingsChangeCard(ctx, event({ cardId: "ssc-1" }));
    handleSessionSettingsChangeCard(ctx, event({ cardId: "ssc-2", scope: "network-mode" }));
    expect(useSessionStore.getState().messages).toHaveLength(2);
  });

  it("is transcript-scoped: a card for another session never lands in this transcript", () => {
    // The browser holds exactly one transcript in memory, so an unscoped card
    // would render in whichever session happened to be active (CLAUDE.md).
    useSessionStore.setState({ sessionId: "active", messages: [] });

    dispatchMessage(ctx, { ...event({ cardId: "foreign" }), sessionId: "other" });
    expect(useSessionStore.getState().messages).toHaveLength(0);

    dispatchMessage(ctx, { ...event({ cardId: "mine" }), sessionId: "active" });
    expect(useSessionStore.getState().messages).toHaveLength(1);
  });
});
