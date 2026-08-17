import { describe, it, expect } from "vitest";
import {
  GITHUB_TRACKER_PREFIX,
  githubTrackerId,
  isGitHubTracker,
  isLinearTracker,
  linearTrackerId,
  normalizeLinearTeamKey,
  parseGitHubTrackerId,
  parseLinearTrackerId,
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

describe("linearTrackerId / parseLinearTrackerId (docs/248-declared-issue-trackers req 5)", () => {
  it("round-trips a team key through the qualified id", () => {
    expect(linearTrackerId("SHI")).toBe("linear:SHI");
    expect(parseLinearTrackerId("linear:SHI")).toBe("SHI");
  });

  it("upper-cases the key so a declaration written `shi` matches `SHI-304`", () => {
    expect(linearTrackerId("shi")).toBe("linear:SHI");
    expect(parseLinearTrackerId("linear:shi")).toBe("SHI");
  });

  // The bare `linear` is the retired deployment-wide binding (req 1 removed it),
  // so it names no destination this build can reach — it must not silently
  // resolve to some team.
  it("returns null for the retired bare `linear` id", () => {
    expect(parseLinearTrackerId("linear")).toBeNull();
  });

  it("returns null for a GitHub id", () => {
    expect(parseLinearTrackerId("github:acme/planning")).toBeNull();
  });

  it("recognizes both the bare and qualified linear ids as Linear", () => {
    expect(isLinearTracker("linear")).toBe(true);
    expect(isLinearTracker("linear:SHI")).toBe(true);
    expect(isLinearTracker("github")).toBe(false);
  });
});

describe("normalizeLinearTeamKey", () => {
  it.each([
    ["SHI", "SHI"],
    ["shi", "SHI"],
    ["  Ops2  ", "OPS2"],
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeLinearTeamKey(input)).toBe(expected);
  });

  it.each([["", "empty"], ["1SHI", "leading digit"], ["a b", "whitespace"], ["SHI-1", "a full key"]])(
    "rejects %j (%s)",
    (input) => {
      expect(normalizeLinearTeamKey(input)).toBeNull();
    },
  );
});
