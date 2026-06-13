import { describe, it, expect } from "vitest";
import { parseTrackerIssueLink } from "./tracker-link.js";

describe("parseTrackerIssueLink", () => {
  it("parses a Linear issue URL", () => {
    const link = parseTrackerIssueLink("https://linear.app/shipit-ai/issue/SHI-137");
    expect(link).toEqual({
      tracker: "linear",
      identifier: "SHI-137",
      issueId: "SHI-137",
      url: "https://linear.app/shipit-ai/issue/SHI-137",
    });
  });

  it("parses a Linear issue URL with a trailing title slug", () => {
    const link = parseTrackerIssueLink(
      "https://linear.app/shipit-ai/issue/SHI-137/intercept-issue-urls",
    );
    expect(link?.tracker).toBe("linear");
    expect(link?.identifier).toBe("SHI-137");
    expect(link?.issueId).toBe("SHI-137");
  });

  it("parses a GitHub issue URL", () => {
    const link = parseTrackerIssueLink("https://github.com/owner/repo/issues/42");
    expect(link).toEqual({
      tracker: "github",
      identifier: "owner/repo#42",
      issueId: "42",
      url: "https://github.com/owner/repo/issues/42",
    });
  });

  it("parses the GitHub owner/repo#N short form and resolves an absolute URL", () => {
    const link = parseTrackerIssueLink("owner/repo#42");
    expect(link).toEqual({
      tracker: "github",
      identifier: "owner/repo#42",
      issueId: "42",
      url: "https://github.com/owner/repo/issues/42",
    });
  });

  it("does NOT parse a GitHub PR URL", () => {
    expect(parseTrackerIssueLink("https://github.com/owner/repo/pull/42")).toBeNull();
  });

  it("does NOT parse a Linear project URL", () => {
    expect(
      parseTrackerIssueLink("https://linear.app/shipit-ai/project/some-project-abc123"),
    ).toBeNull();
  });

  it("does NOT parse a GitHub repo URL", () => {
    expect(parseTrackerIssueLink("https://github.com/owner/repo")).toBeNull();
  });

  it("does NOT parse a plain external URL", () => {
    expect(parseTrackerIssueLink("https://example.com/docs")).toBeNull();
  });

  it("does NOT parse a repo file path", () => {
    expect(parseTrackerIssueLink("src/server/foo.ts:42")).toBeNull();
    expect(parseTrackerIssueLink("docs/170-foo/plan.md")).toBeNull();
  });

  it("does NOT parse a bare Linear key (no derivable URL)", () => {
    expect(parseTrackerIssueLink("SHI-28")).toBeNull();
  });

  it("returns null for empty / missing href", () => {
    expect(parseTrackerIssueLink("")).toBeNull();
    expect(parseTrackerIssueLink(undefined)).toBeNull();
    expect(parseTrackerIssueLink(null)).toBeNull();
  });
});
