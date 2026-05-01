import { describe, it, expect, beforeEach } from "vitest";
import { usePrStore } from "./pr-store.js";
import type { PrCardState } from "./pr-store.js";
import type { PrStatusSummary } from "../../server/shared/types/github-types.js";

function makeCard(phase: PrCardState["phase"]): PrCardState {
  return {
    cardId: "pr-card-s1",
    phase,
    pr: {
      number: 1,
      title: "Test PR",
      url: "https://github.com/test/repo/pull/1",
      baseBranch: "main",
      headBranch: "feature",
      insertions: 10,
      deletions: 5,
    },
  };
}

function makePrStatus(overrides: Partial<PrStatusSummary> = {}): PrStatusSummary {
  return {
    sessionId: "s1",
    prNumber: 1,
    prUrl: "https://github.com/test/repo/pull/1",
    prTitle: "Test PR",
    prState: "open",
    baseBranch: "main",
    headBranch: "feature",
    insertions: 10,
    deletions: 5,
    checks: { state: "success", total: 1, passed: 1, failed: 0, pending: 0 },
    mergeable: "mergeable",
    autoMergeEnabled: false,
    ...overrides,
  };
}

describe("pr-store", () => {
  beforeEach(() => {
    usePrStore.getState().reset();
  });

  describe("updateCard", () => {
    it("updates card normally for non-terminal phases", () => {
      usePrStore.getState().updateCard("s1", makeCard("ready"));
      expect(usePrStore.getState().cardBySession.s1?.phase).toBe("ready");

      usePrStore.getState().updateCard("s1", makeCard("open"));
      expect(usePrStore.getState().cardBySession.s1?.phase).toBe("open");
    });

    it("does not regress from merged to ready", () => {
      usePrStore.getState().updateCard("s1", makeCard("merged"));
      expect(usePrStore.getState().cardBySession.s1?.phase).toBe("merged");

      // Attempt to set back to "ready" — should be blocked
      usePrStore.getState().updateCard("s1", makeCard("ready"));
      expect(usePrStore.getState().cardBySession.s1?.phase).toBe("merged");
    });

    it("does not regress from closed to ready", () => {
      usePrStore.getState().updateCard("s1", makeCard("closed"));
      usePrStore.getState().updateCard("s1", makeCard("ready"));
      expect(usePrStore.getState().cardBySession.s1?.phase).toBe("closed");
    });

    it("does not regress from merged to open", () => {
      usePrStore.getState().updateCard("s1", makeCard("merged"));
      usePrStore.getState().updateCard("s1", makeCard("open"));
      expect(usePrStore.getState().cardBySession.s1?.phase).toBe("merged");
    });
  });

  describe("applyPrStatusUpdates", () => {
    it("overwrites card to merged even if it was open", () => {
      usePrStore.getState().updateCard("s1", makeCard("open"));
      usePrStore.getState().applyPrStatusUpdates([makePrStatus({ prState: "merged" })]);
      expect(usePrStore.getState().cardBySession.s1?.phase).toBe("merged");
    });

    it("overwrites card to merged even if it was ready", () => {
      usePrStore.getState().updateCard("s1", makeCard("ready"));
      usePrStore.getState().applyPrStatusUpdates([makePrStatus({ prState: "merged" })]);
      expect(usePrStore.getState().cardBySession.s1?.phase).toBe("merged");
    });

    it("clears status and card for sessions in `removals`", () => {
      usePrStore.getState().applyPrStatusUpdates([makePrStatus({ prState: "merged" })]);
      expect(usePrStore.getState().statusBySession.s1).toBeDefined();
      expect(usePrStore.getState().cardBySession.s1).toBeDefined();

      usePrStore.getState().applyPrStatusUpdates([], ["s1"]);

      expect(usePrStore.getState().statusBySession.s1).toBeUndefined();
      expect(usePrStore.getState().cardBySession.s1).toBeUndefined();
    });

    it("applies removals before updates so an unarchive followed by a fresh PR works", () => {
      usePrStore.getState().applyPrStatusUpdates([makePrStatus({ prNumber: 1 })]);
      // Server clears the old PR and immediately broadcasts a new one for the same sessionId
      usePrStore.getState().applyPrStatusUpdates(
        [makePrStatus({ prNumber: 2 })],
        ["s1"],
      );
      expect(usePrStore.getState().statusBySession.s1?.prNumber).toBe(2);
    });
  });
});
