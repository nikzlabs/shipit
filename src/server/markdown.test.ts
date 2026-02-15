import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findMarkdownFiles } from "./markdown.js";

describe("findMarkdownFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-md-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns an empty array for an empty directory", async () => {
    const files = await findMarkdownFiles(tmpDir);
    expect(files).toEqual([]);
  });

  it("finds .md files in the root directory", async () => {
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# Hello");
    fs.writeFileSync(path.join(tmpDir, "CHANGELOG.md"), "# Changes");
    fs.writeFileSync(path.join(tmpDir, "app.ts"), "console.log()");

    const files = await findMarkdownFiles(tmpDir);
    expect(files).toEqual(["CHANGELOG.md", "README.md"]);
  });

  it("finds .md files in nested directories", async () => {
    fs.mkdirSync(path.join(tmpDir, "docs"));
    fs.writeFileSync(path.join(tmpDir, "docs", "setup.md"), "# Setup");
    fs.mkdirSync(path.join(tmpDir, "docs", "guides"));
    fs.writeFileSync(path.join(tmpDir, "docs", "guides", "intro.md"), "# Intro");

    const files = await findMarkdownFiles(tmpDir);
    expect(files).toEqual(["docs/guides/intro.md", "docs/setup.md"]);
  });

  it("skips node_modules directory", async () => {
    fs.mkdirSync(path.join(tmpDir, "node_modules", "some-pkg"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "node_modules", "some-pkg", "README.md"), "# pkg");
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# Main");

    const files = await findMarkdownFiles(tmpDir);
    expect(files).toEqual(["README.md"]);
  });

  it("skips .git directory", async () => {
    fs.mkdirSync(path.join(tmpDir, ".git", "refs"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".git", "description.md"), "# Git");
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# Main");

    const files = await findMarkdownFiles(tmpDir);
    expect(files).toEqual(["README.md"]);
  });

  it("returns results sorted alphabetically", async () => {
    fs.writeFileSync(path.join(tmpDir, "Z.md"), "z");
    fs.writeFileSync(path.join(tmpDir, "A.md"), "a");
    fs.writeFileSync(path.join(tmpDir, "M.md"), "m");

    const files = await findMarkdownFiles(tmpDir);
    expect(files).toEqual(["A.md", "M.md", "Z.md"]);
  });

  it("ignores non-.md files", async () => {
    fs.writeFileSync(path.join(tmpDir, "script.ts"), "");
    fs.writeFileSync(path.join(tmpDir, "styles.css"), "");
    fs.writeFileSync(path.join(tmpDir, "data.json"), "");
    fs.writeFileSync(path.join(tmpDir, "readme.txt"), "");

    const files = await findMarkdownFiles(tmpDir);
    expect(files).toEqual([]);
  });
});
