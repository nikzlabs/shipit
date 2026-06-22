import { describe, it, expect, beforeEach } from "vitest";
import { usePrStore } from "../../stores/pr-store.js";
import { handleResetEligible } from "./reset-eligible.js";
import type { HandlerContext } from "./types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

beforeEach(() => {
  usePrStore.setState({ resetEligibleBySession: {} });
});

describe("handleResetEligible (docs/218)", () => {
  it("records eligibility true for a session", () => {
    handleResetEligible(ctx, { type: "reset_eligible", sessionId: "s1", eligible: true });
    expect(usePrStore.getState().resetEligibleBySession.s1).toBe(true);
  });

  it("drops the key when eligibility goes false (absence reads as ineligible)", () => {
    handleResetEligible(ctx, { type: "reset_eligible", sessionId: "s1", eligible: true });
    handleResetEligible(ctx, { type: "reset_eligible", sessionId: "s1", eligible: false });
    expect(usePrStore.getState().resetEligibleBySession.s1).toBeUndefined();
  });

  it("keeps sessions independent", () => {
    handleResetEligible(ctx, { type: "reset_eligible", sessionId: "s1", eligible: true });
    handleResetEligible(ctx, { type: "reset_eligible", sessionId: "s2", eligible: false });
    expect(usePrStore.getState().resetEligibleBySession.s1).toBe(true);
    expect(usePrStore.getState().resetEligibleBySession.s2).toBeUndefined();
  });
});
