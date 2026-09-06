import { describe, it, expect, afterEach, vi } from "vitest";
import { mergePullRequestAttempt } from "./github-auth-prs.js";
import { GitHubAuthManager } from "./github-auth.js";

/**
 * docs/287-agent-merge-per-repo req 9 — the three-way classification.
 *
 * The asymmetry is the whole point. Classifying an indeterminate result as a
 * refusal loses the record of a merge that may have happened; classifying an
 * unreadable answer as a merge claims one that may not have. So the rule is:
 * GitHub answering ABOUT this merge is a refusal, and everything else is
 * indeterminate.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function respond(status: number, body: unknown, ok = status < 400) {
  globalThis.fetch = vi.fn(async () => ({
    ok,
    status,
    statusText: "",
    headers: new Headers(),
    json: async () => {
      if (body === undefined) throw new Error("not json");
      return body;
    },
    text: async () => JSON.stringify(body ?? ""),
  })) as unknown as typeof globalThis.fetch;
}

async function attempt() {
  return mergePullRequestAttempt("token", "o", "r", 7, "squash", "t", "b", "sha-head");
}

describe("mergePullRequestAttempt", () => {
  it("reports a documented success as merged, with the merge commit", async () => {
    respond(200, { merged: true, sha: "merge-sha" });
    await expect(attempt()).resolves.toEqual({
      outcome: "merged", message: "Pull request merged", mergeCommitSha: "merge-sha",
    });
  });

  it.each([
    ["an empty object", {}],
    ["an array", []],
    ["a bare string", "error"],
    ["a null merged flag", { merged: null }],
    ["a stringly merged flag", { merged: "false" }],
    ["a number", 1],
  ])("treats %s as indeterminate, never as a merge", async (_label, body) => {
    // GitHub documents a 200 here only for a performed merge carrying a boolean
    // `merged`. Anything else readable is an answer ShipIt does not understand,
    // and reading it as a merge would record one that may not have happened.
    respond(200, body);
    await expect(attempt()).resolves.toMatchObject({ outcome: "indeterminate" });
  });

  it("treats an explicit merged:false as a refusal", async () => {
    respond(200, { merged: false });
    await expect(attempt()).resolves.toMatchObject({ outcome: "refused" });
  });

  it("carries GitHub's own reason on an explicit merged:false (req 7)", async () => {
    // Req 7 says GitHub's refusal is shown word for word. The generic sentence
    // used to replace it unconditionally, throwing away the only part of the
    // answer the agent could act on (cross-agent review finding).
    respond(200, { merged: false, message: "Base branch was modified" });
    const res = await attempt();
    expect(res.message).toContain("Base branch was modified");
  });

  it("treats an unparseable 2xx as indeterminate", async () => {
    respond(200, undefined);
    await expect(attempt()).resolves.toMatchObject({ outcome: "indeterminate" });
  });

  it.each([
    ["405 not mergeable", 405],
    ["403 branch protection", 403],
    ["404 no access", 404],
    ["422 unprocessable", 422],
  ])("treats %s as a definitive refusal — GitHub answered", async (_label, status) => {
    respond(status, { message: "no" }, false);
    await expect(attempt()).resolves.toMatchObject({ outcome: "refused" });
  });

  it("names the moved head on a 409 when a SHA was pinned", async () => {
    respond(409, { message: "Head branch was modified" }, false);
    const res = await attempt();
    expect(res).toMatchObject({ outcome: "refused" });
    expect(res.message).toContain("Merge again");
  });

  it.each([
    ["500", 500],
    ["502", 502],
    ["429", 429],
  ])("treats %s as indeterminate — not an answer about this merge", async (_label, status) => {
    respond(status, { message: "server error" }, false);
    await expect(attempt()).resolves.toMatchObject({ outcome: "indeterminate" });
  });

  it("treats a rejected request as indeterminate", async () => {
    // The request may have reached GitHub and been executed. "It threw" does
    // not mean "it did not merge".
    globalThis.fetch = vi.fn(async () => { throw new Error("socket hang up"); }) as unknown as typeof globalThis.fetch;
    await expect(attempt()).resolves.toMatchObject({ outcome: "indeterminate" });
  });

  it("pins the expected SHA on the request", async () => {
    respond(200, { merged: true, sha: "m" });
    await attempt();
    const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse((call[1] as { body: string }).body)).toMatchObject({
      merge_method: "squash", sha: "sha-head",
    });
  });
});

/**
 * docs/288 req 4 — the manager's wrapper, not the impl above.
 *
 * The wrapper fetches the pull request's title and body BEFORE it sends the
 * merge, and that fetch is a full network round trip. A caller whose last
 * authorisation check sits before the whole method therefore leaves a
 * cancellable read inside the window it cannot cancel; `beforeSend` is asked
 * between the two, which closes the window to the PUT alone.
 */
describe("GitHubAuthManager.mergePullRequestAttempt — beforeSend", () => {
  /** Records every request so the ORDER of the two calls is observable. */
  function trackFetch(): string[] {
    const methods: string[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: { method?: string }) => {
      methods.push(init?.method ?? "GET");
      return {
        ok: true,
        status: 200,
        statusText: "",
        headers: new Headers(),
        // Enough of a pull request for `viewPullRequest` to parse, plus the
        // merge response's own fields — one shape serves both calls.
        json: async () => ({
          merged: true, sha: "merge-sha",
          html_url: "https://github.com/o/r/pull/7", number: 7, title: "t", body: "b",
          state: "open", base: { ref: "main" }, head: { ref: "feature", sha: "sha-head" },
          user: { login: "someone" }, additions: 1, deletions: 0, changed_files: 1,
        }),
        text: async () => "{}",
      };
    }) as unknown as typeof globalThis.fetch;
    return methods;
  }

  function manager(): GitHubAuthManager {
    // Neither dependency is reached: `mergePullRequestAttempt` uses the token
    // field directly and every request is the stub above.
    const m = new GitHubAuthManager("/tmp/does-not-exist-288", {} as never);
    (m as unknown as { _token: string })._token = "token";
    return m;
  }

  it("does not send the merge when the hook refuses", async () => {
    const methods = trackFetch();
    const out = await manager().mergePullRequestAttempt(
      "o", "r", 7, "squash", "sha-head", () => "the permission was withdrawn",
    );

    expect(out).toEqual({ outcome: "refused", message: "the permission was withdrawn" });
    // The preparatory read happened — the hook is asked AFTER it, which is the
    // whole reason it exists — and no PUT followed.
    expect(methods).not.toContain("PUT");
    expect(methods.length).toBeGreaterThan(0);
  });

  it("sends the merge when the hook allows it", async () => {
    // The control: a hook that always refused would satisfy the test above.
    const methods = trackFetch();
    const out = await manager().mergePullRequestAttempt(
      "o", "r", 7, "squash", "sha-head", () => null,
    );

    expect(out.outcome).toBe("merged");
    expect(methods).toContain("PUT");
  });

  it("sends the merge when no hook is supplied", async () => {
    const methods = trackFetch();
    const out = await manager().mergePullRequestAttempt("o", "r", 7, "squash", "sha-head");
    expect(out.outcome).toBe("merged");
    expect(methods).toContain("PUT");
  });
});
