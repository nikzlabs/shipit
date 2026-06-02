import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findMarkdownFiles,
  parseChecklistProgress,
} from "./markdown.js";

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

  it("sorts un-numbered docs alphabetically (ascending) by path", async () => {
    fs.writeFileSync(path.join(tmpDir, "Z.md"), "z");
    fs.writeFileSync(path.join(tmpDir, "A.md"), "a");
    fs.writeFileSync(path.join(tmpDir, "M.md"), "m");

    const docs = await findMarkdownFiles(tmpDir);
    expect(docs.map((d) => d.path)).toEqual(["A.md", "M.md", "Z.md"]);
  });

  it("orders numbered feature dirs newest-first, prose docs last", async () => {
    // Mix feature dirs that straddle the lexical 99→100 trap with a prose doc.
    fs.mkdirSync(path.join(tmpDir, "docs", "99-old"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "docs", "99-old", "plan.md"), "# old");
    fs.mkdirSync(path.join(tmpDir, "docs", "100-new"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "docs", "100-new", "plan.md"), "# new");
    fs.writeFileSync(path.join(tmpDir, "docs", "architecture.md"), "# arch");

    const docs = await findMarkdownFiles(tmpDir);
    expect(docs.map((d) => d.path)).toEqual([
      "docs/100-new/plan.md",
      "docs/99-old/plan.md",
      "docs/architecture.md",
    ]);
  });

  it("ignores non-.md files", async () => {
    fs.writeFileSync(path.join(tmpDir, "script.ts"), "");
    fs.writeFileSync(path.join(tmpDir, "styles.css"), "");
    fs.writeFileSync(path.join(tmpDir, "data.json"), "");
    fs.writeFileSync(path.join(tmpDir, "readme.txt"), "");

    const docs = await findMarkdownFiles(tmpDir);
    expect(docs).toEqual([]);
  });

  it("returns DocEntry with issue pointer from frontmatter", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "feature.md"),
      "---\nissue: https://linear.app/shipit-ai/issue/SHI-28/decouple\n---\n# My Feature",
    );

    const docs = await findMarkdownFiles(tmpDir);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      path: "feature.md",
      issue: "https://linear.app/shipit-ai/issue/SHI-28/decouple",
      title: "Feature",
    });
  });

  it("returns DocEntry without issue for plain docs", async () => {
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# Hello World");

    const docs = await findMarkdownFiles(tmpDir);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      path: "README.md",
      issue: undefined,
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

  describe("description frontmatter", () => {
    it("parses a description from frontmatter", async () => {
      fs.writeFileSync(
        path.join(tmpDir, "plan.md"),
        "---\nstatus: done\ndescription: A short summary of the feature.\n---\n# Plan",
      );
      const docs = await findMarkdownFiles(tmpDir);
      expect(docs[0].description).toBe("A short summary of the feature.");
    });

    it("trims surrounding whitespace from the description", async () => {
      fs.writeFileSync(
        path.join(tmpDir, "plan.md"),
        "---\ndescription:   padded summary   \n---\n# Plan",
      );
      const docs = await findMarkdownFiles(tmpDir);
      expect(docs[0].description).toBe("padded summary");
    });

    it("leaves description undefined when absent", async () => {
      fs.writeFileSync(path.join(tmpDir, "plan.md"), "---\nstatus: done\n---\n# Plan");
      const docs = await findMarkdownFiles(tmpDir);
      expect(docs[0].description).toBeUndefined();
    });

    it("leaves description undefined when the value is empty", async () => {
      fs.writeFileSync(path.join(tmpDir, "plan.md"), "---\ndescription:   \n---\n# Plan");
      const docs = await findMarkdownFiles(tmpDir);
      expect(docs[0].description).toBeUndefined();
    });

    it("reads description from a checklist.md (full-read path)", async () => {
      fs.mkdirSync(path.join(tmpDir, "docs", "001-feature"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "docs", "001-feature", "checklist.md"),
        "---\ndescription: Checklist summary.\n---\n- [ ] one",
      );
      const docs = await findMarkdownFiles(tmpDir);
      expect(docs[0].description).toBe("Checklist summary.");
    });
  });

  describe("issue frontmatter", () => {
    it("parses a Linear issue URL pointer", async () => {
      const url = "https://linear.app/shipit-ai/issue/SHI-29/native-goal-command";
      fs.writeFileSync(
        path.join(tmpDir, "feature.md"),
        `---\nissue: ${url}\n---\n# Feature`,
      );
      const docs = await findMarkdownFiles(tmpDir);
      expect(docs[0].issue).toBe(url);
    });

    it("parses a GitHub owner/repo#N pointer", async () => {
      fs.writeFileSync(
        path.join(tmpDir, "feature.md"),
        "---\nissue: octocat/hello-world#42\n---\n# Feature",
      );
      const docs = await findMarkdownFiles(tmpDir);
      expect(docs[0].issue).toBe("octocat/hello-world#42");
    });

    it("trims surrounding whitespace from the pointer", async () => {
      fs.writeFileSync(
        path.join(tmpDir, "feature.md"),
        "---\nissue:    octocat/hello-world#7   \n---",
      );
      const docs = await findMarkdownFiles(tmpDir);
      expect(docs[0].issue).toBe("octocat/hello-world#7");
    });

    it("leaves issue undefined when absent", async () => {
      fs.writeFileSync(path.join(tmpDir, "feature.md"), "---\ntitle: Foo\n---\n# Feature");
      const docs = await findMarkdownFiles(tmpDir);
      expect(docs[0].issue).toBeUndefined();
    });

    it("leaves issue undefined when the value is empty", async () => {
      fs.writeFileSync(path.join(tmpDir, "feature.md"), "---\nissue:   \n---\n# Feature");
      const docs = await findMarkdownFiles(tmpDir);
      expect(docs[0].issue).toBeUndefined();
    });

    it("reads issue from a checklist.md (full-read path)", async () => {
      fs.mkdirSync(path.join(tmpDir, "docs", "001-feature"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "docs", "001-feature", "checklist.md"),
        "---\nissue: octocat/hello-world#9\n---\n- [ ] one",
      );
      const docs = await findMarkdownFiles(tmpDir);
      expect(docs[0].issue).toBe("octocat/hello-world#9");
    });

    it("does not read status/priority frontmatter (decoupled in docs/168)", async () => {
      fs.writeFileSync(
        path.join(tmpDir, "feature.md"),
        "---\nstatus: planned\npriority: high\n---\n# Feature",
      );
      const docs = await findMarkdownFiles(tmpDir);
      const doc = docs[0] as unknown as Record<string, unknown>;
      expect(doc.status).toBeUndefined();
      expect(doc.priority).toBeUndefined();
      expect(doc.customStatus).toBeUndefined();
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
