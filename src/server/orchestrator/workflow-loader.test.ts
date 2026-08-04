import { describe, it, expect } from "vitest";
import {
  globToRegex,
  parseWorkflowContent,
  workflowAppliesToPr,
  type ParsedWorkflowEvent,
  type WorkflowEventName,
} from "./workflow-loader.js";

/** Build a trigger with only the filters a given test cares about. */
function ev(
  event: WorkflowEventName,
  overrides: Partial<Omit<ParsedWorkflowEvent, "event">> = {},
): ParsedWorkflowEvent {
  return {
    event,
    pathsInclude: [],
    pathsIgnore: [],
    branchesInclude: [],
    branchesIgnore: [],
    tagsOnly: false,
    ...overrides,
  };
}

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
  it("treats `on: push` as an unfiltered push trigger", () => {
    const parsed = parseWorkflowContent("on: push\njobs:\n  x:\n    runs-on: ubuntu-latest");
    expect(parsed.unparseable).toBe(false);
    expect(parsed.events).toEqual([ev("push")]);
  });

  it("treats `on: [push, pull_request]` as two unfiltered triggers", () => {
    const parsed = parseWorkflowContent("on: [push, pull_request]\njobs: {}");
    expect(parsed.events).toEqual([ev("push"), ev("pull_request")]);
  });

  it("drops irrelevant trigger names in the shorthand list", () => {
    const parsed = parseWorkflowContent("on: workflow_dispatch\njobs: {}");
    expect(parsed.unparseable).toBe(false);
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
    expect(parsed.events).toEqual([ev("pull_request", { pathsIgnore: ["docs/**", "**.md"] })]);
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
      ev("pull_request", { pathsInclude: ["src/**", "package.json"] }),
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
    expect(parsed.events).toHaveLength(2);
  });

  it("extracts branch filters alongside path filters", () => {
    const yaml = `
on:
  push:
    branches: [main, 'release/**']
    branches-ignore: ['release/legacy']
jobs: {}
`;
    const parsed = parseWorkflowContent(yaml);
    expect(parsed.events).toEqual([
      ev("push", {
        branchesInclude: ["main", "release/**"],
        branchesIgnore: ["release/legacy"],
      }),
    ]);
  });

  it("flags a tag-only push trigger (release workflow)", () => {
    const yaml = `
on:
  push:
    tags: ['v*']
jobs: {}
`;
    const parsed = parseWorkflowContent(yaml);
    expect(parsed.events).toEqual([ev("push", { tagsOnly: true })]);
  });

  it("does not flag tagsOnly when the push trigger also names branches", () => {
    const yaml = `
on:
  push:
    branches: [main]
    tags: ['v*']
jobs: {}
`;
    const parsed = parseWorkflowContent(yaml);
    expect(parsed.events).toEqual([ev("push", { branchesInclude: ["main"], tagsOnly: false })]);
  });

  it("treats an event keyed but empty (`on: { pull_request: }`) as unfiltered", () => {
    const yaml = `on:\n  pull_request:\njobs: {}\n`;
    const parsed = parseWorkflowContent(yaml);
    expect(parsed.events).toEqual([ev("pull_request")]);
  });

  it("falls back to unparseable=true on unparseable YAML (conservative)", () => {
    // Unclosed flow mapping is a hard syntax error in YAML 1.2.
    const parsed = parseWorkflowContent("on: { pull_request: { paths: [unterminated");
    expect(parsed.unparseable).toBe(true);
  });
});

describe("workflowAppliesToPr — path filters", () => {
  const pr = { headBranch: "shipit/abc", baseBranch: "main" };

  it("always applies when the workflow is unparseable, regardless of files", () => {
    const w = { unparseable: true, events: [] };
    expect(workflowAppliesToPr(w, { ...pr, changedFiles: ["README.md"] })).toBe(true);
    expect(workflowAppliesToPr(w, pr)).toBe(true);
  });

  it("paths-ignore filter excludes all .md changes (ShipIt CI workflow case)", () => {
    const w = {
      unparseable: false,
      events: [ev("pull_request", { pathsIgnore: ["docs/**", "**.md"] })],
    };
    expect(workflowAppliesToPr(w, { ...pr, changedFiles: ["README.md"] })).toBe(false);
    expect(workflowAppliesToPr(w, { ...pr, changedFiles: ["docs/intro.md", "docs/sub/api.md"] })).toBe(false);
    expect(workflowAppliesToPr(w, { ...pr, changedFiles: ["README.md", "src/index.ts"] })).toBe(true);
  });

  it("paths include-list: at least one changed file must match", () => {
    const w = { unparseable: false, events: [ev("pull_request", { pathsInclude: ["src/**"] })] };
    expect(workflowAppliesToPr(w, { ...pr, changedFiles: ["README.md"] })).toBe(false);
    expect(workflowAppliesToPr(w, { ...pr, changedFiles: ["src/index.ts"] })).toBe(true);
    expect(workflowAppliesToPr(w, { ...pr, changedFiles: ["README.md", "src/index.ts"] })).toBe(true);
  });

  it("combined include + ignore: file must match include AND not match ignore", () => {
    const w = {
      unparseable: false,
      events: [ev("pull_request", { pathsInclude: ["src/**"], pathsIgnore: ["src/**/*.test.ts"] })],
    };
    expect(workflowAppliesToPr(w, { ...pr, changedFiles: ["src/index.ts"] })).toBe(true);
    expect(workflowAppliesToPr(w, { ...pr, changedFiles: ["src/foo.test.ts"] })).toBe(false);
    expect(workflowAppliesToPr(w, { ...pr, changedFiles: ["src/foo.test.ts", "src/index.ts"] })).toBe(true);
  });

  it("returns true when the changed-file list is unavailable (conservative)", () => {
    const w = { unparseable: false, events: [ev("pull_request", { pathsIgnore: ["**.md"] })] };
    expect(workflowAppliesToPr(w, { ...pr, changedFiles: [] })).toBe(true);
    expect(workflowAppliesToPr(w, pr)).toBe(true);
  });
});

describe("workflowAppliesToPr — event and branch filters", () => {
  const pr = { headBranch: "shipit/iksdum", baseBranch: "main", changedFiles: ["src/index.ts"] };

  it("never applies when the workflow declares no PR-relevant trigger", () => {
    // `on: { workflow_dispatch: }` alone — parsed to zero relevant events.
    expect(workflowAppliesToPr({ unparseable: false, events: [] }, pr)).toBe(false);
  });

  it("does not apply when a push trigger's branches exclude the PR head branch", () => {
    // nikzlabs/shipit#1730: the repo's only workflow is manual + a push
    // trigger scoped to one non-default branch. A session-branch PR into main
    // matches nothing, so GitHub creates zero check runs — terminal from the
    // first poll, not pending.
    const w = {
      unparseable: false,
      events: [ev("push", { branchesInclude: ["deploy"] })],
    };
    expect(workflowAppliesToPr(w, pr)).toBe(false);
    expect(workflowAppliesToPr(w, { ...pr, headBranch: "deploy" })).toBe(true);
  });

  it("matches push branch filters against the head branch, not the base", () => {
    const w = { unparseable: false, events: [ev("push", { branchesInclude: ["main"] })] };
    // Base is main but the pushed ref is the session branch — no match.
    expect(workflowAppliesToPr(w, pr)).toBe(false);
  });

  it("matches pull_request branch filters against the base branch", () => {
    const w = { unparseable: false, events: [ev("pull_request", { branchesInclude: ["main"] })] };
    expect(workflowAppliesToPr(w, pr)).toBe(true);
    expect(workflowAppliesToPr(w, { ...pr, baseBranch: "develop" })).toBe(false);
  });

  it("honors branches-ignore", () => {
    const w = { unparseable: false, events: [ev("pull_request", { branchesIgnore: ["main"] })] };
    expect(workflowAppliesToPr(w, pr)).toBe(false);
    expect(workflowAppliesToPr(w, { ...pr, baseBranch: "develop" })).toBe(true);
  });

  it("supports globs in branch filters", () => {
    const w = { unparseable: false, events: [ev("push", { branchesInclude: ["shipit/**"] })] };
    expect(workflowAppliesToPr(w, pr)).toBe(true);
    expect(workflowAppliesToPr(w, { ...pr, headBranch: "feature/x" })).toBe(false);
  });

  it("never applies for a tag-only push trigger (release workflow)", () => {
    const w = { unparseable: false, events: [ev("push", { tagsOnly: true })] };
    expect(workflowAppliesToPr(w, pr)).toBe(false);
  });

  it("applies when any one trigger survives, even if others are filtered out", () => {
    const w = {
      unparseable: false,
      events: [ev("push", { branchesInclude: ["deploy"] }), ev("pull_request")],
    };
    expect(workflowAppliesToPr(w, pr)).toBe(true);
  });

  it("stays conservative when the branch is unknown", () => {
    const w = { unparseable: false, events: [ev("push", { branchesInclude: ["deploy"] })] };
    expect(workflowAppliesToPr(w, { changedFiles: ["src/index.ts"] })).toBe(true);
  });
});
