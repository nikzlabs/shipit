import { describe, it, expect } from "vitest";
import { parseTrackerIssueLink } from "./tracker-link.js";
import type { TrackerDestination } from "../../server/shared/declared-tracker.js";

/**
 * docs/248 — a href only becomes an in-app link when it resolves to a
 * destination this session's repository declares (or the session's own repo).
 * These fixtures are that declared set.
 */
const OWN: TrackerDestination = { id: "github", kind: "github", key: "owner/repo" };
const PLANNING: TrackerDestination = {
  id: "github:acme/planning",
  kind: "github",
  key: "acme/planning",
  name: "planning",
};
const ROADMAP: TrackerDestination = { id: "linear:SHI", kind: "linear", key: "SHI", name: "roadmap" };
const DECLARED = [OWN, PLANNING, ROADMAP];

describe("parseTrackerIssueLink", () => {
  it("parses a Linear issue URL for a declared team", () => {
    const link = parseTrackerIssueLink("https://linear.app/shipit-ai/issue/SHI-137", DECLARED);
    expect(link).toEqual({
      tracker: "linear:SHI",
      // req 15 — rendered in the destination's name form.
      identifier: "roadmap#SHI-137",
      issueId: "SHI-137",
      url: "https://linear.app/shipit-ai/issue/SHI-137",
    });
  });

  it("parses a Linear issue URL with a trailing title slug", () => {
    const link = parseTrackerIssueLink(
      "https://linear.app/shipit-ai/issue/SHI-137/intercept-issue-urls",
      DECLARED,
    );
    expect(link?.tracker).toBe("linear:SHI");
    expect(link?.issueId).toBe("SHI-137");
  });

  it("parses a GitHub issue URL for the session's own repository", () => {
    const link = parseTrackerIssueLink("https://github.com/owner/repo/issues/42", DECLARED);
    expect(link).toEqual({
      // docs/248 — the link opens the inline viewer bound to the repository the
      // href named, not whichever repo the active session happens to be on.
      tracker: "github",
      identifier: "owner/repo#42",
      issueId: "42",
      url: "https://github.com/owner/repo/issues/42",
    });
  });

  it("parses the GitHub owner/repo#N short form for a declared repository", () => {
    const link = parseTrackerIssueLink("acme/planning#42", DECLARED);
    expect(link).toEqual({
      tracker: "github:acme/planning",
      identifier: "planning#42",
      issueId: "42",
      url: "https://github.com/acme/planning/issues/42",
    });
  });

  // req 11 — recognizing an address is not reaching it. An issue URL for a
  // repository nobody declared has no in-app view to open, so it keeps its
  // ordinary external link rather than becoming a link into nothing.
  it("does NOT intercept an issue URL for an undeclared repository", () => {
    expect(
      parseTrackerIssueLink("https://github.com/someone-else/notes/issues/9", DECLARED),
    ).toBeNull();
  });

  it("does NOT intercept a Linear URL for an undeclared team", () => {
    expect(parseTrackerIssueLink("https://linear.app/ws/issue/OPS-3", DECLARED)).toBeNull();
  });

  it("does NOT parse a GitHub PR URL", () => {
    expect(parseTrackerIssueLink("https://github.com/owner/repo/pull/42", DECLARED)).toBeNull();
  });

  it("does NOT parse a Linear project URL", () => {
    expect(
      parseTrackerIssueLink("https://linear.app/shipit-ai/project/some-project-abc123", DECLARED),
    ).toBeNull();
  });

  it("does NOT parse a GitHub repo URL", () => {
    expect(parseTrackerIssueLink("https://github.com/owner/repo", DECLARED)).toBeNull();
  });

  it("does NOT parse a plain external URL", () => {
    expect(parseTrackerIssueLink("https://example.com/docs", DECLARED)).toBeNull();
  });

  it("does NOT parse a repo file path", () => {
    expect(parseTrackerIssueLink("src/server/foo.ts:42", DECLARED)).toBeNull();
    expect(parseTrackerIssueLink("docs/170-foo/plan.md", DECLARED)).toBeNull();
  });

  it("does NOT parse a bare Linear key or a name form (no derivable URL)", () => {
    expect(parseTrackerIssueLink("SHI-28", DECLARED)).toBeNull();
    expect(parseTrackerIssueLink("planning#42", DECLARED)).toBeNull();
  });

  it("returns null for empty / missing href", () => {
    expect(parseTrackerIssueLink("", DECLARED)).toBeNull();
    expect(parseTrackerIssueLink(undefined, DECLARED)).toBeNull();
    expect(parseTrackerIssueLink(null, DECLARED)).toBeNull();
  });

  it("intercepts nothing when the tracker list is still cold", () => {
    expect(parseTrackerIssueLink("https://github.com/owner/repo/issues/42", [])).toBeNull();
  });
});
