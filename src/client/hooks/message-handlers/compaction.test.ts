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
  useSessionStore.setState({ messages: [], compacting: false, compactingAnchor: null });
});

const userMsg = (text: string) => ({ role: "user" as const, text });

describe("handleCompactionStatus (docs/178)", () => {
  it("flips the transient compacting flag", () => {
    handleCompactionStatus(ctx, status(true));
    expect(useSessionStore.getState().compacting).toBe(true);
    handleCompactionStatus(ctx, status(false));
    expect(useSessionStore.getState().compacting).toBe(false);
  });

  it("anchors the indicator to the transcript position the compaction started at", () => {
    useSessionStore.setState({ messages: [userMsg("/compact")] });

    handleCompactionStatus(ctx, status(true));
    expect(useSessionStore.getState().compactingAnchor).toBe(1);

    // A message sent while the compaction runs must not move the anchor — it
    // belongs below the spinner, not above it.
    useSessionStore.getState().setMessages((prev) => [...prev, userMsg("go ahead with phase 1")]);
    expect(useSessionStore.getState().compactingAnchor).toBe(1);
  });

  it("keeps the original anchor when a buffered active:true is replayed after a reconnect", () => {
    useSessionStore.setState({ messages: [userMsg("/compact")] });
    handleCompactionStatus(ctx, status(true));
    useSessionStore.getState().setMessages((prev) => [...prev, userMsg("go ahead with phase 1")]);

    handleCompactionStatus(ctx, status(true));

    expect(useSessionStore.getState().compactingAnchor).toBe(1);
  });

  it("clears the anchor when the compaction ends", () => {
    handleCompactionStatus(ctx, status(true));
    handleCompactionStatus(ctx, status(false));
    expect(useSessionStore.getState().compactingAnchor).toBeNull();
  });
});

describe("handleCompactionCard (docs/178)", () => {
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
