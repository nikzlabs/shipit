import { describe, it, expect } from "vitest";
import { collectPrCardIssueRefs } from "./pr-card-issue-refs.js";

describe("collectPrCardIssueRefs", () => {
  it("returns nothing when neither source names an issue", () => {
    expect(collectPrCardIssueRefs({ prBody: "Just a normal PR body.", firstUserMessage: "hi" })).toEqual([]);
    expect(collectPrCardIssueRefs({})).toEqual([]);
  });

  it("tags PR-body closes/refs and the session origin with their intent", () => {
    const result = collectPrCardIssueRefs({
      prBody: "Closes SHI-90\nRefs octocat/repo#5",
      firstUserMessage: "Working on issue SHI-200: something",
    });
    expect(result).toEqual([
      expect.objectContaining({ identifier: "SHI-90", intent: "closes" }),
      expect.objectContaining({ identifier: "octocat/repo#5", intent: "refs" }),
      expect.objectContaining({ identifier: "SHI-200", intent: "origin" }),
    ]);
  });

  it("lets the strongest intent win when an issue appears in several sources", () => {
    // SHI-90 is the session origin AND the PR's Closes target → reads as Closes.
    const result = collectPrCardIssueRefs({
      prBody: "Closes SHI-90",
      firstUserMessage: "You are working on issue SHI-90: durable allowlist",
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ identifier: "SHI-90", intent: "closes" });
  });

  it("orders closing pointers first, then refs, then origin", () => {
    const result = collectPrCardIssueRefs({
      prBody: "Refs SHI-2\nCloses SHI-1",
      firstUserMessage: "issue SHI-3 kicked this off",
    });
    expect(result.map((r) => `${r.identifier}:${r.intent}`)).toEqual([
      "SHI-1:closes",
      "SHI-2:refs",
      "SHI-3:origin",
    ]);
  });

  it("ignores a bare origin token with no `issue` lead-in (no phantom chip)", () => {
    const result = collectPrCardIssueRefs({
      prBody: "",
      firstUserMessage: "encode as UTF-8 and target GPT-4",
    });
    expect(result).toEqual([]);
  });
});
