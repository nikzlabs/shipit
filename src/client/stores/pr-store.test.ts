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
    reviewDecision: "none",
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

    describe("isSnapshot (authoritative reconnect snapshot)", () => {
      it("drops poller state for sessions absent from the snapshot", () => {
        // Two sessions known to the client...
        usePrStore.getState().applyPrStatusUpdates([
          makePrStatus({ sessionId: "s1", prNumber: 1 }),
          makePrStatus({ sessionId: "s2", prNumber: 2 }),
        ]);
        expect(usePrStore.getState().statusBySession.s2).toBeDefined();
        expect(usePrStore.getState().cardBySession.s2).toBeDefined();

        // ...but the reconnect snapshot only knows about s1 (s2's PR merged
        // and was dropped server-side while the socket was dead).
        usePrStore.getState().applyPrStatusUpdates(
          [makePrStatus({ sessionId: "s1", prNumber: 1 })],
          undefined,
          true,
        );

        expect(usePrStore.getState().statusBySession.s1).toBeDefined();
        expect(usePrStore.getState().statusBySession.s2).toBeUndefined();
        expect(usePrStore.getState().cardBySession.s2).toBeUndefined();
      });

      it("clears everything when the snapshot is empty", () => {
        usePrStore.getState().applyPrStatusUpdates([makePrStatus({ sessionId: "s1" })]);
        usePrStore.getState().applyPrStatusUpdates([], undefined, true);
        expect(usePrStore.getState().statusBySession.s1).toBeUndefined();
        expect(usePrStore.getState().cardBySession.s1).toBeUndefined();
      });

      it("preserves in-flight cards (creating/ready/error) the poller doesn't track yet", () => {
        // A PR is mid-creation for s3 via WS; the poller has no status for it.
        usePrStore.getState().updateCard("s3", makeCard("creating"));
        // A reconnect snapshot arrives that only knows about s1.
        usePrStore.getState().applyPrStatusUpdates(
          [makePrStatus({ sessionId: "s1" })],
          undefined,
          true,
        );
        // The in-flight s3 card must survive — its PR isn't poller-known yet.
        expect(usePrStore.getState().cardBySession.s3?.phase).toBe("creating");
      });

      it("does not prune when isSnapshot is falsy (incremental merge)", () => {
        usePrStore.getState().applyPrStatusUpdates([
          makePrStatus({ sessionId: "s1" }),
          makePrStatus({ sessionId: "s2" }),
        ]);
        // An incremental update touching only s1 must not drop s2.
        usePrStore.getState().applyPrStatusUpdates([makePrStatus({ sessionId: "s1" })]);
        expect(usePrStore.getState().statusBySession.s2).toBeDefined();
      });
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

  // docs/169 — the per-card auto-fix toggle was removed in favor of a global
  // setting (Settings → PR automations), so there is no `toggleAutoFix` action
  // to test here anymore. The auto-fix card state (`status`/`attemptCount`)
  // still arrives via `updateCard` from the poller's SSE snapshot.

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

  describe("closePr", () => {
    it("posts to the close route with the card's PR number and flips the card to closed", async () => {
      usePrStore.getState().updateCard("s1", makeCard("open"));
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ number: 1, url: "https://github.com/test/repo/pull/1" }),
      });
      globalThis.fetch = fetchMock as typeof fetch;

      const err = await usePrStore.getState().closePr("s1");

      expect(err).toBeNull();
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/sessions/s1/pr/1/close",
        expect.objectContaining({ method: "POST" }),
      );
      expect(usePrStore.getState().cardBySession.s1?.phase).toBe("closed");
    });

    it("falls back to the poller PR number when no card exists yet", async () => {
      usePrStore.getState().applyPrStatusUpdates([makePrStatus({ prNumber: 42 })]);
      // Drop the card the poller created so only statusBySession holds the number.
      usePrStore.setState({ cardBySession: {} });
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ number: 42, url: "u" }),
      });
      globalThis.fetch = fetchMock as typeof fetch;

      const err = await usePrStore.getState().closePr("s1");

      expect(err).toBeNull();
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/sessions/s1/pr/42/close",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("returns an error and leaves the phase unchanged when the request fails", async () => {
      usePrStore.getState().updateCard("s1", makeCard("open"));
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: "GitHub said no" }),
      }) as typeof fetch;

      const err = await usePrStore.getState().closePr("s1");

      expect(err).toBe("GitHub said no");
      expect(usePrStore.getState().cardBySession.s1?.phase).toBe("open");
    });

    it("returns an error without fetching when there is no PR number to close", async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as typeof fetch;

      const err = await usePrStore.getState().closePr("s1");

      expect(err).toBe("No open pull request to close");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
