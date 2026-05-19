import { describe, it, expect } from "vitest";
import {
  globToRegex,
  parseWorkflowContent,
  workflowAppliesToFiles,
} from "./workflow-loader.js";

describe("globToRegex", () => {
  it("matches **/*.md against md files at any depth", () => {
    const re = globToRegex("**/*.md");
    expect(re.test("README.md")).toBe(true);
    expect(re.test("docs/intro.md")).toBe(true);
    expect(re.test("docs/sub/bar.md")).toBe(true);
    expect(re.test("README.txt")).toBe(false);
  });

  it("matches **.md against any .md file (no separator)", () => {
    const re = globToRegex("**.md");
    expect(re.test("README.md")).toBe(true);
    expect(re.test("docs/intro.md")).toBe(true);
    expect(re.test("foo.markdown")).toBe(false);
  });

  it("matches docs/** against anything under docs/", () => {
    const re = globToRegex("docs/**");
    expect(re.test("docs/foo.md")).toBe(true);
    expect(re.test("docs/sub/bar.md")).toBe(true);
    expect(re.test("src/foo.md")).toBe(false);
  });

  it("does not let single * cross slashes", () => {
    const re = globToRegex("*.md");
    expect(re.test("README.md")).toBe(true);
    expect(re.test("docs/intro.md")).toBe(false);
  });

  it("escapes regex metacharacters in literal segments", () => {
    const re = globToRegex("src/foo.bar+test/file.ts");
    expect(re.test("src/foo.bar+test/file.ts")).toBe(true);
    expect(re.test("src/fooXbar+test/file.ts")).toBe(false);
  });
});

describe("parseWorkflowContent", () => {
  it("treats `on: push` as always-applies", () => {
    const parsed = parseWorkflowContent("on: push\njobs:\n  x:\n    runs-on: ubuntu-latest");
    expect(parsed.alwaysApplies).toBe(true);
  });

  it("treats `on: [push, pull_request]` as always-applies", () => {
    const parsed = parseWorkflowContent("on: [push, pull_request]\njobs: {}");
    expect(parsed.alwaysApplies).toBe(true);
  });

  it("ignores irrelevant trigger names in the shorthand list", () => {
    const parsed = parseWorkflowContent("on: workflow_dispatch\njobs: {}");
    expect(parsed.alwaysApplies).toBe(false);
    expect(parsed.events).toEqual([]);
  });

  it("extracts paths-ignore for pull_request", () => {
    const yaml = `
on:
  pull_request:
    paths-ignore:
      - 'docs/**'
      - '**.md'
jobs: {}
`;
    const parsed = parseWorkflowContent(yaml);
    expect(parsed.alwaysApplies).toBe(false);
    expect(parsed.events).toEqual([
      { pathsInclude: [], pathsIgnore: ["docs/**", "**.md"] },
    ]);
  });

  it("extracts paths (include-list) for pull_request", () => {
    const yaml = `
on:
  pull_request:
    paths: ['src/**', 'package.json']
jobs: {}
`;
    const parsed = parseWorkflowContent(yaml);
    expect(parsed.events).toEqual([
      { pathsInclude: ["src/**", "package.json"], pathsIgnore: [] },
    ]);
  });

  it("merges filters from multiple events", () => {
    const yaml = `
on:
  push:
    paths: ['src/**']
  pull_request:
    paths-ignore: ['**.md']
jobs: {}
`;
    const parsed = parseWorkflowContent(yaml);
    expect(parsed.alwaysApplies).toBe(false);
    expect(parsed.events).toHaveLength(2);
  });

  it("sets alwaysApplies when an event is configured but has no path filter", () => {
    const yaml = `
on:
  pull_request:
    branches: [main]
jobs: {}
`;
    const parsed = parseWorkflowContent(yaml);
    expect(parsed.alwaysApplies).toBe(true);
  });

  it("sets alwaysApplies when an event is keyed but empty (`on: { pull_request: }`)", () => {
    const yaml = `on:\n  pull_request:\njobs: {}\n`;
    const parsed = parseWorkflowContent(yaml);
    expect(parsed.alwaysApplies).toBe(true);
  });

  it("falls back to alwaysApplies=true on unparseable YAML (conservative)", () => {
    // Unclosed flow mapping is a hard syntax error in YAML 1.2.
    const parsed = parseWorkflowContent("on: { pull_request: { paths: [unterminated");
    expect(parsed.alwaysApplies).toBe(true);
  });
});

describe("workflowAppliesToFiles", () => {
  it("always applies when alwaysApplies=true regardless of files", () => {
    const w = { alwaysApplies: true, events: [] };
    expect(workflowAppliesToFiles(w, ["README.md"])).toBe(true);
    expect(workflowAppliesToFiles(w, [])).toBe(true);
  });

  it("paths-ignore filter excludes all .md changes (ShipIt CI workflow case)", () => {
    const w = {
      alwaysApplies: false,
      events: [{ pathsInclude: [], pathsIgnore: ["docs/**", "**.md"] }],
    };
    expect(workflowAppliesToFiles(w, ["README.md"])).toBe(false);
    expect(workflowAppliesToFiles(w, ["docs/intro.md", "docs/sub/api.md"])).toBe(false);
    expect(workflowAppliesToFiles(w, ["README.md", "src/index.ts"])).toBe(true);
  });

  it("paths include-list: at least one changed file must match", () => {
    const w = {
      alwaysApplies: false,
      events: [{ pathsInclude: ["src/**"], pathsIgnore: [] }],
    };
    expect(workflowAppliesToFiles(w, ["README.md"])).toBe(false);
    expect(workflowAppliesToFiles(w, ["src/index.ts"])).toBe(true);
    expect(workflowAppliesToFiles(w, ["README.md", "src/index.ts"])).toBe(true);
  });

  it("combined include + ignore: file must match include AND not match ignore", () => {
    const w = {
      alwaysApplies: false,
      events: [{ pathsInclude: ["src/**"], pathsIgnore: ["src/**/*.test.ts"] }],
    };
    expect(workflowAppliesToFiles(w, ["src/index.ts"])).toBe(true);
    expect(workflowAppliesToFiles(w, ["src/foo.test.ts"])).toBe(false);
    expect(workflowAppliesToFiles(w, ["src/foo.test.ts", "src/index.ts"])).toBe(true);
  });

  it("returns true when changed-file list is empty (conservative)", () => {
    const w = {
      alwaysApplies: false,
      events: [{ pathsInclude: [], pathsIgnore: ["**.md"] }],
    };
    expect(workflowAppliesToFiles(w, [])).toBe(true);
  });
});
