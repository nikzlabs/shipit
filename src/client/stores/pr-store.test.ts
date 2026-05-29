import { describe, it, expect, beforeEach, vi } from "vitest";
import { usePrStore } from "./pr-store.js";
import type { PrCardState } from "./pr-store.js";
import type { PrStatusSummary } from "../../server/shared/types/github-types.js";

function makeCard(phase: PrCardState["phase"], overrides: Partial<PrCardState> = {}): PrCardState {
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
    ...overrides,
  };
}

function makePrStatus(overrides: Partial<PrStatusSummary> = {}): PrStatusSummary {
  return {
    sessionId: "s1",
    prNumber: 1,
    prUrl: "https://github.com/test/repo/pull/1",
    prTitle: "Test PR",
    prBody: "",
    prCreatedAt: "2026-05-20T10:00:00Z",
    prAuthor: { login: "alice", avatarUrl: "https://avatars/alice.png" },
    prState: "open",
    baseBranch: "main",
    headBranch: "feature",
    insertions: 10,
    deletions: 5,
    files: [{ path: "src/index.ts", status: "M", insertions: 10, deletions: 5 }],
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
      usePrStore.setState({ autoMergeBySession: { s1: { enabled: true, mergeMethod: "squash" } } });
      expect(usePrStore.getState().statusBySession.s1).toBeDefined();
      expect(usePrStore.getState().cardBySession.s1).toBeDefined();

      usePrStore.getState().applyPrStatusUpdates([], ["s1"]);

      expect(usePrStore.getState().statusBySession.s1).toBeUndefined();
      expect(usePrStore.getState().cardBySession.s1).toBeUndefined();
      expect(usePrStore.getState().autoMergeBySession.s1).toBeUndefined();
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

    it("copies PR metadata and file rows onto the card", () => {
      usePrStore.getState().applyPrStatusUpdates([makePrStatus()]);
      const pr = usePrStore.getState().cardBySession.s1?.pr;
      expect(pr?.createdAt).toBe("2026-05-20T10:00:00Z");
      expect(pr?.author?.login).toBe("alice");
      expect(pr?.files).toEqual([{ path: "src/index.ts", status: "M", insertions: 10, deletions: 5 }]);
    });

    it("copies auto-merge state into session state and the card", () => {
      const autoMerge = { enabled: true, mergeMethod: "squash" as const };
      usePrStore.getState().applyPrStatusUpdates([makePrStatus({ autoMerge })]);

      expect(usePrStore.getState().autoMergeBySession.s1).toEqual(autoMerge);
      expect(usePrStore.getState().cardBySession.s1?.autoMerge).toEqual(autoMerge);
    });
  });

  describe("toggleAutoMerge", () => {
    it("stores auto-merge state even when no card exists yet", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
        enabled: true,
        mergeMethod: "squash",
      }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

      try {
        await usePrStore.getState().toggleAutoMerge("s1", true);

        expect(usePrStore.getState().autoMergeBySession.s1).toMatchObject({
          enabled: true,
          mergeMethod: "squash",
        });
        expect(usePrStore.getState().cardBySession.s1).toBeUndefined();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("flips the toggle optimistically before the request resolves", async () => {
      usePrStore.getState().updateCard("s1", makeCard("open", {
        autoMerge: { enabled: false, mergeMethod: "squash" },
      }));

      let resolveFetch: ((value: Response) => void) | undefined;
      const fetchPromise = new Promise<Response>((resolve) => { resolveFetch = resolve; });
      globalThis.fetch = vi.fn(() => fetchPromise) as typeof fetch;

      const togglePromise = usePrStore.getState().toggleAutoMerge("s1", true);

      // Optimistic flip is visible before the fetch resolves.
      expect(usePrStore.getState().autoMergeBySession.s1?.enabled).toBe(true);
      expect(usePrStore.getState().cardBySession.s1?.autoMerge?.enabled).toBe(true);

      resolveFetch!(new Response(
        JSON.stringify({ enabled: true, mergeMethod: "squash" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ));
      await togglePromise;

      expect(usePrStore.getState().autoMergeBySession.s1?.enabled).toBe(true);
      expect(usePrStore.getState().cardBySession.s1?.autoMerge?.enabled).toBe(true);
    });

    it("reverts the optimistic flip when the request fails", async () => {
      usePrStore.getState().updateCard("s1", makeCard("open", {
        autoMerge: { enabled: false, mergeMethod: "squash" },
      }));

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: "boom" }),
      }) as typeof fetch;

      await usePrStore.getState().toggleAutoMerge("s1", true);

      expect(usePrStore.getState().autoMergeBySession.s1?.enabled).toBe(false);
      expect(usePrStore.getState().cardBySession.s1?.autoMerge?.enabled).toBe(false);
    });
  });

  describe("toggleAutoFix", () => {
    it("flips the toggle optimistically before the request resolves", async () => {
      usePrStore.getState().updateCard("s1", makeCard("open", {
        autoFix: { enabled: false, status: "idle", attemptCount: 0, maxAttempts: 3 },
      }));

      let resolveFetch: ((value: Response) => void) | undefined;
      const fetchPromise = new Promise<Response>((resolve) => { resolveFetch = resolve; });
      globalThis.fetch = vi.fn(() => fetchPromise) as typeof fetch;

      const togglePromise = usePrStore.getState().toggleAutoFix("s1", true);

      // Optimistic flip is visible before the fetch resolves.
      expect(usePrStore.getState().cardBySession.s1?.autoFix?.enabled).toBe(true);

      resolveFetch!(new Response(
        JSON.stringify({ enabled: true, status: "idle", attemptCount: 0 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ));
      await togglePromise;

      expect(usePrStore.getState().cardBySession.s1?.autoFix?.enabled).toBe(true);
    });

    it("reverts the optimistic flip when the request fails", async () => {
      usePrStore.getState().updateCard("s1", makeCard("open", {
        autoFix: { enabled: false, status: "idle", attemptCount: 0, maxAttempts: 3 },
      }));

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: "boom" }),
      }) as typeof fetch;

      await usePrStore.getState().toggleAutoFix("s1", true);

      expect(usePrStore.getState().cardBySession.s1?.autoFix?.enabled).toBe(false);
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
