/**
 * docs/255 — the service side of `gh pr view --comments`: the conversation is a
 * second round-trip, so it is fetched only when asked for, and a failed fetch
 * surfaces as `conversationError` rather than as an empty (and therefore
 * misleading) set of arrays.
 */

import { describe, it, expect, vi } from "vitest";
import { viewPullRequest } from "./github.js";
import type { GitManager } from "../../shared/git.js";
import type { GitHubAuthManager } from "../github-auth.js";

const REMOTE = "https://github.com/o/r.git";

function makeGit(): GitManager {
  return {
    getRemotes: vi.fn(async () => [{ name: "origin", url: REMOTE }]),
    addRemote: vi.fn(async () => {}),
    getCurrentBranch: vi.fn(async () => "feat"),
  } as unknown as GitManager;
}

function pr() {
  return {
    url: "https://github.com/o/r/pull/5", number: 5, base: "main", head: "feat",
    baseRefName: "main", headRefName: "feat", title: "T", body: "B",
    state: "open" as const, isDraft: false, merged: false, additions: 1, deletions: 0,
    author: { login: "alice" }, labels: [], createdAt: "", updatedAt: "", mergedAt: null,
  };
}

function conversation() {
  return {
    comments: [{ id: "c1", author: { login: "bob" }, body: "hi", createdAt: "", url: "" }],
    reviews: [],
    reviewThreads: [],
    reviewDecision: "COMMENTED",
  };
}

function makeGitHub(over: Record<string, unknown> = {}): GitHubAuthManager {
  return {
    authenticated: true,
    viewPullRequest: vi.fn(async () => pr()),
    viewPullRequestConversation: vi.fn(async () => ({ ok: true, conversation: conversation() })),
    ...over,
  } as unknown as GitHubAuthManager;
}

describe("viewPullRequest with comments", () => {
  it("does not pay for the conversation unless it was asked for", async () => {
    const github = makeGitHub();
    const res = await viewPullRequest(makeGit(), github, { number: 5, remoteUrl: REMOTE });
    expect(github.viewPullRequestConversation).not.toHaveBeenCalled();
    expect(res).not.toHaveProperty("comments");
  });

  it("merges the conversation onto the PR when requested", async () => {
    const github = makeGitHub();
    const res = await viewPullRequest(makeGit(), github, { number: 5, remoteUrl: REMOTE, comments: true });
    expect(github.viewPullRequestConversation).toHaveBeenCalledWith("o", "r", 5);
    expect(res).toMatchObject({ number: 5, reviewDecision: "COMMENTED" });
    expect(res?.comments?.[0].body).toBe("hi");
  });

  it("reports a failed conversation read as an error, never as empty arrays", async () => {
    const github = makeGitHub({
      viewPullRequestConversation: vi.fn(async () => ({ ok: false, error: "Bad credentials" })),
    });
    const res = await viewPullRequest(makeGit(), github, { number: 5, remoteUrl: REMOTE, comments: true });
    expect(res).toMatchObject({ number: 5, conversationError: "Bad credentials" });
    // The distinction the whole feature turns on: no empty arrays to misread.
    expect(res).not.toHaveProperty("comments");
    expect(res).not.toHaveProperty("reviewThreads");
  });

  it("returns null (and reads no conversation) when the branch has no PR", async () => {
    const github = makeGitHub({
      findPullRequest: vi.fn(async () => null),
      findPullRequestAnyState: vi.fn(async () => null),
    });
    const res = await viewPullRequest(makeGit(), github, { remoteUrl: REMOTE, comments: true });
    expect(res).toBe(null);
    expect(github.viewPullRequestConversation).not.toHaveBeenCalled();
  });
});
