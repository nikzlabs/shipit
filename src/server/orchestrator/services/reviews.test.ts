import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ReviewComment, SelectionReviewComment } from "../../shared/types.js";
import { DatabaseManager } from "../../shared/database.js";
import { FileReviewStore } from "../review-store.js";
import {
  reanchorComments,
  locateSelection,
  buildReviewPrompt,
  detectFileReviewType,
  submitAiReviewComments,
  MAX_REVIEW_COMMENTS,
  MAX_REVIEW_COMMENT_CHARS,
} from "./reviews.js";
import type { AiReviewCommentInput } from "./reviews.js";
import { ServiceError } from "./types.js";

// ---- Helpers ----

function selectionComment(
  partial: {
    id?: string;
    quotedText: string;
    contextBefore?: string;
    contextAfter?: string;
    text: string;
    source?: "human" | "ai";
  },
): SelectionReviewComment {
  return {
    id: partial.id ?? "c1",
    kind: "selection",
    quotedText: partial.quotedText,
    contextBefore: partial.contextBefore ?? "",
    contextAfter: partial.contextAfter ?? "",
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
// locateSelection
// ============================================================

describe("locateSelection", () => {
  it("returns the first occurrence when quoted text is unique", () => {
    const content = "alpha beta gamma";
    expect(locateSelection(content, { quotedText: "beta", contextBefore: "", contextAfter: "" })).toBe(6);
  });

  it("disambiguates by contextBefore/contextAfter when quoted text repeats", () => {
    const content = "the cat sat. then the cat ran.";
    const before = locateSelection(content, {
      quotedText: "cat",
      contextBefore: "the ",
      contextAfter: " sat",
    });
    const after = locateSelection(content, {
      quotedText: "cat",
      contextBefore: "the ",
      contextAfter: " ran",
    });
    expect(content.slice(before, before + 3)).toBe("cat");
    expect(content.slice(after, after + 3)).toBe("cat");
    expect(before).not.toBe(after);
  });

  it("returns -1 when quoted text is missing", () => {
    expect(locateSelection("hello world", { quotedText: "absent", contextBefore: "", contextAfter: "" })).toBe(-1);
  });

  it("falls back to the first occurrence when no occurrence matches context", () => {
    const content = "alpha beta gamma";
    const idx = locateSelection(content, {
      quotedText: "beta",
      contextBefore: "wrong",
      contextAfter: "context",
    });
    expect(idx).toBe(6);
  });
});

// ============================================================
// reanchorComments
// ============================================================

describe("reanchorComments", () => {
  it("anchors selections whose quoted text appears in the body", () => {
    const content = "## Overview\n\nThis section is good.\n\n## Details\n\nMore content here.";
    const comments = [
      selectionComment({ id: "c1", quotedText: "good", text: "feedback A" }),
      selectionComment({ id: "c2", quotedText: "More content", text: "feedback B" }),
    ];

    const result = reanchorComments(comments, content);

    expect(result.anchored).toHaveLength(2);
    expect(result.orphaned).toHaveLength(0);
  });

  it("orphans selections whose quoted text is gone", () => {
    const content = "## Overview\n\nThis section is good.";
    const comments = [
      selectionComment({ id: "c1", quotedText: "good", text: "feedback" }),
      selectionComment({ id: "c2", quotedText: "deleted phrase", text: "stale feedback" }),
    ];

    const result = reanchorComments(comments, content);

    expect(result.anchored).toHaveLength(1);
    expect(result.orphaned).toHaveLength(1);
    expect(result.orphaned[0]!.quotedText).toBe("deleted phrase");
  });

  it("always anchors line comments — they aren't affected by markdown drift", () => {
    const comments = [
      lineComment({ id: "c1", line: 10, text: "fix me" }),
      lineComment({ id: "c2", line: 20, text: "rename" }),
    ];
    const result = reanchorComments(comments, "");
    expect(result.lines).toHaveLength(2);
    expect(result.anchored).toHaveLength(0);
    expect(result.orphaned).toHaveLength(0);
  });
});

// ============================================================
// buildReviewPrompt — markdown
// ============================================================

describe("buildReviewPrompt (markdown)", () => {
  const CONTENT = [
    "## Overview",
    "Scope is unclear.",
    "",
    "## Architecture",
    "Needs a diagram here.",
  ].join("\n");

  it("embeds each comment with the quoted text it anchors to", () => {
    const comments = [
      selectionComment({ id: "c1", quotedText: "Scope is unclear", text: "Clarify scope" }),
      selectionComment({ id: "c2", quotedText: "Needs a diagram", text: "Add the diagram" }),
    ];

    const prompt = buildReviewPrompt("docs/001-feature/plan.md", "markdown", comments, CONTENT);

    expect(prompt).toContain("> Scope is unclear");
    expect(prompt).toContain("Clarify scope");
    expect(prompt).toContain("> Needs a diagram");
    expect(prompt).toContain("Add the diagram");
    expect(prompt).toContain("docs/001-feature/plan.md");
    expect(prompt).not.toContain("removed/edited text");
  });

  it("places orphaned comments under a dedicated heading", () => {
    const comments = [
      selectionComment({ id: "c1", quotedText: "Scope is unclear", text: "Clarify" }),
      selectionComment({ id: "c2", quotedText: "deleted phrase", text: "Was important" }),
    ];

    const prompt = buildReviewPrompt("plan.md", "markdown", comments, CONTENT);

    expect(prompt).toContain("### Comments on removed/edited text");
    expect(prompt).toContain("«deleted phrase»");
    expect(prompt).toContain("Was important");
  });

  it("orders anchored comments by their position in the document", () => {
    const comments = [
      selectionComment({ id: "c2", quotedText: "Needs a diagram", text: "second" }),
      selectionComment({ id: "c1", quotedText: "Scope is unclear", text: "first" }),
    ];

    const prompt = buildReviewPrompt("plan.md", "markdown", comments, CONTENT);

    const idxFirst = prompt.indexOf("first");
    const idxSecond = prompt.indexOf("second");
    expect(idxFirst).toBeGreaterThan(0);
    expect(idxSecond).toBeGreaterThan(idxFirst);
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

    const prompt = buildReviewPrompt("src/foo.ts", "code", comments, fileContent);

    const idxFirst = prompt.indexOf("first comment");
    const idxSecond = prompt.indexOf("second comment");
    expect(idxFirst).toBeGreaterThan(0);
    expect(idxSecond).toBeGreaterThan(idxFirst);

    expect(prompt).toContain("→ 3 │ line 3");
    expect(prompt).toContain("**src/foo.ts:3**");
    expect(prompt).toContain("→ 7 │ line 7");
  });

  it("clamps the snippet to file boundaries when comment is near the start", () => {
    const fileContent = "a\nb\nc\nd\ne";
    const comments = [lineComment({ id: "c1", line: 1, text: "first" })];

    const prompt = buildReviewPrompt("a.ts", "code", comments, fileContent);
    expect(prompt).toContain("→ 1 │ a");
    expect(prompt).not.toContain(" 0 │");
  });

  it("ends with instruction to address each comment", () => {
    const prompt = buildReviewPrompt(
      "src/foo.ts",
      "code",
      [lineComment({ line: 1, text: "fix" })],
      "x",
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
  const MARKDOWN = ["## Overview", "Intro paragraph.", "", "## Architecture", "Body content."].join("\n");

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
    store.createDraft("s1", FILE, "markdown", "h");
  }

  it("forces source:ai server-side and persists into the existing draft", async () => {
    seedDraft();
    const comments: AiReviewCommentInput[] = [
      { kind: "selection", quoted_text: "Body content", text: "tighten this" },
    ];
    const result = await submitAiReviewComments(store, "s1", FILE, workspaceDir, comments);

    expect(result.added).toBe(1);
    expect(result.review.comments).toHaveLength(1);
    expect(result.review.comments[0]!.source).toBe("ai");
  });

  it("counts comments whose quoted text is missing as outdated but still persists them", async () => {
    seedDraft();
    const comments: AiReviewCommentInput[] = [
      { kind: "selection", quoted_text: "phrase that no longer exists", text: "stale" },
    ];
    const result = await submitAiReviewComments(store, "s1", FILE, workspaceDir, comments);
    expect(result.outdated).toBe(1);
    expect(result.review.comments).toHaveLength(1);
  });

  it("rejects when the draft was sent during the review run", async () => {
    seedDraft();
    const draft = store.getDraft("s1", FILE)!;
    store.addSelectionComment(draft.id, "Intro paragraph", "", "", "human note", "human");
    store.markSent(draft.id);

    await expect(
      submitAiReviewComments(store, "s1", FILE, workspaceDir, [
        { kind: "selection", quoted_text: "Intro paragraph", text: "late" },
      ]),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("ensures a fresh draft when none exists (modal closed mid-review)", async () => {
    const result = await submitAiReviewComments(store, "s1", FILE, workspaceDir, [
      { kind: "selection", quoted_text: "Intro paragraph", text: "fresh" },
    ]);
    expect(result.added).toBe(1);
    expect(store.getDraft("s1", FILE)).not.toBeNull();
  });

  it("rejects an oversize payload (too many comments)", async () => {
    seedDraft();
    const tooMany: AiReviewCommentInput[] = Array.from({ length: MAX_REVIEW_COMMENTS + 1 }, () => ({
      kind: "selection" as const,
      quoted_text: "Intro paragraph",
      text: "x",
    }));
    await expect(
      submitAiReviewComments(store, "s1", FILE, workspaceDir, tooMany),
    ).rejects.toBeInstanceOf(ServiceError);
  });

  it("rejects a comment whose text exceeds the per-comment limit", async () => {
    seedDraft();
    const big: AiReviewCommentInput[] = [
      { kind: "selection", quoted_text: "Intro paragraph", text: "x".repeat(MAX_REVIEW_COMMENT_CHARS + 1) },
    ];
    await expect(
      submitAiReviewComments(store, "s1", FILE, workspaceDir, big),
    ).rejects.toBeInstanceOf(ServiceError);
  });
});
