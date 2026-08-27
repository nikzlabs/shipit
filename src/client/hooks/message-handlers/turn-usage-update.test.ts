import { describe, it, expect, beforeEach } from "vitest";
import { useUiStore } from "../../stores/ui-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import { handleTurnUsageUpdate } from "./turn-usage-update.js";
import type { HandlerContext } from "./types.js";
import type { WsTurnUsageUpdate } from "../../../server/shared/types.js";
import { EMPTY_USAGE_TOTALS } from "../../../server/shared/types/usage-types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

const update = (sessionId: string): WsTurnUsageUpdate => ({
  type: "turn_usage_update",
  sessionId,
  turn: {
    inputTokens: 200,
    outputTokens: 100,
    costUsd: 0.01,
    timestamp: "2026-08-27T00:00:00.000Z",
    contextTokens: 64_000,
  },
  totals: EMPTY_USAGE_TOTALS,
  turnCount: 1,
});

/**
 * planning#482 — the per-turn series is keyed by its own session and always
 * applies; `contextTokens` is a session-less global describing the session on
 * screen and must not be moved by another session's turn. The socket is keyed
 * off the route while the handler reads the store, so the two genuinely differ
 * across a switch — and a fresh session, having no turns of its own, reads
 * exactly that global.
 */
describe("handleTurnUsageUpdate — session scoping", () => {
  beforeEach(() => {
    useSessionStore.getState().reset();
    useSessionStore.setState({ sessionId: "s1" });
    useUiStore.getState().setContextTokens(0);
  });

  it("sets the context reading for the session on screen", () => {
    handleTurnUsageUpdate(ctx, update("s1"));
    expect(useUiStore.getState().contextTokens).toBe(64_000);
    expect(useSessionStore.getState().turnUsage.s1).toHaveLength(1);
  });

  it("records another session's turn without moving the context reading", () => {
    handleTurnUsageUpdate(ctx, update("other"));
    expect(useUiStore.getState().contextTokens).toBe(0);
    expect(useSessionStore.getState().turnUsage.other).toHaveLength(1);
  });
});
