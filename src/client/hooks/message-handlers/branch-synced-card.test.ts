import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { handleBranchSyncedCard } from "./branch-synced-card.js";
import type { HandlerContext } from "./types.js";
import type { WsBranchSyncedCard } from "../../../server/shared/types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

const event = (over: Partial<WsBranchSyncedCard["card"]> = {}): WsBranchSyncedCard => ({
  type: "branch_synced_card",
  sessionId: "s1",
  card: {
    cardId: "sync-1",
    base: "main",
    headFromSha: "1111111000000000000000000000000000000aaa",
    headToSha: "2222222000000000000000000000000000000bbb",
    baseFromSha: "3333333000000000000000000000000000000ccc",
    baseToSha: "4444444000000000000000000000000000000ddd",
    forcePushed: true,
    createdAt: "2026-06-23T11:34:00.000Z",
    ...over,
  },
});

beforeEach(() => {
  useSessionStore.setState({ messages: [] });
});

describe("handleBranchSyncedCard (docs/221)", () => {
  it("appends a marker message carrying the full immutable payload", () => {
    handleBranchSyncedCard(ctx, event());
    const messages = useSessionStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      text: "",
      branchSynced: { cardId: "sync-1", base: "main", forcePushed: true },
    });
  });

  it("is idempotent by cardId — a reconnect replay appends once", () => {
    handleBranchSyncedCard(ctx, event());
    handleBranchSyncedCard(ctx, event()); // same cardId (history load + buffer replay)
    expect(useSessionStore.getState().messages).toHaveLength(1);
  });

  it("does not duplicate when the marker already came from persisted history", () => {
    useSessionStore.setState({
      messages: [{ role: "assistant", text: "", branchSynced: event().card }],
    });
    handleBranchSyncedCard(ctx, event());
    expect(useSessionStore.getState().messages).toHaveLength(1);
  });

  it("appends distinct cards with different ids", () => {
    handleBranchSyncedCard(ctx, event({ cardId: "sync-1" }));
    handleBranchSyncedCard(ctx, event({ cardId: "sync-2" }));
    expect(useSessionStore.getState().messages).toHaveLength(2);
  });
});
