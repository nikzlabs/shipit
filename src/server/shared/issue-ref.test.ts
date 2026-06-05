import { describe, it, expect } from "vitest";
import { parseIssueRef } from "./issue-ref.js";

describe("parseIssueRef", () => {
  it("parses a Linear issue URL into an uppercase identifier + native key", () => {
    const ref = parseIssueRef(
      "https://linear.app/shipit-ai/issue/SHI-28/decouple-priorities-from-documents",
    );
    expect(ref).toEqual({
      tracker: "linear",
      identifier: "SHI-28",
      issueId: "SHI-28",
      url: "https://linear.app/shipit-ai/issue/SHI-28/decouple-priorities-from-documents",
    });
  });

  it("parses a bare Linear key into the native key", () => {
    // The form a doc's `issue:` pointer (or "work on SHI-28") most often holds.
    expect(parseIssueRef("SHI-28")).toEqual({
      tracker: "linear",
      identifier: "SHI-28",
      issueId: "SHI-28",
    });
  });

  it("upper-cases a lowercase bare Linear key", () => {
    expect(parseIssueRef("shi-28")).toEqual({
      tracker: "linear",
      identifier: "SHI-28",
      issueId: "SHI-28",
    });
  });

  it("parses a GitHub owner/repo#N short pointer into the bare number", () => {
    const ref = parseIssueRef("octocat/hello-world#42");
    expect(ref).toEqual({
      tracker: "github",
      identifier: "octocat/hello-world#42",
      issueId: "42",
      url: "https://github.com/octocat/hello-world/issues/42",
    });
  });

  it("parses a full GitHub issue URL into the bare number", () => {
    const ref = parseIssueRef("https://github.com/octocat/hello-world/issues/7");
    expect(ref).toEqual({
      tracker: "github",
      identifier: "octocat/hello-world#7",
      issueId: "7",
      url: "https://github.com/octocat/hello-world/issues/7",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseIssueRef("  octocat/hello-world#1  ").identifier).toBe(
      "octocat/hello-world#1",
    );
  });

  it("falls back to the raw pointer for unknown shapes", () => {
    expect(parseIssueRef("not-an-issue-ref")).toEqual({
      tracker: "unknown",
      identifier: "not-an-issue-ref",
      url: undefined,
    });
  });

  it("treats an unknown absolute URL as a link", () => {
    const ref = parseIssueRef("https://example.com/tracker/123");
    expect(ref.tracker).toBe("unknown");
    expect(ref.issueId).toBeUndefined();
    expect(ref.url).toBe("https://example.com/tracker/123");
  });
});
