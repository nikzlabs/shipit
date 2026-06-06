import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { handleCompactionCard } from "./compaction-card.js";
import { handleCompactionStatus } from "./compaction-status.js";
import type { HandlerContext } from "./types.js";
import type { WsCompactionCard, WsCompactionStatus } from "../../../server/shared/types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

const card = (over: Partial<WsCompactionCard["card"]> = {}): WsCompactionCard => ({
  type: "compaction_card",
  sessionId: "s1",
  card: {
    id: "compaction-1",
    trigger: "manual",
    preTokens: 180_000,
    postTokens: 42_000,
    durationMs: 3200,
    createdAt: "2026-06-06T00:00:00.000Z",
    ...over,
  },
});

const status = (active: boolean): WsCompactionStatus => ({
  type: "compaction_status",
  sessionId: "s1",
  active,
  trigger: "manual",
});

beforeEach(() => {
  useSessionStore.setState({ messages: [], compacting: false });
});

describe("handleCompactionStatus (docs/179)", () => {
  it("flips the transient compacting flag", () => {
    handleCompactionStatus(ctx, status(true));
    expect(useSessionStore.getState().compacting).toBe(true);
    handleCompactionStatus(ctx, status(false));
    expect(useSessionStore.getState().compacting).toBe(false);
  });
});

describe("handleCompactionCard (docs/179)", () => {
  it("appends an assistant message carrying the compaction card and clears the indicator", () => {
    useSessionStore.setState({ compacting: true });
    handleCompactionCard(ctx, card());
    const { messages, compacting } = useSessionStore.getState();
    expect(compacting).toBe(false);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      text: "",
      compaction: { id: "compaction-1", trigger: "manual", preTokens: 180_000, postTokens: 42_000 },
    });
  });

  it("is idempotent by card id — a duplicate delivery (history load + buffer replay) appends once", () => {
    handleCompactionCard(ctx, card());
    handleCompactionCard(ctx, card());
    expect(useSessionStore.getState().messages).toHaveLength(1);
  });
});
