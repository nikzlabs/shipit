import { describe, it, expect, beforeEach } from "vitest";
import { useReleaseStore } from "./release-store.js";
import type { ReleaseStatusSummary } from "../../server/shared/types/release-types.js";

function card(sessionId: string, phase: ReleaseStatusSummary["phase"]): ReleaseStatusSummary {
  return { sessionId, phase, version: "0.3.0", tag: "v0.3.0", prerelease: false };
}

describe("release-store", () => {
  beforeEach(() => {
    useReleaseStore.getState().reset();
  });

  it("applies updates keyed by session", () => {
    useReleaseStore.getState().applyReleaseStatusUpdates([card("s1", "proposed")]);
    expect(useReleaseStore.getState().cardBySession.s1?.phase).toBe("proposed");

    useReleaseStore.getState().applyReleaseStatusUpdates([card("s1", "gating")]);
    expect(useReleaseStore.getState().cardBySession.s1?.phase).toBe("gating");
  });

  it("drops cards absent from an authoritative snapshot", () => {
    useReleaseStore.getState().applyReleaseStatusUpdates([card("s1", "proposed"), card("s2", "gating")]);
    // Snapshot only contains s2 → s1 is pruned.
    useReleaseStore.getState().applyReleaseStatusUpdates([card("s2", "released")], undefined, true);
    expect(useReleaseStore.getState().cardBySession.s1).toBeUndefined();
    expect(useReleaseStore.getState().cardBySession.s2?.phase).toBe("released");
  });

  it("does not prune on a non-snapshot update", () => {
    useReleaseStore.getState().applyReleaseStatusUpdates([card("s1", "proposed")]);
    useReleaseStore.getState().applyReleaseStatusUpdates([card("s2", "gating")]);
    expect(useReleaseStore.getState().cardBySession.s1).toBeDefined();
    expect(useReleaseStore.getState().cardBySession.s2).toBeDefined();
  });

  it("removes cards listed in removals", () => {
    useReleaseStore.getState().applyReleaseStatusUpdates([card("s1", "proposed")]);
    useReleaseStore.getState().applyReleaseStatusUpdates([], ["s1"]);
    expect(useReleaseStore.getState().cardBySession.s1).toBeUndefined();
  });

  it("dismiss removes a single card optimistically", () => {
    useReleaseStore.getState().applyReleaseStatusUpdates([card("s1", "proposed")]);
    useReleaseStore.getState().dismiss("s1");
    expect(useReleaseStore.getState().cardBySession.s1).toBeUndefined();
  });
});
