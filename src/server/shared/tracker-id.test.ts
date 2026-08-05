import { describe, it, expect } from "vitest";
import {
  GITHUB_TRACKER_PREFIX,
  defaultTrackerLabel,
  githubTrackerId,
  isGitHubTracker,
  parseGitHubTrackerId,
  parseOwnerRepo,
} from "./tracker-id.js";

describe("parseOwnerRepo", () => {
  it("parses an owner/name slug", () => {
    expect(parseOwnerRepo("octocat/hello-world")).toEqual({ owner: "octocat", repo: "hello-world" });
  });

  it("trims surrounding whitespace", () => {
    expect(parseOwnerRepo("  octocat/hello-world  ")).toEqual({ owner: "octocat", repo: "hello-world" });
  });

  it.each([
    ["", "empty"],
    ["octocat", "no slash"],
    ["octocat/", "empty repo"],
    ["/hello-world", "empty owner"],
    ["a/b/c", "two slashes"],
    ["octocat/hello world", "whitespace inside"],
    ["octocat/hello-world#42", "carries an issue number"],
  ])("rejects %j (%s)", (slug) => {
    expect(parseOwnerRepo(slug)).toBeNull();
  });
});

describe("githubTrackerId / parseGitHubTrackerId", () => {
  it("round-trips a repository through the qualified id", () => {
    const ref = { owner: "octocat", repo: "hello-world" };
    const id = githubTrackerId(ref);
    expect(id).toBe("github:octocat/hello-world");
    expect(parseGitHubTrackerId(id)).toEqual(ref);
  });

  it("returns null for the bare `github` id", () => {
    // Bare `github` means "whatever repository the operation resolved" — the
    // session's own code repo. It deliberately does NOT decay to a default here;
    // choosing one would be the substitution req 3 forbids.
    expect(parseGitHubTrackerId("github")).toBeNull();
  });

  it("returns null for linear and for a malformed qualified id", () => {
    expect(parseGitHubTrackerId("linear")).toBeNull();
    expect(parseGitHubTrackerId(`${GITHUB_TRACKER_PREFIX}not-a-slug`)).toBeNull();
    expect(parseGitHubTrackerId(GITHUB_TRACKER_PREFIX)).toBeNull();
  });
});

describe("isGitHubTracker", () => {
  it("accepts both the bare and the qualified forms", () => {
    expect(isGitHubTracker("github")).toBe(true);
    expect(isGitHubTracker("github:octocat/hello-world")).toBe(true);
  });

  it("rejects linear and unrelated ids", () => {
    expect(isGitHubTracker("linear")).toBe(false);
    expect(isGitHubTracker("githubbish")).toBe(false);
  });
});

describe("defaultTrackerLabel", () => {
  it("labels a declared tracker with the repository name", () => {
    expect(defaultTrackerLabel({ owner: "acme", repo: "planning" })).toBe("planning");
  });
});
