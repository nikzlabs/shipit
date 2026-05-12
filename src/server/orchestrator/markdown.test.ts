import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findMarkdownFiles,
  parseChecklistProgress,
  parseStatusFromFrontmatter,
} from "./markdown.js";

describe("parseStatusFromFrontmatter", () => {
  it("returns undefined when no frontmatter present", () => {
    expect(parseStatusFromFrontmatter("# My Feature\n\nSome description")).toBeUndefined();
  });

  it("returns undefined when frontmatter has no status", () => {
    expect(parseStatusFromFrontmatter("---\ntitle: Foo\n---\n# My Feature")).toBeUndefined();
  });

  it("parses 'planned' status", () => {
    expect(parseStatusFromFrontmatter("---\nstatus: planned\n---\n# Feature")).toBe("planned");
  });

  it("parses 'in-progress' status", () => {
    expect(parseStatusFromFrontmatter("---\nstatus: in-progress\n---\n# Feature")).toBe("in-progress");
  });

  it("parses 'done' status", () => {
    expect(parseStatusFromFrontmatter("---\nstatus: done\n---\n# Feature")).toBe("done");
  });

  it("parses 'paused' status", () => {
    expect(parseStatusFromFrontmatter("---\nstatus: paused\n---\n# Feature")).toBe("paused");
  });

  it("parses 'rejected' status", () => {
    expect(parseStatusFromFrontmatter("---\nstatus: rejected\n---\n# Feature")).toBe("rejected");
  });

  it("handles extra whitespace in status value", () => {
    expect(parseStatusFromFrontmatter("---\nstatus:   in-progress  \n---")).toBe("in-progress");
  });

  it("handles mixed case status", () => {
    expect(parseStatusFromFrontmatter("---\nstatus: Done\n---")).toBe("done");
  });

  it("returns undefined for unknown status values (caller falls back to customStatus via findMarkdownFiles)", () => {
    // parseStatusFromFrontmatter intentionally returns ONLY the closed-enum
    // values — unknown values are reported through DocEntry.customStatus,
    // not through this helper. See the "customStatus" test block in
    // findMarkdownFiles below.
    expect(parseStatusFromFrontmatter("---\nstatus: unknown-value\n---")).toBeUndefined();
  });

  it("handles frontmatter with multiple fields", () => {
    const content = "---\ntitle: My Feature\nstatus: in-progress\nauthor: test\n---\n# Feature";
    expect(parseStatusFromFrontmatter(content)).toBe("in-progress");
  });
});

describe("findMarkdownFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-md-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns an empty array for an empty directory", async () => {
    const docs = await findMarkdownFiles(tmpDir);
    expect(docs).toEqual([]);
  });

  it("finds .md files in the root directory", async () => {
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# Hello");
    fs.writeFileSync(path.join(tmpDir, "CHANGELOG.md"), "# Changes");
    fs.writeFileSync(path.join(tmpDir, "app.ts"), "console.log()");

    const docs = await findMarkdownFiles(tmpDir);
    expect(docs.map((d) => d.path)).toEqual(["CHANGELOG.md", "README.md"]);
  });

  it("finds .md files in nested directories", async () => {
    fs.mkdirSync(path.join(tmpDir, "docs"));
    fs.writeFileSync(path.join(tmpDir, "docs", "setup.md"), "# Setup");
    fs.mkdirSync(path.join(tmpDir, "docs", "guides"));
    fs.writeFileSync(path.join(tmpDir, "docs", "guides", "intro.md"), "# Intro");

    const docs = await findMarkdownFiles(tmpDir);
    expect(docs.map((d) => d.path)).toEqual(["docs/guides/intro.md", "docs/setup.md"]);
  });

  it("skips node_modules directory", async () => {
    fs.mkdirSync(path.join(tmpDir, "node_modules", "some-pkg"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "node_modules", "some-pkg", "README.md"), "# pkg");
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# Main");

    const docs = await findMarkdownFiles(tmpDir);
    expect(docs.map((d) => d.path)).toEqual(["README.md"]);
  });

  it("skips .git directory", async () => {
    fs.mkdirSync(path.join(tmpDir, ".git", "refs"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".git", "description.md"), "# Git");
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# Main");

    const docs = await findMarkdownFiles(tmpDir);
    expect(docs.map((d) => d.path)).toEqual(["README.md"]);
  });

  it("returns results sorted alphabetically by path", async () => {
    fs.writeFileSync(path.join(tmpDir, "Z.md"), "z");
    fs.writeFileSync(path.join(tmpDir, "A.md"), "a");
    fs.writeFileSync(path.join(tmpDir, "M.md"), "m");

    const docs = await findMarkdownFiles(tmpDir);
    expect(docs.map((d) => d.path)).toEqual(["A.md", "M.md", "Z.md"]);
  });

  it("ignores non-.md files", async () => {
    fs.writeFileSync(path.join(tmpDir, "script.ts"), "");
    fs.writeFileSync(path.join(tmpDir, "styles.css"), "");
    fs.writeFileSync(path.join(tmpDir, "data.json"), "");
    fs.writeFileSync(path.join(tmpDir, "readme.txt"), "");

    const docs = await findMarkdownFiles(tmpDir);
    expect(docs).toEqual([]);
  });

  it("returns DocEntry with status from frontmatter", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "feature.md"),
      "---\nstatus: in-progress\n---\n# My Feature",
    );

    const docs = await findMarkdownFiles(tmpDir);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      path: "feature.md",
      status: "in-progress",
      title: "Feature",
    });
  });

  it("returns DocEntry without status for plain docs", async () => {
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# Hello World");

    const docs = await findMarkdownFiles(tmpDir);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      path: "README.md",
      status: undefined,
      title: "README",
    });
  });

  it("returns modifiedAt as an ISO string from the file's mtime", async () => {
    const filePath = path.join(tmpDir, "feature.md");
    fs.writeFileSync(filePath, "# Feature");
    const knownMtime = new Date("2026-01-15T12:34:56.000Z");
    fs.utimesSync(filePath, knownMtime, knownMtime);

    const docs = await findMarkdownFiles(tmpDir);
    expect(docs[0].modifiedAt).toBe(knownMtime.toISOString());
  });

  it("uses frontmatter title when present", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "plan.md"),
      "---\ntitle: My Custom Title\nstatus: done\n---\n# Plan",
    );

    const docs = await findMarkdownFiles(tmpDir);
    expect(docs[0].title).toBe("My Custom Title");
  });

  it("derives title from filename when no frontmatter title", async () => {
    fs.writeFileSync(path.join(tmpDir, "my-great-doc.md"), "# Content");

    const docs = await findMarkdownFiles(tmpDir);
    expect(docs[0].title).toBe("My Great Doc");
  });

  it("derives title from parent directory for generic filenames like plan.md", async () => {
    fs.mkdirSync(path.join(tmpDir, "docs", "042-cool-feature"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "docs", "042-cool-feature", "plan.md"),
      "---\nstatus: done\n---\n# Plan",
    );

    const docs = await findMarkdownFiles(tmpDir);
    expect(docs[0].title).toBe("Cool Feature");
  });

  it("strips leading numeric prefix from directory names in title", async () => {
    fs.mkdirSync(path.join(tmpDir, "001-auth"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "001-auth", "checklist.md"), "- [ ] task");

    const docs = await findMarkdownFiles(tmpDir);
    expect(docs[0].title).toBe("Auth");
  });

  describe("customStatus", () => {
    it("captures unrecognized status values as customStatus", async () => {
      fs.writeFileSync(
        path.join(tmpDir, "experimental.md"),
        "---\nstatus: experimental\n---\n# Experimental",
      );
      const docs = await findMarkdownFiles(tmpDir);
      expect(docs[0].status).toBeUndefined();
      expect(docs[0].customStatus).toBe("experimental");
    });

    it("normalizes case and whitespace on custom status", async () => {
      fs.writeFileSync(
        path.join(tmpDir, "blocked.md"),
        "---\nstatus:   BLOCKED  \n---",
      );
      const docs = await findMarkdownFiles(tmpDir);
      expect(docs[0].customStatus).toBe("blocked");
    });

    it("does not set customStatus when status is one of the known enum values", async () => {
      fs.writeFileSync(
        path.join(tmpDir, "planned.md"),
        "---\nstatus: planned\n---",
      );
      const docs = await findMarkdownFiles(tmpDir);
      expect(docs[0].status).toBe("planned");
      expect(docs[0].customStatus).toBeUndefined();
    });

    it("leaves both status and customStatus undefined when frontmatter is absent", async () => {
      fs.writeFileSync(path.join(tmpDir, "plain.md"), "# Just content");
      const docs = await findMarkdownFiles(tmpDir);
      expect(docs[0].status).toBeUndefined();
      expect(docs[0].customStatus).toBeUndefined();
    });

    it("propagates customStatus from a sibling-aware checklist read", async () => {
      // Read path is different for `checklist.md` (full read vs. 512-byte
      // sniff), so cover it explicitly.
      fs.mkdirSync(path.join(tmpDir, "docs", "001-feature"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "docs", "001-feature", "checklist.md"),
        "---\nstatus: blocked\n---\n- [ ] one",
      );
      const docs = await findMarkdownFiles(tmpDir);
      expect(docs[0].customStatus).toBe("blocked");
    });
  });

  describe("priority frontmatter", () => {
    it("parses priority on planned docs", async () => {
      fs.writeFileSync(
        path.join(tmpDir, "feature.md"),
        "---\nstatus: planned\npriority: high\n---\n# Feature",
      );
      const docs = await findMarkdownFiles(tmpDir);
      expect(docs[0]).toMatchObject({ status: "planned", priority: "high" });
    });

    it("parses each valid priority value", async () => {
      for (const value of ["high", "medium", "low"] as const) {
        fs.writeFileSync(
          path.join(tmpDir, `${value}.md`),
          `---\nstatus: planned\npriority: ${value}\n---`,
        );
      }
      const docs = await findMarkdownFiles(tmpDir);
      const byPath = Object.fromEntries(docs.map((d) => [d.path, d]));
      expect(byPath["high.md"].priority).toBe("high");
      expect(byPath["medium.md"].priority).toBe("medium");
      expect(byPath["low.md"].priority).toBe("low");
    });

    it("normalizes case and whitespace in priority value", async () => {
      fs.writeFileSync(
        path.join(tmpDir, "feature.md"),
        "---\nstatus: planned\npriority:   HIGH  \n---",
      );
      const docs = await findMarkdownFiles(tmpDir);
      expect(docs[0].priority).toBe("high");
    });

    it("ignores invalid priority values", async () => {
      fs.writeFileSync(
        path.join(tmpDir, "feature.md"),
        "---\nstatus: planned\npriority: urgent\n---",
      );
      const docs = await findMarkdownFiles(tmpDir);
      expect(docs[0].status).toBe("planned");
      expect(docs[0].priority).toBeUndefined();
    });

    it("drops priority on non-planned docs", async () => {
      fs.writeFileSync(
        path.join(tmpDir, "in-progress.md"),
        "---\nstatus: in-progress\npriority: high\n---",
      );
      fs.writeFileSync(
        path.join(tmpDir, "done.md"),
        "---\nstatus: done\npriority: high\n---",
      );
      fs.writeFileSync(
        path.join(tmpDir, "paused.md"),
        "---\nstatus: paused\npriority: high\n---",
      );
      fs.writeFileSync(
        path.join(tmpDir, "rejected.md"),
        "---\nstatus: rejected\npriority: high\n---",
      );
      const docs = await findMarkdownFiles(tmpDir);
      for (const doc of docs) {
        expect(doc.priority).toBeUndefined();
      }
    });

    it("returns undefined priority when frontmatter omits it", async () => {
      fs.writeFileSync(
        path.join(tmpDir, "feature.md"),
        "---\nstatus: planned\n---",
      );
      const docs = await findMarkdownFiles(tmpDir);
      expect(docs[0].priority).toBeUndefined();
    });
  });

  describe("checklist progress", () => {
    it("attaches sibling checklist progress to plan.md", async () => {
      fs.mkdirSync(path.join(tmpDir, "docs", "001-feature"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "docs", "001-feature", "plan.md"),
        "---\nstatus: in-progress\n---\n# Plan",
      );
      fs.writeFileSync(
        path.join(tmpDir, "docs", "001-feature", "checklist.md"),
        "- [x] one\n- [x] two\n- [ ] three\n- [ ] four",
      );
      const docs = await findMarkdownFiles(tmpDir);
      const plan = docs.find((d) => d.path === "docs/001-feature/plan.md");
      expect(plan?.checklist).toEqual({ total: 4, done: 2 });
    });

    it("counts checkboxes at any indentation level", async () => {
      fs.mkdirSync(path.join(tmpDir, "docs", "001-feature"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "docs", "001-feature", "plan.md"),
        "---\nstatus: planned\n---",
      );
      fs.writeFileSync(
        path.join(tmpDir, "docs", "001-feature", "checklist.md"),
        "## Phase 1\n- [x] top\n  - [ ] nested\n- [X] uppercase\n* [ ] asterisk",
      );
      const docs = await findMarkdownFiles(tmpDir);
      const plan = docs.find((d) => d.path === "docs/001-feature/plan.md");
      expect(plan?.checklist).toEqual({ total: 4, done: 2 });
    });

    it("leaves plan.md without checklist when there's no sibling checklist", async () => {
      fs.mkdirSync(path.join(tmpDir, "docs", "001-feature"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "docs", "001-feature", "plan.md"),
        "---\nstatus: in-progress\n---\n# Plan",
      );
      const docs = await findMarkdownFiles(tmpDir);
      expect(docs[0].checklist).toBeUndefined();
    });

    it("an orphan checklist (no plan sibling) keeps its own checklist field", async () => {
      fs.mkdirSync(path.join(tmpDir, "docs", "001-feature"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "docs", "001-feature", "checklist.md"),
        "- [x] done\n- [ ] todo",
      );
      const docs = await findMarkdownFiles(tmpDir);
      expect(docs).toHaveLength(1);
      expect(docs[0].checklist).toEqual({ total: 2, done: 1 });
    });

    it("does not attach across directories", async () => {
      fs.mkdirSync(path.join(tmpDir, "docs", "001-a"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "docs", "002-b"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "docs", "001-a", "plan.md"),
        "---\nstatus: planned\n---",
      );
      fs.writeFileSync(
        path.join(tmpDir, "docs", "002-b", "checklist.md"),
        "- [x] one\n- [ ] two",
      );
      const docs = await findMarkdownFiles(tmpDir);
      const plan = docs.find((d) => d.path === "docs/001-a/plan.md");
      expect(plan?.checklist).toBeUndefined();
    });

    it("omits checklist on a checklist file with zero items", async () => {
      fs.mkdirSync(path.join(tmpDir, "docs", "001-feature"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "docs", "001-feature", "plan.md"),
        "---\nstatus: in-progress\n---",
      );
      fs.writeFileSync(
        path.join(tmpDir, "docs", "001-feature", "checklist.md"),
        "# Just headings\nNo checkboxes here.",
      );
      const docs = await findMarkdownFiles(tmpDir);
      for (const doc of docs) {
        expect(doc.checklist).toBeUndefined();
      }
    });
  });
});

describe("parseChecklistProgress", () => {
  it("returns 0/0 when no checkboxes are present", () => {
    expect(parseChecklistProgress("# Just text\nNo boxes.")).toEqual({ total: 0, done: 0 });
  });

  it("counts unchecked and checked items", () => {
    const content = "- [ ] one\n- [x] two\n- [ ] three";
    expect(parseChecklistProgress(content)).toEqual({ total: 3, done: 1 });
  });

  it("treats uppercase X as checked", () => {
    expect(parseChecklistProgress("- [X] yes\n- [ ] no")).toEqual({ total: 2, done: 1 });
  });

  it("counts checkboxes at any indentation level", () => {
    const content = "- [x] top\n  - [ ] nested\n    - [x] deeper";
    expect(parseChecklistProgress(content)).toEqual({ total: 3, done: 2 });
  });

  it("supports asterisk and plus bullets", () => {
    expect(parseChecklistProgress("* [x] a\n+ [ ] b")).toEqual({ total: 2, done: 1 });
  });

  it("ignores non-checkbox bullets", () => {
    const content = "- regular bullet\n- [x] real one\n- [neither]";
    expect(parseChecklistProgress(content)).toEqual({ total: 1, done: 1 });
  });
});
