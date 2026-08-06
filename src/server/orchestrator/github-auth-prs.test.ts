/**
 * docs/255 — `viewPullRequestConversation` is the read path behind
 * `gh pr view --comments`. The behaviour that matters: a failed read reports an
 * error rather than empty arrays (an empty conversation and an unreadable one
 * must never look alike — that confusion is the bug this feature fixes), and
 * unsubmitted PENDING reviews are not feedback yet.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { viewPullRequestConversation, viewPullRequest } from "./github-auth-prs.js";

function mockFetch(payload: unknown, status = 200): void {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } }),
  );
}

function graphqlPr(over: Record<string, unknown> = {}): unknown {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewDecision: "CHANGES_REQUESTED",
          comments: { nodes: [] },
          reviews: { nodes: [] },
          reviewThreads: { nodes: [] },
          ...over,
        },
      },
    },
  };
}

describe("viewPullRequestConversation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("maps issue comments, reviews, and inline threads", async () => {
    mockFetch(graphqlPr({
      comments: {
        nodes: [{ id: "c1", body: "looks good", createdAt: "2026-08-01T00:00:00Z", url: "u1", author: { login: "alice" } }],
      },
      reviews: {
        nodes: [{
          id: "r1", body: "needs work", state: "CHANGES_REQUESTED",
          submittedAt: "2026-08-02T00:00:00Z", url: "u2", author: { login: "bob" },
        }],
      },
      reviewThreads: {
        nodes: [{
          id: "t1", isResolved: false, isOutdated: false, path: "src/foo.ts", line: 42,
          comments: {
            nodes: [{
              id: "tc1", body: "this leaks", createdAt: "2026-08-02T00:00:00Z", url: "u3",
              diffHunk: "@@ -1 +1 @@\n+leak()", author: { login: "bob" },
            }],
          },
        }],
      },
    }));

    const res = await viewPullRequestConversation("tok", "o", "r", 7);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.conversation.reviewDecision).toBe("CHANGES_REQUESTED");
    expect(res.conversation.comments).toEqual([
      { id: "c1", author: { login: "alice" }, body: "looks good", createdAt: "2026-08-01T00:00:00Z", url: "u1" },
    ]);
    expect(res.conversation.reviews[0]).toMatchObject({ state: "CHANGES_REQUESTED", body: "needs work", submittedAt: "2026-08-02T00:00:00Z" });
    // The inline thread keeps where it points and the diff it points at — a
    // finding is only actionable with its file, line, and hunk (req 2).
    expect(res.conversation.reviewThreads[0]).toMatchObject({
      path: "src/foo.ts", line: 42, isResolved: false, diffHunk: "@@ -1 +1 @@\n+leak()",
    });
    expect(res.conversation.reviewThreads[0].comments[0].body).toBe("this leaks");
  });

  it("drops PENDING reviews — an unsubmitted draft is not feedback", async () => {
    mockFetch(graphqlPr({
      reviews: {
        nodes: [
          { id: "r1", body: "draft", state: "PENDING", submittedAt: null, url: "", author: { login: "bob" } },
          { id: "r2", body: "ok", state: "APPROVED", submittedAt: "2026-08-02T00:00:00Z", url: "u", author: { login: "bob" } },
        ],
      },
    }));
    const res = await viewPullRequestConversation("tok", "o", "r", 7);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.conversation.reviews.map((r) => r.id)).toEqual(["r2"]);
  });

  it("attributes a deleted author as null rather than inventing a login", async () => {
    mockFetch(graphqlPr({
      comments: { nodes: [{ id: "c1", body: "x", createdAt: "", url: "", author: null }] },
    }));
    const res = await viewPullRequestConversation("tok", "o", "r", 7);
    expect(res.ok && res.conversation.comments[0].author).toBe(null);
  });

  it("reports GraphQL errors instead of returning an empty conversation", async () => {
    mockFetch({ errors: [{ message: "Resource not accessible" }] });
    const res = await viewPullRequestConversation("tok", "o", "r", 7);
    expect(res).toEqual({ ok: false, error: "Resource not accessible" });
  });

  it("reports an HTTP failure instead of returning an empty conversation", async () => {
    mockFetch({ message: "Bad credentials" }, 401);
    const res = await viewPullRequestConversation("tok", "o", "r", 7);
    expect(res.ok).toBe(false);
  });

  it("reports a missing PR instead of returning an empty conversation", async () => {
    mockFetch({ data: { repository: { pullRequest: null } } });
    const res = await viewPullRequestConversation("tok", "o", "r", 7);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("#7");
  });
});

describe("viewPullRequest", () => {
  afterEach(() => vi.restoreAllMocks());

  it("exposes the real-gh field aliases alongside ShipIt's own names", async () => {
    mockFetch({
      html_url: "u", number: 3, base: { ref: "main" }, head: { ref: "feat" },
      title: "T", body: "B", state: "open", draft: false, merged: false,
      additions: 2, deletions: 1, user: { login: "alice" },
      labels: [{ name: "bug", color: "f00", description: "d" }],
      created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-02T00:00:00Z", merged_at: null,
    });
    const pr = await viewPullRequest("tok", "o", "r", 3);
    expect(pr).toMatchObject({
      base: "main", baseRefName: "main", head: "feat", headRefName: "feat",
      author: { login: "alice" }, labels: [{ name: "bug", color: "f00", description: "d" }],
      createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-02T00:00:00Z", mergedAt: null,
    });
  });
});
