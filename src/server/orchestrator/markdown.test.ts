import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findMarkdownFiles, parseStatusFromFrontmatter } from "./markdown.js";

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

  it("handles extra whitespace in status value", () => {
    expect(parseStatusFromFrontmatter("---\nstatus:   in-progress  \n---")).toBe("in-progress");
  });

  it("handles mixed case status", () => {
    expect(parseStatusFromFrontmatter("---\nstatus: Done\n---")).toBe("done");
  });

  it("returns undefined for unknown status values", () => {
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
});
