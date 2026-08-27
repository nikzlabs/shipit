import { describe, it, expect, beforeEach } from "vitest";
import { useUiStore } from "../../stores/ui-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import { handleUsageUpdate } from "./usage-update.js";
import type { HandlerContext } from "./types.js";
import type { UsageGroup, WsUsageUpdate } from "../../../server/shared/types.js";
import { EMPTY_USAGE_TOTALS } from "../../../server/shared/types/usage-types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

const planGroup: UsageGroup = {
  key: "anthropic:sub", kind: "sub", serviceId: "anthropic", billingMode: "sub",
  models: ["claude-opus-5"], turns: 3, tokens: 300_000, costUsd: 0, atApiRatesUsd: 1.5,
};

const update = (over: Partial<WsUsageUpdate> = {}): WsUsageUpdate => ({
  type: "usage_update",
  sessionId: "s1",
  totals: { ...EMPTY_USAGE_TOTALS, atApiRatesUsd: 1.5, includedTurns: 3, includedTokens: 300_000 },
  groups: [planGroup],
  totalDurationMs: 1000,
  turnCount: 3,
  ...over,
});

describe("handleUsageUpdate (docs/252 req 16)", () => {
  beforeEach(() => {
    useUiStore.getState().setCurrentSessionUsage(null);
    useUiStore.getState().setContextTokens(0);
    useSessionStore.setState({ sessionId: "s1" });
  });

  it("carries the per-service split live, not just the totals", () => {
    // Regression (cross-backend review): the handler REPLACES
    // `currentSessionUsage`, so a totals-only message blanked the "by service"
    // split that `/history` had hydrated — and it stayed blank until reload,
    // because the fetch-on-open refreshes all-session stats only.
    handleUsageUpdate(ctx, update());
    const usage = useUiStore.getState().currentSessionUsage!;
    expect(usage.groups).toEqual([planGroup]);
    expect(usage.totals.atApiRatesUsd).toBe(1.5);
  });

  it("replaces the split rather than merging it, so a mode switch is not stale", () => {
    handleUsageUpdate(ctx, update());
    handleUsageUpdate(ctx, update({
      groups: [],
      totals: { ...EMPTY_USAGE_TOTALS, meteredCostUsd: 0.2, meteredTurns: 1 },
    }));
    expect(useUiStore.getState().currentSessionUsage!.groups).toEqual([]);
  });
});

/**
 * planning#482 — the socket is keyed off the route while this handler reads the
 * store, and a session switch moves the store first. Everything the handler
 * writes is a session-less global describing the session on screen, so the
 * outgoing session's trailing usage used to land on the incoming one.
 */
describe("handleUsageUpdate — session scoping", () => {
  beforeEach(() => {
    useUiStore.getState().setCurrentSessionUsage(null);
    useUiStore.getState().setContextTokens(0);
    useUiStore.getState().setCumulativeTokens(0, 0);
    useSessionStore.setState({ sessionId: "s1" });
  });

  it("applies an update for the session on screen", () => {
    handleUsageUpdate(ctx, update({ cumulativeInputTokens: 64_000 }));
    expect(useUiStore.getState().contextTokens).toBe(64_000);
    expect(useUiStore.getState().currentSessionUsage).not.toBeNull();
  });

  it("drops an update naming a DIFFERENT session", () => {
    handleUsageUpdate(ctx, update({ sessionId: "other", cumulativeInputTokens: 64_000 }));
    expect(useUiStore.getState().contextTokens).toBe(0);
    expect(useUiStore.getState().currentSessionUsage).toBeNull();
    expect(useUiStore.getState().cumulativeInputTokens).toBe(0);
  });
});
