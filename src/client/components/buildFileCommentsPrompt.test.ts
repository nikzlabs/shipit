import { describe, it, expect } from "vitest";
import { buildFileCommentsPrompt } from "./FilePreviewModal.js";
import type { FileComment, LineComment, SectionComment } from "../../server/shared/types.js";

function line(o: Partial<LineComment>): LineComment {
  return {
    id: o.id ?? `id-${Math.random()}`,
    kind: "line",
    filePath: o.filePath ?? "src/a.ts",
    line: o.line ?? 1,
    text: o.text ?? "comment",
  };
}

function section(o: Partial<SectionComment>): SectionComment {
  return {
    id: o.id ?? `id-${Math.random()}`,
    kind: "section",
    filePath: o.filePath ?? "doc.md",
    sectionHeading: o.sectionHeading ?? "## Summary",
    sectionIndex: o.sectionIndex ?? 0,
    text: o.text ?? "comment",
  };
}

const FILE = `line one
line two
line three
line four
line five
line six
line seven
line eight
line nine
line ten`;

describe("buildFileCommentsPrompt", () => {
  it("opens with the standard preamble and closes with 'Please address each comment.'", () => {
    const out = buildFileCommentsPrompt(
      [line({ filePath: "a.ts", line: 1, text: "x" })],
      new Map([["a.ts", "hello"]]),
    );
    expect(out).toMatch(/^I have the following comments on the code:/);
    expect(out.trimEnd().endsWith("Please address each comment.")).toBe(true);
  });

  it("includes a 5-line context snippet around the commented line", () => {
    const out = buildFileCommentsPrompt(
      [line({ filePath: "f.ts", line: 5, text: "issue here" })],
      new Map([["f.ts", FILE]]),
    );
    // Lines 3..7 (start = max(0,5-3)=2, end = min(10,5+2)=7) → 5 lines
    expect(out).toContain("line three");
    expect(out).toContain("line four");
    expect(out).toContain("line five");
    expect(out).toContain("line six");
    expect(out).toContain("line seven");
    // line two should NOT be in the snippet (start at index 2 = line 3)
    expect(out).not.toContain("line two");
    // The commented line is marked with → arrow
    expect(out).toMatch(/→ 5/);
  });

  it("does not overflow past the start of the file", () => {
    const out = buildFileCommentsPrompt(
      [line({ filePath: "f.ts", line: 1, text: "first" })],
      new Map([["f.ts", FILE]]),
    );
    expect(out).toContain("line one");
    expect(out).toContain("line two");
    expect(out).toContain("line three");
  });

  it("does not overflow past the end of the file", () => {
    const out = buildFileCommentsPrompt(
      [line({ filePath: "f.ts", line: 10, text: "last" })],
      new Map([["f.ts", FILE]]),
    );
    expect(out).toContain("line ten");
    expect(out).toContain("line eight");
    expect(out).toContain("line nine");
  });

  it("sorts multiple line comments in a file by line number", () => {
    const out = buildFileCommentsPrompt(
      [
        line({ id: "b", filePath: "f.ts", line: 9, text: "second" }),
        line({ id: "a", filePath: "f.ts", line: 2, text: "first" }),
      ],
      new Map([["f.ts", FILE]]),
    );
    const idxFirst = out.indexOf("Comment: first");
    const idxSecond = out.indexOf("Comment: second");
    expect(idxFirst).toBeGreaterThan(-1);
    expect(idxSecond).toBeGreaterThan(idxFirst);
  });

  it("groups comments by file", () => {
    const out = buildFileCommentsPrompt(
      [
        line({ filePath: "a.ts", line: 1, text: "a-comment" }),
        line({ filePath: "b.ts", line: 1, text: "b-comment" }),
      ],
      new Map([["a.ts", "x"], ["b.ts", "y"]]),
    );
    expect(out).toContain("**a.ts:1**");
    expect(out).toContain("**b.ts:1**");
    expect(out).toContain("a-comment");
    expect(out).toContain("b-comment");
  });

  it("section comments reference the heading, not a line number", () => {
    const out = buildFileCommentsPrompt(
      [section({ filePath: "doc.md", sectionHeading: "## Architecture", sectionIndex: 1, text: "rethink" })],
      new Map(),
    );
    expect(out).toContain("**doc.md → ## Architecture**");
    expect(out).toContain("Comment: rethink");
  });

  it("section comments with empty heading fall back to (Introduction)", () => {
    const out = buildFileCommentsPrompt(
      [section({ filePath: "doc.md", sectionHeading: "", sectionIndex: 0, text: "intro feedback" })],
      new Map(),
    );
    expect(out).toContain("**doc.md → (Introduction)**");
  });

  it("sorts section comments by sectionIndex", () => {
    const out = buildFileCommentsPrompt(
      [
        section({ id: "a", filePath: "doc.md", sectionHeading: "## C", sectionIndex: 3, text: "third" }),
        section({ id: "b", filePath: "doc.md", sectionHeading: "## A", sectionIndex: 0, text: "first" }),
        section({ id: "c", filePath: "doc.md", sectionHeading: "## B", sectionIndex: 1, text: "second" }),
      ],
      new Map(),
    );
    const idxFirst = out.indexOf("first");
    const idxSecond = out.indexOf("second");
    const idxThird = out.indexOf("third");
    expect(idxFirst).toBeLessThan(idxSecond);
    expect(idxSecond).toBeLessThan(idxThird);
  });

  it("handles mixed line + section comments across files", () => {
    const comments: FileComment[] = [
      line({ filePath: "src/a.ts", line: 3, text: "code feedback" }),
      section({ filePath: "doc.md", sectionHeading: "## Plan", sectionIndex: 0, text: "doc feedback" }),
    ];
    const out = buildFileCommentsPrompt(comments, new Map([["src/a.ts", FILE]]));
    expect(out).toContain("Comment: code feedback");
    expect(out).toContain("Comment: doc feedback");
    expect(out).toContain("**src/a.ts:3**");
    expect(out).toContain("**doc.md → ## Plan**");
  });

  it("falls back to empty content when file is missing from the map", () => {
    const out = buildFileCommentsPrompt(
      [line({ filePath: "missing.ts", line: 1, text: "x" })],
      new Map(),
    );
    // Doesn't crash, still emits the header and comment
    expect(out).toContain("**missing.ts:1**");
    expect(out).toContain("Comment: x");
  });
});
