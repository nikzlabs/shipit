import { describe, it, expect, afterEach, vi } from "vitest";
import { mergePullRequestAttempt } from "./github-auth-prs.js";

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
