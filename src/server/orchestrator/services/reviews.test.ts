import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ReviewComment } from "../../shared/types.js";
import { DatabaseManager } from "../../shared/database.js";
import { FileReviewStore } from "../review-store.js";
import {
  parseMarkdownSections,
  reanchorComments,
  buildReviewPrompt,
  detectFileReviewType,
  submitAiReviewComments,
  MAX_REVIEW_COMMENTS,
  MAX_REVIEW_COMMENT_CHARS,
} from "./reviews.js";
import type { AiReviewCommentInput } from "./reviews.js";
import { ServiceError } from "./types.js";

// ---- Helpers ----

function sectionComment(
  partial: { id?: string; sectionHeading: string; sectionIndex?: number; text: string; source?: "human" | "ai" },
): ReviewComment {
  return {
    id: partial.id ?? "c1",
    kind: "section",
    sectionHeading: partial.sectionHeading,
    sectionIndex: partial.sectionIndex ?? 0,
    text: partial.text,
    source: partial.source ?? "human",
  };
}

function lineComment(
  partial: { id?: string; line: number; text: string; source?: "human" | "ai" },
): ReviewComment {
  return {
    id: partial.id ?? "c1",
    kind: "line",
    line: partial.line,
    text: partial.text,
    source: partial.source ?? "human",
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
    expect(sections[1]!.heading).toBe("## Architecture");
    expect(sections[1]!.index).toBe(1);
  });

  it("captures preamble (content before first heading) as a section with empty heading", () => {
    const md = "Intro paragraph.\n\n## First Section\nBody.";
    const sections = parseMarkdownSections(md);

    expect(sections).toHaveLength(2);
    expect(sections[0]!.heading).toBe("");
    expect(sections[0]!.rawContent).toContain("Intro paragraph.");
    expect(sections[1]!.heading).toBe("## First Section");
  });

  it("returns an empty array for empty content", () => {
    expect(parseMarkdownSections("")).toEqual([]);
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
// detectFileReviewType
// ============================================================

describe("detectFileReviewType", () => {
  it("detects markdown files by extension", () => {
    expect(detectFileReviewType("docs/foo/plan.md")).toBe("markdown");
    expect(detectFileReviewType("README.MD")).toBe("markdown");
    expect(detectFileReviewType("notes.markdown")).toBe("markdown");
    expect(detectFileReviewType("page.mdx")).toBe("markdown");
  });

  it("treats everything else as code", () => {
    expect(detectFileReviewType("src/foo.ts")).toBe("code");
    expect(detectFileReviewType("Makefile")).toBe("code");
    expect(detectFileReviewType("a/b.json")).toBe("code");
  });
});

// ============================================================
// reanchorComments
// ============================================================

describe("reanchorComments", () => {
  it("anchors all comments when headings are unchanged", () => {
    const headings = ["## Overview", "## Architecture"];
    const comments = [
      sectionComment({ id: "c1", sectionHeading: "## Overview", sectionIndex: 0, text: "Good" }),
      sectionComment({ id: "c2", sectionHeading: "## Architecture", sectionIndex: 1, text: "Needs work" }),
    ];

    const result = reanchorComments(comments, headings);

    expect(result.anchored).toHaveLength(2);
    expect(result.orphaned).toHaveLength(0);
  });

  it("re-anchors comments when sections are reordered", () => {
    const newHeadings = ["## Architecture", "## Overview"];
    const comments = [
      sectionComment({ id: "c1", sectionHeading: "## Overview", sectionIndex: 0, text: "A" }),
      sectionComment({ id: "c2", sectionHeading: "## Architecture", sectionIndex: 1, text: "B" }),
    ];

    const result = reanchorComments(comments, newHeadings);

    expect(result.anchored).toHaveLength(2);
    const overview = result.anchored.find((c) => c.kind === "section" && c.sectionHeading === "## Overview");
    expect(overview?.kind === "section" ? overview.sectionIndex : -1).toBe(1);
  });

  it("orphans comments whose section was deleted", () => {
    const newHeadings = ["## Overview"];
    const comments = [
      sectionComment({ id: "c1", sectionHeading: "## Overview", sectionIndex: 0, text: "A" }),
      sectionComment({ id: "c2", sectionHeading: "## Deleted Section", sectionIndex: 1, text: "B" }),
    ];

    const result = reanchorComments(comments, newHeadings);

    expect(result.anchored).toHaveLength(1);
    expect(result.orphaned).toHaveLength(1);
  });

  it("always anchors line comments — they are not affected by markdown drift", () => {
    const comments = [
      lineComment({ id: "c1", line: 10, text: "fix me" }),
      lineComment({ id: "c2", line: 20, text: "rename" }),
    ];
    const result = reanchorComments(comments, []);
    expect(result.anchored).toHaveLength(2);
    expect(result.orphaned).toHaveLength(0);
  });

  it("anchors preamble comments to index 0 even when no headings exist", () => {
    const comments = [sectionComment({ id: "c1", sectionHeading: "", sectionIndex: 5, text: "Preamble" })];
    const result = reanchorComments(comments, []);

    expect(result.anchored).toHaveLength(1);
    const c = result.anchored[0];
    expect(c.kind === "section" ? c.sectionIndex : -1).toBe(0);
  });
});

// ============================================================
// buildReviewPrompt — markdown
// ============================================================

describe("buildReviewPrompt (markdown)", () => {
  it("groups comments by section heading", () => {
    const comments = [
      sectionComment({ id: "c1", sectionHeading: "## Overview", sectionIndex: 0, text: "Clarify scope" }),
      sectionComment({ id: "c2", sectionHeading: "## Architecture", sectionIndex: 1, text: "Add diagram" }),
      sectionComment({ id: "c3", sectionHeading: "## Overview", sectionIndex: 0, text: "Define terms" }),
    ];

    const prompt = buildReviewPrompt(
      "docs/001-feature/plan.md",
      "markdown",
      comments,
      "",
      ["## Overview", "## Architecture"],
    );

    expect(prompt).toContain("### ## Overview");
    expect(prompt).toContain("- Clarify scope");
    expect(prompt).toContain("- Define terms");
    expect(prompt).toContain("### ## Architecture");
    expect(prompt).toContain("- Add diagram");
    expect(prompt).toContain("docs/001-feature/plan.md");
    expect(prompt).not.toContain("removed/renamed");
  });

  it("places orphaned comments under removed/renamed sections heading", () => {
    const comments = [
      sectionComment({ id: "c1", sectionHeading: "## Overview", sectionIndex: 0, text: "Good" }),
      sectionComment({ id: "c2", sectionHeading: "## Deleted", sectionIndex: 1, text: "Was important" }),
    ];

    const prompt = buildReviewPrompt("plan.md", "markdown", comments, "", ["## Overview"]);

    expect(prompt).toContain("### Comments on removed/renamed sections");
    expect(prompt).toContain("(was: ## Deleted) Was important");
  });

  it("includes both human and AI comments", () => {
    const comments = [
      sectionComment({ id: "c1", sectionHeading: "## Design", text: "Human feedback", source: "human" }),
      sectionComment({ id: "c2", sectionHeading: "## Design", text: "AI feedback", source: "ai" }),
    ];

    const prompt = buildReviewPrompt("plan.md", "markdown", comments, "", ["## Design"]);
    expect(prompt).toContain("- Human feedback");
    expect(prompt).toContain("- AI feedback");
  });

  it("uses (Introduction) label for preamble comments", () => {
    const comments = [
      sectionComment({ id: "c1", sectionHeading: "", sectionIndex: 0, text: "General note" }),
    ];

    const prompt = buildReviewPrompt("plan.md", "markdown", comments, "", ["## Something"]);
    expect(prompt).toContain("### (Introduction)");
    expect(prompt).toContain("- General note");
  });
});

// ============================================================
// buildReviewPrompt — code
// ============================================================

describe("buildReviewPrompt (code)", () => {
  it("emits per-line snippets sorted by line number", () => {
    const fileContent = [
      "line 1",
      "line 2",
      "line 3",
      "line 4",
      "line 5",
      "line 6",
      "line 7",
      "line 8",
    ].join("\n");
    const comments = [
      lineComment({ id: "c2", line: 7, text: "second comment" }),
      lineComment({ id: "c1", line: 3, text: "first comment" }),
    ];

    const prompt = buildReviewPrompt("src/foo.ts", "code", comments, fileContent, []);

    // Comments are sorted by line number
    const idxFirst = prompt.indexOf("first comment");
    const idxSecond = prompt.indexOf("second comment");
    expect(idxFirst).toBeGreaterThan(0);
    expect(idxSecond).toBeGreaterThan(idxFirst);

    // Snippet for line 3 should include lines 1-5 with arrow on line 3
    expect(prompt).toContain("→ 3 │ line 3");
    expect(prompt).toContain("**src/foo.ts:3**");
    // Snippet for line 7 should include lines 5-8
    expect(prompt).toContain("→ 7 │ line 7");
  });

  it("clamps the snippet to file boundaries when comment is near the start", () => {
    const fileContent = "a\nb\nc\nd\ne";
    const comments = [lineComment({ id: "c1", line: 1, text: "first" })];

    const prompt = buildReviewPrompt("a.ts", "code", comments, fileContent, []);
    expect(prompt).toContain("→ 1 │ a");
    // Should not show line 0
    expect(prompt).not.toContain(" 0 │");
  });

  it("ends with instruction to address each comment", () => {
    const prompt = buildReviewPrompt(
      "src/foo.ts",
      "code",
      [lineComment({ line: 1, text: "fix" })],
      "x",
      [],
    );
    expect(prompt).toContain("Please address each comment.");
  });
});

// ============================================================
// submitAiReviewComments (docs/125 — chat-native AI review write-back)
// ============================================================

describe("submitAiReviewComments", () => {
  let dbManager: DatabaseManager;
  let store: FileReviewStore;
  let workspaceDir: string;
  const FILE = "docs/001-foo/plan.md";
  const MARKDOWN = ["## Overview", "Intro.", "", "## Architecture", "Body."].join("\n");

  beforeEach(() => {
    dbManager = new DatabaseManager(":memory:");
    store = new FileReviewStore(dbManager);
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-submit-"));
    fs.mkdirSync(path.join(workspaceDir, "docs/001-foo"), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, FILE), MARKDOWN);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  function seedDraft(): void {
    store.createDraft("s1", FILE, "markdown", "h", ["## Overview", "## Architecture"]);
  }

  it("forces source:ai server-side and persists into the existing draft", async () => {
    seedDraft();
    const comments: AiReviewCommentInput[] = [
      { kind: "section", section_heading: "## Architecture", section_index: 1, text: "tighten this" },
    ];
    const result = await submitAiReviewComments(store, "s1", FILE, workspaceDir, comments);

    expect(result.added).toBe(1);
    expect(result.review.comments).toHaveLength(1);
    expect(result.review.comments[0]!.source).toBe("ai");
  });

  it("re-anchors section comments against the CURRENT file, not a cached snapshot", async () => {
    // Draft was created with stale headings; the agent passes a wrong index.
    store.createDraft("s1", FILE, "markdown", "h", ["## Overview"]);
    const comments: AiReviewCommentInput[] = [
      { kind: "section", section_heading: "## Architecture", section_index: 99, text: "x" },
    ];
    const result = await submitAiReviewComments(store, "s1", FILE, workspaceDir, comments);

    const c = result.review.comments[0]!;
    expect(c.kind).toBe("section");
    if (c.kind === "section") {
      // "## Architecture" is index 1 in the current file — not the bogus 99.
      expect(c.sectionIndex).toBe(1);
    }
    expect(result.outdated).toBe(0);
  });

  it("counts a comment on a vanished section as outdated but still persists it", async () => {
    seedDraft();
    const comments: AiReviewCommentInput[] = [
      { kind: "section", section_heading: "## Removed", section_index: 0, text: "stale" },
    ];
    const result = await submitAiReviewComments(store, "s1", FILE, workspaceDir, comments);
    expect(result.outdated).toBe(1);
    expect(result.review.comments).toHaveLength(1);
  });

  it("rejects when the draft was sent during the review run", async () => {
    seedDraft();
    const draft = store.getDraft("s1", FILE)!;
    store.addSectionComment(draft.id, "## Overview", 0, "human note", "human");
    store.markSent(draft.id);

    await expect(
      submitAiReviewComments(store, "s1", FILE, workspaceDir, [
        { kind: "section", section_heading: "## Overview", section_index: 0, text: "late" },
      ]),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("ensures a fresh draft when none exists (modal closed mid-review)", async () => {
    // No draft and no prior review at all.
    const result = await submitAiReviewComments(store, "s1", FILE, workspaceDir, [
      { kind: "section", section_heading: "## Overview", section_index: 0, text: "fresh" },
    ]);
    expect(result.added).toBe(1);
    expect(store.getDraft("s1", FILE)).not.toBeNull();
  });

  it("rejects an oversize payload (too many comments)", async () => {
    seedDraft();
    const tooMany: AiReviewCommentInput[] = Array.from({ length: MAX_REVIEW_COMMENTS + 1 }, () => ({
      kind: "section" as const,
      section_heading: "## Overview",
      section_index: 0,
      text: "x",
    }));
    await expect(
      submitAiReviewComments(store, "s1", FILE, workspaceDir, tooMany),
    ).rejects.toBeInstanceOf(ServiceError);
  });

  it("rejects a comment whose text exceeds the per-comment limit", async () => {
    seedDraft();
    const big: AiReviewCommentInput[] = [
      { kind: "section", section_heading: "## Overview", section_index: 0, text: "x".repeat(MAX_REVIEW_COMMENT_CHARS + 1) },
    ];
    await expect(
      submitAiReviewComments(store, "s1", FILE, workspaceDir, big),
    ).rejects.toBeInstanceOf(ServiceError);
  });
});
