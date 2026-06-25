import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { handleBranchAutoResetCard } from "./branch-auto-reset-card.js";
import type { HandlerContext } from "./types.js";
import type { WsBranchAutoResetCard } from "../../../server/shared/types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

const event = (over: Partial<WsBranchAutoResetCard["card"]> = {}): WsBranchAutoResetCard => ({
  type: "branch_auto_reset_card",
  sessionId: "s1",
  card: {
    cardId: "bar-1",
    base: "main",
    prNumber: 482,
    prUrl: "https://github.com/o/r/pull/482",
    fromSha: "a1f3c9d0000000000000000000000000000000aa",
    toSha: "7e02b480000000000000000000000000000000bb",
    createdAt: "2026-06-15T11:34:00.000Z",
    ...over,
  },
});

beforeEach(() => {
  useSessionStore.setState({ messages: [] });
});

describe("handleBranchAutoResetCard (docs/218)", () => {
  it("appends a marker message carrying the full immutable payload", () => {
    handleBranchAutoResetCard(ctx, event());
    const messages = useSessionStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      text: "",
      branchAutoReset: { cardId: "bar-1", base: "main", prNumber: 482 },
    });
  });

  it("is idempotent by cardId — a reconnect replay appends once", () => {
    handleBranchAutoResetCard(ctx, event());
    handleBranchAutoResetCard(ctx, event()); // same cardId (history load + buffer replay)
    expect(useSessionStore.getState().messages).toHaveLength(1);
  });

  it("does not duplicate when the marker already came from persisted history", () => {
    useSessionStore.setState({
      messages: [{ role: "assistant", text: "", branchAutoReset: event().card }],
    });
    handleBranchAutoResetCard(ctx, event());
    expect(useSessionStore.getState().messages).toHaveLength(1);
  });

  it("appends distinct cards with different ids", () => {
    handleBranchAutoResetCard(ctx, event({ cardId: "bar-1" }));
    handleBranchAutoResetCard(ctx, event({ cardId: "bar-2" }));
    expect(useSessionStore.getState().messages).toHaveLength(2);
  });
});
