import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { handleSessionRenamedCard } from "./session-renamed-card.js";
import type { HandlerContext } from "./types.js";
import type { WsSessionRenamedCard } from "../../../server/shared/types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

const event = (over: Partial<WsSessionRenamedCard["card"]> = {}): WsSessionRenamedCard => ({
  type: "session_renamed_card",
  sessionId: "s1",
  card: {
    cardId: "srn-1",
    from: "Fix the flaky test",
    to: "Harden the CI pipeline",
    createdAt: "2026-08-04T11:34:00.000Z",
    ...over,
  },
});

beforeEach(() => {
  useSessionStore.setState({ messages: [] });
});

describe("handleSessionRenamedCard (docs/250)", () => {
  it("appends a marker message carrying the full immutable payload", () => {
    handleSessionRenamedCard(ctx, event());
    const messages = useSessionStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      text: "",
      sessionRenamed: { cardId: "srn-1", from: "Fix the flaky test", to: "Harden the CI pipeline" },
    });
  });

  it("is idempotent by cardId — a reconnect replay appends once", () => {
    handleSessionRenamedCard(ctx, event());
    handleSessionRenamedCard(ctx, event()); // same cardId (history load + buffer replay)
    expect(useSessionStore.getState().messages).toHaveLength(1);
  });

  it("does not duplicate when the marker already came from persisted history", () => {
    useSessionStore.setState({
      messages: [{ role: "assistant", text: "", sessionRenamed: event().card }],
    });
    handleSessionRenamedCard(ctx, event());
    expect(useSessionStore.getState().messages).toHaveLength(1);
  });

  it("appends distinct cards — a session renamed twice keeps both records", () => {
    handleSessionRenamedCard(ctx, event({ cardId: "srn-1" }));
    handleSessionRenamedCard(ctx, event({ cardId: "srn-2", from: "Harden the CI pipeline", to: "Third name" }));
    expect(useSessionStore.getState().messages).toHaveLength(2);
  });
});
