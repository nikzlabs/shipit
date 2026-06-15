import { describe, it, expect } from "vitest";
import { parseIssueRef, extractIssueRefsFromText } from "./issue-ref.js";

describe("parseIssueRef", () => {
  it("parses a Linear issue URL into an uppercase identifier + native key", () => {
    const ref = parseIssueRef(
      "https://linear.app/example/issue/TRACKER-28/decouple-priorities-from-documents",
    );
    expect(ref).toEqual({
      tracker: "linear",
      identifier: "TRACKER-28",
      issueId: "TRACKER-28",
      url: "https://linear.app/example/issue/TRACKER-28/decouple-priorities-from-documents",
    });
  });

  it("parses a bare Linear key into the native key", () => {
    // The form a doc's `issue:` pointer (or "work on TRACKER-28") most often holds.
    expect(parseIssueRef("TRACKER-28")).toEqual({
      tracker: "linear",
      identifier: "TRACKER-28",
      issueId: "TRACKER-28",
    });
  });

  it("upper-cases a lowercase bare Linear key", () => {
    expect(parseIssueRef("tracker-28")).toEqual({
      tracker: "linear",
      identifier: "TRACKER-28",
      issueId: "TRACKER-28",
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

describe("extractIssueRefsFromText", () => {
  const ids = (text: string | null | undefined) =>
    extractIssueRefsFromText(text).map((r) => r.identifier);

  it("returns nothing for empty/nullish input", () => {
    expect(extractIssueRefsFromText("")).toEqual([]);
    expect(extractIssueRefsFromText(null)).toEqual([]);
    expect(extractIssueRefsFromText(undefined)).toEqual([]);
  });

  it("extracts the pointer from a seedFromIssueRef first message", () => {
    const seed =
      "You are working on issue SHI-90: Durable egress allowlist\n\n" +
      "Persist the allowlist.\n\n" +
      "Issue link: https://linear.app/acme/issue/SHI-90/durable-egress-allowlist";
    const refs = extractIssueRefsFromText(seed);
    // The URL and the `issue SHI-90` lead-in name the same issue → deduped to one.
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ tracker: "linear", identifier: "SHI-90", issueId: "SHI-90" });
  });

  it("extracts a Linear key after an `issue` lead-in (with assorted separators)", () => {
    expect(ids("fix issue SHI-9 please")).toEqual(["SHI-9"]);
    expect(ids("issue: SHI-12")).toEqual(["SHI-12"]);
    expect(ids("issue #SHI-3")).toEqual(["SHI-3"]);
  });

  it("does NOT mint phantom issues from bare key-shaped tokens", () => {
    // No `issue` lead-in, no URL — these must not match.
    expect(ids("encoded as UTF-8 per ISO-8601")).toEqual([]);
    expect(ids("use GPT-4 for the H-1B form")).toEqual([]);
    expect(ids("just SHI-90 on its own")).toEqual([]);
  });

  it("extracts a GitHub short ref and issue URL", () => {
    expect(ids("see octocat/hello-world#42 for context")).toEqual(["octocat/hello-world#42"]);
    expect(ids("ref https://github.com/octocat/hello-world/issues/7 here")).toEqual([
      "octocat/hello-world#7",
    ]);
  });

  it("collects multiple distinct issues across shapes, in first-seen order", () => {
    const text =
      "Working on issue SHI-1; also blocks octocat/repo#5 and " +
      "https://github.com/octocat/repo/issues/9";
    expect(ids(text)).toEqual(["SHI-1", "octocat/repo#5", "octocat/repo#9"]);
  });

  it("dedupes the same issue named two ways", () => {
    const text = "octocat/repo#5 — https://github.com/octocat/repo/issues/5";
    expect(ids(text)).toEqual(["octocat/repo#5"]);
  });
});
