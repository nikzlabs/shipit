import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { handleActionChecklistCard } from "./action-checklist-card.js";
import type { HandlerContext } from "./types.js";
import type { WsActionChecklistCard } from "../../../server/shared/types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

const event = (over: Partial<WsActionChecklistCard["card"]> = {}): WsActionChecklistCard => ({
  type: "action_checklist_card",
  sessionId: "s1",
  card: {
    cardId: "ac-1",
    title: "Optional follow-ups",
    actions: [
      { id: "a1", label: "Open a PR", payload: "Open a PR for this change." },
      { id: "a2", label: "File issue", payload: "File a follow-up issue." },
    ],
    branch: "shipit/apobab",
    headSha: "abc12345",
    createdAt: "2026-06-15T11:34:00.000Z",
    ...over,
  },
});

beforeEach(() => {
  useSessionStore.setState({ messages: [] });
});

describe("handleActionChecklistCard (docs/207 / SHI-153)", () => {
  it("appends a marker message carrying the full immutable payload", () => {
    handleActionChecklistCard(ctx, event());
    const messages = useSessionStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      text: "",
      actionChecklist: { cardId: "ac-1", title: "Optional follow-ups" },
    });
    expect(messages[0].actionChecklist?.actions).toHaveLength(2);
  });

  it("is idempotent by cardId — a reconnect replay appends once", () => {
    handleActionChecklistCard(ctx, event());
    handleActionChecklistCard(ctx, event()); // same cardId (history load + buffer replay)
    expect(useSessionStore.getState().messages).toHaveLength(1);
  });

  it("does not duplicate when the marker already came from persisted history", () => {
    useSessionStore.setState({
      messages: [{ role: "assistant", text: "", actionChecklist: event().card }],
    });
    handleActionChecklistCard(ctx, event());
    expect(useSessionStore.getState().messages).toHaveLength(1);
  });

  it("appends distinct cards with different ids", () => {
    handleActionChecklistCard(ctx, event({ cardId: "ac-1" }));
    handleActionChecklistCard(ctx, event({ cardId: "ac-2" }));
    expect(useSessionStore.getState().messages).toHaveLength(2);
  });
});
