import { describe, it, expect, vi, afterEach } from "vitest";
import { viewPullRequestConversation, viewPullRequest, viewPullRequestResult, listPullRequests } from "./github-auth-prs.js";

function mockFetch(payload: unknown, status = 200): void {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } }),
  );
}

function mockFetchRecording(payload: unknown): { urls: string[]; bodies: string[] } {
  const urls: string[] = [];
  const bodies: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    bodies.push(typeof init?.body === "string" ? init.body : "");
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  return { urls, bodies };
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

  it("reports GitHub's totals, so a windowed fetch cannot look complete", async () => {
    mockFetch(graphqlPr({
      comments: {
        totalCount: 62,
        nodes: [{ id: "c1", body: "x", createdAt: "", url: "", author: { login: "a" } }],
      },
      reviewThreads: {
        totalCount: 51,
        nodes: [{
          id: "t1", isResolved: false, isOutdated: false, path: "f.ts", line: 1, originalLine: null,
          comments: { totalCount: 3, nodes: [{ id: "tc", body: "y", createdAt: "", url: "", diffHunk: "", author: null }] },
        }],
      },
    }));
    const res = await viewPullRequestConversation("tok", "o", "r", 7);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.conversation.commentsTotal).toBe(62);
    expect(res.conversation.comments).toHaveLength(1);
    expect(res.conversation.reviewThreadsTotal).toBe(51);
    expect(res.conversation.reviewThreads[0].commentsTotal).toBe(3);
  });

  it("never reports a total below what it returns", async () => {
    mockFetch(graphqlPr({
      comments: {
        totalCount: 0,
        nodes: [{ id: "c1", body: "x", createdAt: "", url: "", author: null }],
      },
    }));
    const res = await viewPullRequestConversation("tok", "o", "r", 7);
    expect(res.ok && res.conversation.commentsTotal).toBe(1);
  });

  it("discounts filtered PENDING reviews from the reported review total", async () => {
    mockFetch(graphqlPr({
      reviews: {
        totalCount: 4,
        nodes: [
          { id: "r1", body: "", state: "PENDING", submittedAt: null, url: "", author: null },
          { id: "r2", body: "", state: "APPROVED", submittedAt: "", url: "", author: null },
        ],
      },
    }));
    const res = await viewPullRequestConversation("tok", "o", "r", 7);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.conversation.reviewsTotal).toBe(3);
    expect(res.conversation.reviews).toHaveLength(1);
  });

  it("keeps originalLine so an outdated thread still says where it points", async () => {
    mockFetch(graphqlPr({
      reviewThreads: {
        nodes: [{
          id: "t1", isResolved: false, isOutdated: true, path: "src/foo.ts",
          line: null, originalLine: 17,
          comments: { nodes: [{ id: "tc", body: "here", createdAt: "", url: "", diffHunk: "@@", author: null }] },
        }],
      },
    }));
    const res = await viewPullRequestConversation("tok", "o", "r", 7);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.conversation.reviewThreads[0]).toMatchObject({ line: null, originalLine: 17 });
  });

  it("reports a missing PR instead of returning an empty conversation", async () => {
    mockFetch({ data: { repository: { pullRequest: null } } });
    const res = await viewPullRequestConversation("tok", "o", "r", 7);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("#7");
  });
});

describe("viewPullRequestResult", () => {
  afterEach(() => vi.restoreAllMocks());

  it("treats 404 as 'no such PR'", async () => {
    mockFetch({ message: "Not Found" }, 404);
    expect(await viewPullRequestResult("tok", "o", "r", 3)).toEqual({ ok: true, pr: null });
  });

  it("treats any other failure as an error, not as absence", async () => {
    mockFetch({ message: "Resource not accessible by integration" }, 403);
    const res = await viewPullRequestResult("tok", "o", "r", 3);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("Resource not accessible");
  });

  it("still collapses both to null for viewPullRequest's existing callers", async () => {
    mockFetch({ message: "boom" }, 500);
    expect(await viewPullRequest("tok", "o", "r", 3)).toBe(null);
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

describe("listPullRequests", () => {
  afterEach(() => vi.restoreAllMocks());

  function restPr(over: Record<string, unknown>): unknown {
    return {
      html_url: "u", number: 1, base: { ref: "main" }, head: { ref: "feat" },
      title: "T", state: "closed", draft: false, merged_at: null, ...over,
    };
  }

  function graphqlNodes(nodes: unknown[]): unknown {
    return { data: { repository: { pullRequests: { nodes } } } };
  }

  const NODE = {
    url: "u", number: 8, title: "T", isDraft: false,
    mergedAt: "2026-08-02T00:00:00Z", baseRefName: "main", headRefName: "feat",
  };

  async function prsOf(state: Parameters<typeof listPullRequests>[3]) {
    const res = await listPullRequests("tok", "o", "r", state);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    return res.prs;
  }

  it("selects merged PRs server-side rather than filtering a page of closed ones", async () => {
    const { urls, bodies } = mockFetchRecording(graphqlNodes([NODE]));
    await listPullRequests("tok", "o", "r", "merged");
    expect(urls).toEqual(["https://api.github.com/graphql"]);
    expect(bodies[0]).toContain("states: MERGED");
    expect(urls.some((u) => u.includes("/pulls?"))).toBe(false);
  });

  it("returns a merge GitHub selected even when it is far from the recent closes", async () => {
    const { bodies } = mockFetchRecording(
      graphqlNodes([{ ...NODE, number: 4, mergedAt: "2024-01-01T00:00:00Z" }]),
    );
    expect((await prsOf("merged")).map((p) => p.number)).toEqual([4]);
    expect(bodies[0]).toContain('"first":30');
  });

  it("normalises a merged row onto the same shape REST states return", async () => {
    mockFetchRecording(graphqlNodes([NODE]));
    expect(await prsOf("merged")).toEqual([
      { url: "u", number: 8, base: "main", head: "feat", title: "T", state: "closed", isDraft: false, mergedAt: "2026-08-02T00:00:00Z" },
    ]);
  });

  it("passes the REST states through untouched and carries mergedAt", async () => {
    const { urls } = mockFetchRecording([restPr({ number: 3, state: "open", merged_at: null })]);
    const prs = await prsOf("open");
    expect(urls[0]).toContain("state=open");
    expect(urls[0]).toContain("per_page=30");
    expect(prs).toEqual([
      { url: "u", number: 3, base: "main", head: "feat", title: "T", state: "open", isDraft: false, mergedAt: null },
    ]);
  });

  it("reports a merged PR reached via 'all' the same way", async () => {
    mockFetchRecording([restPr({ number: 8, state: "closed", merged_at: "2026-08-02T00:00:00Z" })]);
    expect((await prsOf("all"))[0]).toMatchObject({ state: "closed", mergedAt: "2026-08-02T00:00:00Z" });
  });

  describe("limit", () => {
    it("becomes the REST page size", async () => {
      const { urls } = mockFetchRecording([]);
      await listPullRequests("tok", "o", "r", "open", 7);
      expect(urls[0]).toContain("per_page=7");
    });

    it("becomes GraphQL's `first` on the merged path", async () => {
      const { bodies } = mockFetchRecording(graphqlNodes([]));
      await listPullRequests("tok", "o", "r", "merged", 7);
      expect(bodies[0]).toContain('"first":7');
    });

    it("falls back to 30 when absent, on both paths", async () => {
      const rest = mockFetchRecording([]);
      await listPullRequests("tok", "o", "r", "open");
      expect(rest.urls[0]).toContain("per_page=30");
      const gql = mockFetchRecording(graphqlNodes([]));
      await listPullRequests("tok", "o", "r", "merged");
      expect(gql.bodies[0]).toContain('"first":30');
    });

    it("clamps an out-of-range value rather than sending it to GitHub", async () => {
      const low = mockFetchRecording([]);
      await listPullRequests("tok", "o", "r", "open", 0);
      expect(low.urls[0]).toContain("per_page=1");
      const high = mockFetchRecording([]);
      await listPullRequests("tok", "o", "r", "open", 5000);
      expect(high.urls[0]).toContain("per_page=100");
    });
  });

  describe("a failed read is not an empty one", () => {
    it("reports a 403 on a private repo, carrying GitHub's own message", async () => {
      mockFetch({ message: "Resource not accessible by integration" }, 403);
      expect(await listPullRequests("tok", "o", "r", "open")).toEqual({
        ok: false, error: "Resource not accessible by integration",
      });
    });

    it("reports a rate-limit response rather than an empty repository", async () => {
      mockFetch({ message: "API rate limit exceeded" }, 429);
      const res = await listPullRequests("tok", "o", "r", "open");
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toContain("rate limit");
    });

    it("reports a 5xx, falling back to the status when the body isn't JSON", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("<html>502 Bad Gateway</html>", { status: 502, statusText: "Bad Gateway" }),
      );
      const res = await listPullRequests("tok", "o", "r", "open");
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toContain("502");
    });

    it("reports a GraphQL error on the merged path, which answers 200", async () => {
      mockFetch({ errors: [{ message: "Resource not accessible" }] });
      expect(await listPullRequests("tok", "o", "r", "merged")).toEqual({
        ok: false, error: "Resource not accessible",
      });
    });

    it("reports a non-2xx on the merged path too", async () => {
      mockFetch({ message: "Bad credentials" }, 401);
      expect(await listPullRequests("tok", "o", "r", "merged")).toEqual({
        ok: false, error: "Bad credentials",
      });
    });

    it.each([
      ["an empty body", {}],
      ["a null data", { data: null }],
      ["a null repository", { data: { repository: null } }],
    ])("reports a malformed GraphQL 200 (%s) rather than 'none'", async (_label, payload) => {
      mockFetch(payload);
      expect((await listPullRequests("tok", "o", "r", "merged")).ok).toBe(false);
    });

    it("still says 'none' with ok:true, so absence keeps its own answer", async () => {
      mockFetchRecording([]);
      expect(await listPullRequests("tok", "o", "r", "open")).toEqual({ ok: true, prs: [] });
      mockFetch(graphqlNodes([]));
      expect(await listPullRequests("tok", "o", "r", "merged")).toEqual({ ok: true, prs: [] });
    });
  });
});
