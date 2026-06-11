/**
 * Unit tests for `parsePrBodyIssueRefs` (docs/194) — the pure parser that maps a
 * merged PR body to its closing / non-closing issue pointers. The merge-path
 * behavior (status flip vs. progress comment vs. no-op) is driven entirely by
 * what this returns, so it's the contract worth pinning.
 */

import { describe, it, expect } from "vitest";
import { parsePrBodyIssueRefs } from "./pr-issue-refs.js";

describe("parsePrBodyIssueRefs", () => {
  it("returns nothing for an empty / pointer-less body", () => {
    expect(parsePrBodyIssueRefs("")).toEqual({ closes: [], refs: [] });
    expect(parsePrBodyIssueRefs(null)).toEqual({ closes: [], refs: [] });
    expect(parsePrBodyIssueRefs(undefined)).toEqual({ closes: [], refs: [] });
    expect(parsePrBodyIssueRefs("Just a normal PR body with no pointers.")).toEqual({
      closes: [],
      refs: [],
    });
  });

  it("parses a Linear Closes pointer", () => {
    const { closes, refs } = parsePrBodyIssueRefs("## Summary\nDoes the thing.\n\nCloses SHI-43");
    expect(refs).toEqual([]);
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({ tracker: "linear", identifier: "SHI-43", issueId: "SHI-43" });
  });

  it("accepts Fixes / Resolves synonyms and all case/tense forms", () => {
    for (const kw of ["Closes", "closes", "CLOSES", "Closed", "Close", "Fixes", "fixed", "fix", "Resolves", "resolved", "Resolve"]) {
      const { closes } = parsePrBodyIssueRefs(`${kw} SHI-1`);
      expect(closes, kw).toHaveLength(1);
      expect(closes[0].identifier, kw).toBe("SHI-1");
    }
  });

  it("parses a GitHub owner/repo#N closing pointer", () => {
    const { closes } = parsePrBodyIssueRefs("Fixes octocat/hello-world#42");
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({
      tracker: "github",
      identifier: "octocat/hello-world#42",
      issueId: "42",
    });
  });

  it("parses a full issue URL after the keyword", () => {
    const linear = parsePrBodyIssueRefs("Resolves https://linear.app/acme/issue/SHI-9");
    expect(linear.closes[0]).toMatchObject({ tracker: "linear", issueId: "SHI-9" });

    const gh = parsePrBodyIssueRefs("Closes https://github.com/octocat/hello-world/issues/7");
    expect(gh.closes[0]).toMatchObject({ tracker: "github", issueId: "7" });
  });

  it("routes Refs / References to the non-closing bucket", () => {
    const { closes, refs } = parsePrBodyIssueRefs("Refs SHI-43\nReferences octocat/hello-world#5");
    expect(closes).toEqual([]);
    expect(refs.map((r) => r.identifier)).toEqual(["SHI-43", "octocat/hello-world#5"]);
  });

  it("honors multiple closing pointers (one PR finishing several issues)", () => {
    const { closes } = parsePrBodyIssueRefs("Closes SHI-1\nCloses SHI-2\nFixes octocat/hello-world#3");
    expect(closes.map((r) => r.identifier)).toEqual(["SHI-1", "SHI-2", "octocat/hello-world#3"]);
  });

  it("de-dupes a pointer named twice, and prefers closing over refs", () => {
    const { closes, refs } = parsePrBodyIssueRefs("Refs SHI-7\nCloses SHI-7");
    // Closing pass runs first and claims SHI-7; the refs pass skips the dup.
    expect(closes.map((r) => r.identifier)).toEqual(["SHI-7"]);
    expect(refs).toEqual([]);
  });

  it("strips trailing punctuation and wrapping markdown around the pointer", () => {
    expect(parsePrBodyIssueRefs("Closes SHI-43.").closes[0]?.identifier).toBe("SHI-43");
    expect(parsePrBodyIssueRefs("Closes `SHI-43`").closes[0]?.identifier).toBe("SHI-43");
    expect(parsePrBodyIssueRefs("Closes (SHI-43),").closes[0]?.identifier).toBe("SHI-43");
  });

  it("tolerates a colon after the keyword", () => {
    expect(parsePrBodyIssueRefs("Closes: SHI-43").closes[0]?.identifier).toBe("SHI-43");
  });

  it("ignores unresolvable tokens (bare #N, plain words)", () => {
    // Bare `#42` is tracker-ambiguous and unsupported by parseIssueRef.
    expect(parsePrBodyIssueRefs("Closes #42")).toEqual({ closes: [], refs: [] });
    expect(parsePrBodyIssueRefs("Fixes the bug where it broke")).toEqual({ closes: [], refs: [] });
  });

  it("does not treat substrings inside words as keywords", () => {
    // "disclose" / "prefixes" must not trip the close/fix matchers.
    const { closes } = parsePrBodyIssueRefs("This discloses SHI-1 prefixes SHI-2");
    expect(closes).toEqual([]);
  });
});
