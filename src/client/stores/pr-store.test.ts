import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { usePrStore, selectActiveAutoMerge } from "./pr-store.js";
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

    // docs/202 — a re-armed card carries `previousMergedPr` and MUST override
    // the terminal-regress guard so it replaces a stale merged card (order-
    // independently — re-arm broadcasts no destructive removal to race it).
    it("lets a re-armed card carrying previousMergedPr replace a merged card", () => {
      usePrStore.getState().updateCard("s1", makeCard("merged"));
      usePrStore.getState().updateCard(
        "s1",
        makeCard("ready", {
          previousMergedPr: { number: 1, url: "u", title: "Old PR", baseBranch: "main" },
        }),
      );
      const card = usePrStore.getState().cardBySession.s1;
      expect(card?.phase).toBe("ready");
      expect(card?.previousMergedPr?.number).toBe(1);
    });

    it("lets a re-armed card replace a closed card too", () => {
      usePrStore.getState().updateCard("s1", makeCard("closed"));
      usePrStore.getState().updateCard(
        "s1",
        makeCard("creating", {
          previousMergedPr: { number: 9, url: "u", title: "Old PR", baseBranch: "release/x" },
        }),
      );
      expect(usePrStore.getState().cardBySession.s1?.phase).toBe("creating");
    });

    // docs/202 — the re-armed card is ALSO the client's only cue that the poller
    // silently dropped its snapshot (`reArm` broadcasts no `pr_status` removal —
    // it would race this card across transports). Without mirroring that clear,
    // `PrStateBadge` keeps reading the stale merged `statusBySession` entry ahead
    // of the card phase and renders the purple merged icon on a "ready" card.
    it("retires the stale poller status when a re-armed card lands", () => {
      usePrStore.setState({ statusBySession: { s1: makePrStatus({ prState: "merged" }) } });
      usePrStore.getState().updateCard("s1", makeCard("merged"));

      usePrStore.getState().updateCard(
        "s1",
        makeCard("ready", {
          previousMergedPr: { number: 1, url: "u", title: "Old PR", baseBranch: "main" },
        }),
      );

      expect(usePrStore.getState().statusBySession.s1).toBeUndefined();
      expect(usePrStore.getState().cardBySession.s1?.phase).toBe("ready");
    });

    it("leaves the poller status alone for an ordinary (non-re-armed) card", () => {
      usePrStore.setState({ statusBySession: { s1: makePrStatus() } });

      usePrStore.getState().updateCard("s1", makeCard("open"));

      expect(usePrStore.getState().statusBySession.s1?.prNumber).toBe(1);
    });

    // A terminal card carrying the breadcrumb is the poller re-promoting the
    // session after its NEW PR merged — that status is current, not stale.
    it("keeps the poller status when a re-armed session reaches a terminal card", () => {
      usePrStore.setState({ statusBySession: { s1: makePrStatus({ prState: "merged", prNumber: 2 }) } });

      usePrStore.getState().updateCard(
        "s1",
        makeCard("merged", {
          previousMergedPr: { number: 1, url: "u", title: "Old PR", baseBranch: "main" },
        }),
      );

      expect(usePrStore.getState().statusBySession.s1?.prNumber).toBe(2);
    });

    it("still blocks a non-re-armed regression from merged", () => {
      usePrStore.getState().updateCard("s1", makeCard("merged"));
      // No previousMergedPr → the guard holds.
      usePrStore.getState().updateCard("s1", makeCard("ready"));
      expect(usePrStore.getState().cardBySession.s1?.phase).toBe("merged");
    });
  });

  // docs/210 — the changed-docs strip lives in its own `notableFilesBySession`
  // slice, refreshed each post-turn commit and on viewer (re)connect via a
  // notableFiles-only patch that must NOT disturb the poller-owned card fields.
  describe("setNotableFiles", () => {
    it("patches the strip slice without touching the card's phase/pr/checks", () => {
      usePrStore.getState().updateCard(
        "s1",
        makeCard("open", {
          checks: { state: "success", total: 1, passed: 1, failed: 0, pending: 0 },
        }),
      );

      usePrStore.getState().setNotableFiles("s1", "pr-card-s1", [
        { path: "docs/a/plan.md", label: "A", kind: "doc", status: "M" },
        { path: "docs/b/plan.md", label: "B", kind: "doc", status: "A" },
      ]);

      const card = usePrStore.getState().cardBySession.s1;
      expect(card?.phase).toBe("open");
      expect(card?.pr?.number).toBe(1);
      expect(card?.checks?.state).toBe("success");
      expect(usePrStore.getState().notableFilesBySession.s1?.map((f) => f.path)).toEqual([
        "docs/a/plan.md",
        "docs/b/plan.md",
      ]);
    });

    it("clears the strip when the recomputed list is empty (authoritative)", () => {
      usePrStore.getState().setNotableFiles("s1", "pr-card-s1", [
        { path: "docs/a/plan.md", label: "A", kind: "doc", status: "M" },
      ]);
      usePrStore.getState().setNotableFiles("s1", "pr-card-s1", []);

      expect(usePrStore.getState().notableFilesBySession.s1).toBeUndefined();
    });

    it("stores the strip even before a card exists (race-proof viewer re-seed)", () => {
      // The re-seed (route-registry activateSession) and the poller's card snapshot
      // arrive on independent sockets with no ordering guarantee — the patch must
      // not be dropped if it lands first.
      usePrStore.getState().setNotableFiles("s1", "pr-card-s1", [
        { path: "docs/a/plan.md", label: "A", kind: "doc", status: "M" },
      ]);
      expect(usePrStore.getState().cardBySession.s1).toBeUndefined();
      expect(usePrStore.getState().notableFilesBySession.s1?.map((f) => f.path)).toEqual([
        "docs/a/plan.md",
      ]);
    });

    it("survives the poller rebuilding the card on a pr_status tick", () => {
      // The original bug: notableFiles held on the card was dropped when the
      // poller's pr_status snapshot rebuilt the card on reload/poll. The slice
      // is independent, so it persists.
      usePrStore.getState().updateCard("s1", makeCard("open"));
      usePrStore.getState().setNotableFiles("s1", "pr-card-s1", [
        { path: "docs/a/plan.md", label: "A", kind: "doc", status: "M" },
      ]);

      usePrStore.getState().applyPrStatusUpdates([makePrStatus({ prState: "open" })]);

      expect(usePrStore.getState().notableFilesBySession.s1?.map((f) => f.path)).toEqual([
        "docs/a/plan.md",
      ]);
    });

    it("drops the strip slice when the session's PR is removed", () => {
      usePrStore.getState().updateCard("s1", makeCard("open"));
      usePrStore.getState().setNotableFiles("s1", "pr-card-s1", [
        { path: "docs/a/plan.md", label: "A", kind: "doc", status: "M" },
      ]);

      usePrStore.getState().applyPrStatusUpdates([], ["s1"]);

      expect(usePrStore.getState().notableFilesBySession.s1).toBeUndefined();
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

      // `toMatchObject`: the reducer also stamps the arming with the PR it
      // arrived on (`armedForPrNumber`) — see `selectActiveAutoMerge`.
      expect(usePrStore.getState().autoMergeBySession.s1).toMatchObject(autoMerge);
      expect(usePrStore.getState().cardBySession.s1?.autoMerge).toMatchObject(autoMerge);
    });

    // The arming belongs to ONE pull request. The server drops its own state at
    // the same transition, but its terminal summary carries no `autoMerge`
    // field — and absent means "unchanged" everywhere else in this reducer — so
    // the sticky entry has to be retired from `prState` here. Otherwise the
    // merged card's overflow toggle keeps reading ON and `PrActionsMenu`
    // (`autoMergeBySession[id] ?? card.autoMerge`) offers to disarm a PR that no
    // longer exists.
    it.each(["merged", "closed"] as const)("clears auto-merge arming when the PR goes %s", (prState) => {
      usePrStore.getState().applyPrStatusUpdates([
        makePrStatus({ autoMerge: { enabled: true, mergeMethod: "squash" } }),
      ]);
      expect(usePrStore.getState().autoMergeBySession.s1?.enabled).toBe(true);

      usePrStore.getState().applyPrStatusUpdates([makePrStatus({ prState })]);

      expect(usePrStore.getState().autoMergeBySession.s1).toBeUndefined();
      expect(usePrStore.getState().cardBySession.s1?.autoMerge).toBeUndefined();
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

  // The read-time half of "an arming dies with its pull request" (docs/077).
  // The reducer above retires the arming when it OBSERVES the terminal update;
  // these hold the rule even when that observation never lands — the case that
  // stranded the toggle ON on a merged PR — so every surface (sidebar badge, PR
  // overflow toggle, open card, detail panel) agrees without depending on one
  // SSE event having arrived. Provenance, not phase: an arming stamped for a PR
  // that is no longer live is dead; an UNSTAMPED one is a deliberate pre-arm for
  // the next PR and survives, which is how a reused merged session is armed.
  describe("selectActiveAutoMerge", () => {
    const armed = { enabled: true, mergeMethod: "squash" as const };

    it("returns the arming for an open PR", () => {
      usePrStore.getState().applyPrStatusUpdates([makePrStatus({ autoMerge: armed })]);
      expect(selectActiveAutoMerge(usePrStore.getState(), "s1")).toMatchObject(armed);
    });

    it("stamps an arming that arrives on an open PR with that PR's number", () => {
      usePrStore.getState().applyPrStatusUpdates([makePrStatus({ prNumber: 7, autoMerge: armed })]);
      expect(usePrStore.getState().autoMergeBySession.s1?.armedForPrNumber).toBe(7);
    });

    it("returns a pre-PR arming when no card exists yet", () => {
      usePrStore.setState({ autoMergeBySession: { s1: armed } });
      expect(selectActiveAutoMerge(usePrStore.getState(), "s1")).toEqual(armed);
    });

    it.each(["merged", "closed"] as const)(
      "hides an arming the store still holds once the card phase is %s",
      (phase) => {
        usePrStore.getState().updateCard("s1", makeCard(phase));
        usePrStore.setState({
          autoMergeBySession: { s1: { ...armed, armedForPrNumber: 1 } },
        });

        expect(selectActiveAutoMerge(usePrStore.getState(), "s1")).toBeUndefined();
      },
    );

    it.each(["merged", "closed"] as const)(
      "hides an arming once the poller reports the PR %s, even with a stale open card",
      (prState) => {
        usePrStore.getState().updateCard(
          "s1",
          makeCard("open", { autoMerge: { ...armed, armedForPrNumber: 1 } }),
        );
        usePrStore.setState({ statusBySession: { s1: makePrStatus({ prState }) } });

        expect(selectActiveAutoMerge(usePrStore.getState(), "s1")).toBeUndefined();
      },
    );

    // docs/202 — a re-armed session's ready card carries the old card's
    // `autoMerge` forward, and `reArm` deletes the poller status, so NEITHER
    // half says "terminal" any more. The stamp is what still retires it.
    it("hides a merged PR's arming carried onto a re-armed ready card", () => {
      usePrStore.getState().applyPrStatusUpdates([
        makePrStatus({ prNumber: 41, autoMerge: armed }),
      ]);
      usePrStore.getState().applyPrStatusUpdates([makePrStatus({ prNumber: 41, prState: "merged" })]);
      // The arming survives the merge (e.g. a late toggle response wrote it back).
      usePrStore.setState({ autoMergeBySession: { s1: { ...armed, armedForPrNumber: 41 } } });
      // Re-armed: status cleared, card back to a ready phase.
      usePrStore.setState({ statusBySession: {} });
      usePrStore.getState().updateCard("s1", {
        cardId: "pr-card-s1",
        phase: "ready",
        previousMergedPr: { number: 41, url: "u", title: "t", baseBranch: "main" },
      });

      expect(selectActiveAutoMerge(usePrStore.getState(), "s1")).toBeUndefined();
    });

    it("keeps a fresh pre-arm made from a merged card", () => {
      usePrStore.getState().applyPrStatusUpdates([makePrStatus({ prState: "merged" })]);
      // Armed AFTER the merge, for the next PR — no stamp, so it is not the
      // dead PR's arming and must survive.
      usePrStore.setState({ autoMergeBySession: { s1: armed } });

      expect(selectActiveAutoMerge(usePrStore.getState(), "s1")).toEqual(armed);
    });
  });

  // The toggle's HTTP response is the LAST word for a session whose PR merged
  // (no further `pr_status` update ever carries an `autoMerge` field), so a
  // response that lands after the terminal update must not write the arming
  // back — that is what stranded the flag. The server refuses the same window.
  describe("toggleAutoMerge write-back races", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("drops the arming when the PR went terminal during the round-trip", async () => {
      usePrStore.getState().applyPrStatusUpdates([makePrStatus()]);
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        // The merge is observed while the request is in flight.
        usePrStore.getState().applyPrStatusUpdates([makePrStatus({ prState: "merged" })]);
        return { ok: true, status: 200, json: async () => ({ enabled: true, mergeMethod: "squash" }) };
      }) as typeof fetch;

      await usePrStore.getState().toggleAutoMerge("s1", true);

      expect(usePrStore.getState().autoMergeBySession.s1).toBeUndefined();
      expect(usePrStore.getState().cardBySession.s1?.autoMerge).toBeUndefined();
      expect(selectActiveAutoMerge(usePrStore.getState(), "s1")).toBeUndefined();
    });

    it("stamps the arming with the live PR on the normal path", async () => {
      usePrStore.getState().applyPrStatusUpdates([makePrStatus({ prNumber: 7 })]);
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ enabled: true, mergeMethod: "squash" }),
      }) as typeof fetch;

      await usePrStore.getState().toggleAutoMerge("s1", true);

      expect(usePrStore.getState().autoMergeBySession.s1).toMatchObject({
        enabled: true,
        armedForPrNumber: 7,
      });
    });

    it("leaves a merged-card pre-arm unstamped so it survives for the next PR", async () => {
      usePrStore.getState().applyPrStatusUpdates([makePrStatus({ prState: "merged" })]);
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ enabled: true, mergeMethod: "squash" }),
      }) as typeof fetch;

      await usePrStore.getState().toggleAutoMerge("s1", true);

      // The response write-back is skipped on a terminal PR, so the optimistic
      // (unstamped) arming stands — and stays visible as a pre-arm.
      expect(selectActiveAutoMerge(usePrStore.getState(), "s1")).toMatchObject({ enabled: true });
      expect(usePrStore.getState().autoMergeBySession.s1?.armedForPrNumber).toBeUndefined();
    });
  });
});
