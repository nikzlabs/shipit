import { describe, it, expect } from "vitest";
import type { ReviewComment } from "../../shared/types.js";
import { parseMarkdownSections, reanchorComments, buildReviewPrompt } from "./reviews.js";

// ---- Helper to build a ReviewComment ----

function makeComment(
  overrides: Partial<ReviewComment> & Pick<ReviewComment, "sectionHeading" | "text">,
): ReviewComment {
  return {
    id: overrides.id ?? "c1",
    sectionIndex: overrides.sectionIndex ?? 0,
    source: overrides.source ?? "human",
    ...overrides,
  };
}

// ============================================================
// parseMarkdownSections
// ============================================================

describe("parseMarkdownSections", () => {
  it("parses multiple ## headings into separate sections", () => {
    const md = [
      "## Overview",
      "Some overview text.",
      "",
      "## Architecture",
      "Details here.",
    ].join("\n");

    const sections = parseMarkdownSections(md);

    expect(sections).toHaveLength(2);
    expect(sections[0]!.heading).toBe("## Overview");
    expect(sections[0]!.index).toBe(0);
    expect(sections[0]!.rawContent).toContain("Some overview text.");
    expect(sections[1]!.heading).toBe("## Architecture");
    expect(sections[1]!.index).toBe(1);
    expect(sections[1]!.rawContent).toContain("Details here.");
  });

  it("captures preamble (content before first heading) as a section with empty heading", () => {
    const md = [
      "---",
      "status: done",
      "---",
      "",
      "Intro paragraph.",
      "",
      "## First Section",
      "Body.",
    ].join("\n");

    const sections = parseMarkdownSections(md);

    expect(sections).toHaveLength(2);
    expect(sections[0]!.heading).toBe("");
    expect(sections[0]!.rawContent).toContain("Intro paragraph.");
    expect(sections[0]!.index).toBe(0);
    expect(sections[1]!.heading).toBe("## First Section");
    expect(sections[1]!.index).toBe(1);
  });

  it("returns an empty array for empty content", () => {
    expect(parseMarkdownSections("")).toEqual([]);
  });

  it("returns a single preamble section when no headings exist", () => {
    const md = "Just a paragraph.\nAnother line.";
    const sections = parseMarkdownSections(md);

    expect(sections).toHaveLength(1);
    expect(sections[0]!.heading).toBe("");
    expect(sections[0]!.rawContent).toContain("Just a paragraph.");
  });

  it("handles consecutive headings with no body between them", () => {
    const md = "## A\n## B\n## C\n";
    const sections = parseMarkdownSections(md);

    expect(sections).toHaveLength(3);
    expect(sections.map((s) => s.heading)).toEqual(["## A", "## B", "## C"]);
    expect(sections.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it("does not treat ### (h3) as a section boundary", () => {
    const md = "## Parent\n### Child\nContent.";
    const sections = parseMarkdownSections(md);

    expect(sections).toHaveLength(1);
    expect(sections[0]!.heading).toBe("## Parent");
    expect(sections[0]!.rawContent).toContain("### Child");
  });
});

// ============================================================
// reanchorComments
// ============================================================

describe("reanchorComments", () => {
  it("anchors all comments when headings are unchanged", () => {
    const headings = ["## Overview", "## Architecture"];
    const comments = [
      makeComment({ id: "c1", sectionHeading: "## Overview", sectionIndex: 0, text: "Good" }),
      makeComment({ id: "c2", sectionHeading: "## Architecture", sectionIndex: 1, text: "Needs work" }),
    ];

    const result = reanchorComments(comments, headings);

    expect(result.anchored).toHaveLength(2);
    expect(result.orphaned).toHaveLength(0);
    expect(result.anchored[0]!.sectionIndex).toBe(0);
    expect(result.anchored[1]!.sectionIndex).toBe(1);
  });

  it("re-anchors comments when sections are reordered", () => {
    // Original order: Overview(0), Architecture(1)
    // New order: Architecture(0), Overview(1)
    const newHeadings = ["## Architecture", "## Overview"];
    const comments = [
      makeComment({ id: "c1", sectionHeading: "## Overview", sectionIndex: 0, text: "A" }),
      makeComment({ id: "c2", sectionHeading: "## Architecture", sectionIndex: 1, text: "B" }),
    ];

    const result = reanchorComments(comments, newHeadings);

    expect(result.anchored).toHaveLength(2);
    expect(result.orphaned).toHaveLength(0);
    // Overview is now at index 1
    expect(result.anchored[0]!.sectionHeading).toBe("## Overview");
    expect(result.anchored[0]!.sectionIndex).toBe(1);
    // Architecture is now at index 0
    expect(result.anchored[1]!.sectionHeading).toBe("## Architecture");
    expect(result.anchored[1]!.sectionIndex).toBe(0);
  });

  it("orphans comments whose section was deleted", () => {
    const newHeadings = ["## Overview"];
    const comments = [
      makeComment({ id: "c1", sectionHeading: "## Overview", sectionIndex: 0, text: "A" }),
      makeComment({ id: "c2", sectionHeading: "## Deleted Section", sectionIndex: 1, text: "B" }),
    ];

    const result = reanchorComments(comments, newHeadings);

    expect(result.anchored).toHaveLength(1);
    expect(result.anchored[0]!.sectionHeading).toBe("## Overview");
    expect(result.orphaned).toHaveLength(1);
    expect(result.orphaned[0]!.sectionHeading).toBe("## Deleted Section");
  });

  it("leaves existing comments unaffected when a new section is added", () => {
    const newHeadings = ["## Overview", "## New Section", "## Architecture"];
    const comments = [
      makeComment({ id: "c1", sectionHeading: "## Overview", sectionIndex: 0, text: "A" }),
      makeComment({ id: "c2", sectionHeading: "## Architecture", sectionIndex: 1, text: "B" }),
    ];

    const result = reanchorComments(comments, newHeadings);

    expect(result.anchored).toHaveLength(2);
    expect(result.orphaned).toHaveLength(0);
    // Overview stays at 0
    expect(result.anchored[0]!.sectionIndex).toBe(0);
    // Architecture moved to index 2
    expect(result.anchored[1]!.sectionIndex).toBe(2);
  });

  it("always anchors preamble comments (empty heading) to index 0", () => {
    const newHeadings = ["## Something"];
    const comments = [
      makeComment({ id: "c1", sectionHeading: "", sectionIndex: 99, text: "Preamble note" }),
    ];

    const result = reanchorComments(comments, newHeadings);

    expect(result.anchored).toHaveLength(1);
    expect(result.orphaned).toHaveLength(0);
    expect(result.anchored[0]!.sectionHeading).toBe("");
    expect(result.anchored[0]!.sectionIndex).toBe(0);
  });

  it("anchors preamble comments even when headings list is empty", () => {
    const comments = [
      makeComment({ id: "c1", sectionHeading: "", sectionIndex: 5, text: "Preamble" }),
    ];

    const result = reanchorComments(comments, []);

    expect(result.anchored).toHaveLength(1);
    expect(result.anchored[0]!.sectionIndex).toBe(0);
    expect(result.orphaned).toHaveLength(0);
  });
});

// ============================================================
// buildReviewPrompt
// ============================================================

describe("buildReviewPrompt", () => {
  it("groups comments by section heading", () => {
    const comments = [
      makeComment({ id: "c1", sectionHeading: "## Overview", sectionIndex: 0, text: "Clarify scope" }),
      makeComment({ id: "c2", sectionHeading: "## Architecture", sectionIndex: 1, text: "Add diagram" }),
      makeComment({ id: "c3", sectionHeading: "## Overview", sectionIndex: 0, text: "Define terms" }),
    ];
    const headings = ["## Overview", "## Architecture"];

    const prompt = buildReviewPrompt("docs/001-feature/plan.md", comments, headings);

    // Overview section should contain both comments
    expect(prompt).toContain("### ## Overview");
    expect(prompt).toContain("- Clarify scope");
    expect(prompt).toContain("- Define terms");
    // Architecture section
    expect(prompt).toContain("### ## Architecture");
    expect(prompt).toContain("- Add diagram");
    // Path in preamble
    expect(prompt).toContain("docs/001-feature/plan.md");
    // No orphaned section
    expect(prompt).not.toContain("removed/renamed");
  });

  it("places orphaned comments under removed/renamed sections heading", () => {
    const comments = [
      makeComment({ id: "c1", sectionHeading: "## Overview", sectionIndex: 0, text: "Good" }),
      makeComment({ id: "c2", sectionHeading: "## Deleted", sectionIndex: 1, text: "Was important" }),
    ];
    const headings = ["## Overview"]; // "## Deleted" no longer exists

    const prompt = buildReviewPrompt("plan.md", comments, headings);

    expect(prompt).toContain("### Comments on removed/renamed sections");
    expect(prompt).toContain("(was: ## Deleted) Was important");
    // Anchored comment still present
    expect(prompt).toContain("### ## Overview");
    expect(prompt).toContain("- Good");
  });

  it("includes both human and AI comments", () => {
    const comments = [
      makeComment({ id: "c1", sectionHeading: "## Design", sectionIndex: 0, text: "Human feedback", source: "human" }),
      makeComment({ id: "c2", sectionHeading: "## Design", sectionIndex: 0, text: "AI feedback", source: "ai" }),
    ];
    const headings = ["## Design"];

    const prompt = buildReviewPrompt("plan.md", comments, headings);

    expect(prompt).toContain("- Human feedback");
    expect(prompt).toContain("- AI feedback");
  });

  it("uses (Introduction) label for preamble comments", () => {
    const comments = [
      makeComment({ id: "c1", sectionHeading: "", sectionIndex: 0, text: "General note" }),
    ];

    const prompt = buildReviewPrompt("plan.md", comments, ["## Something"]);

    expect(prompt).toContain("### (Introduction)");
    expect(prompt).toContain("- General note");
  });

  it("ends with instruction to address feedback", () => {
    const comments = [
      makeComment({ id: "c1", sectionHeading: "## A", sectionIndex: 0, text: "Fix this" }),
    ];

    const prompt = buildReviewPrompt("plan.md", comments, ["## A"]);

    expect(prompt).toContain("Please read the design doc, address each piece of feedback");
    expect(prompt).toContain("explain what you changed");
  });

  it("handles only orphaned comments (all sections deleted)", () => {
    const comments = [
      makeComment({ id: "c1", sectionHeading: "## Gone", sectionIndex: 0, text: "Still relevant?" }),
    ];

    const prompt = buildReviewPrompt("plan.md", comments, []);

    expect(prompt).toContain("### Comments on removed/renamed sections");
    expect(prompt).toContain("(was: ## Gone) Still relevant?");
  });
});
