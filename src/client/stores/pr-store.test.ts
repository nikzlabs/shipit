import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
    prBody: "",
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

  describe("quickCreate error classification", () => {
    const originalFetch = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("tags HTTP 401 as an auth error so the card can offer Sign in", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: "Not authenticated with GitHub" }),
      }) as typeof fetch;

      await usePrStore.getState().quickCreate("s1");

      const card = usePrStore.getState().cardBySession.s1;
      expect(card?.phase).toBe("error");
      expect(card?.errorKind).toBe("auth");
      expect(card?.errorMessage).toBe("Not authenticated with GitHub");
    });

    it("tags non-401 failures as generic errors", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: "Push failed: connection refused" }),
      }) as typeof fetch;

      await usePrStore.getState().quickCreate("s1");

      const card = usePrStore.getState().cardBySession.s1;
      expect(card?.phase).toBe("error");
      expect(card?.errorKind).toBe("generic");
    });
  });

  describe("postComment (docs/133 Phase 4)", () => {
    beforeEach(() => {
      usePrStore.getState().updateCard("s1", makeCard("open"));
    });

    it("returns an error and skips the request for an empty body", async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as typeof fetch;
      const err = await usePrStore.getState().postComment("s1", "   ");
      expect(err).toBe("Comment cannot be empty");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("optimistically appends the comment and keeps it on success", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ number: 1, commentUrl: "u" }),
      }) as typeof fetch;

      const err = await usePrStore.getState().postComment("s1", "Looks good");
      expect(err).toBeNull();
      const comments = usePrStore.getState().cardBySession.s1?.issueComments ?? [];
      expect(comments).toHaveLength(1);
      expect(comments[0].body).toBe("Looks good");
    });

    it("reverts the optimistic append when the request fails", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: "Not authenticated with GitHub" }),
      }) as typeof fetch;

      const err = await usePrStore.getState().postComment("s1", "Looks good");
      expect(err).toBe("Not authenticated with GitHub");
      expect(usePrStore.getState().cardBySession.s1?.issueComments ?? []).toHaveLength(0);
    });
  });
});
