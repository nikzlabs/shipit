import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

import { GitManager } from "../../shared/git.js";
import { compactPathLabel, computeNotableFiles, notableFilesForBranch } from "./notable-files.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync("/tmp/shipit-notable-files-test-");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("compactPathLabel", () => {
  it("shortens a NNN- feature directory to its number", () => {
    expect(compactPathLabel("docs/246-native-issue-tracker-evaluation/plan.md"))
      .toBe("246/plan.md");
  });

  it("keeps a non-numbered parent directory verbatim", () => {
    expect(compactPathLabel("src/server/shipit-docs/environment.md"))
      .toBe("shipit-docs/environment.md");
  });

  it("uses only the immediate parent of a deeply nested path", () => {
    expect(compactPathLabel("a/b/c/d/e/notes.md")).toBe("e/notes.md");
  });

  it("labels a repo-root file with its bare basename", () => {
    expect(compactPathLabel("shipit.yaml")).toBe("shipit.yaml");
    expect(compactPathLabel("NOTES.md")).toBe("NOTES.md");
  });

  it("keeps an all-numeric parent (no NNN- prefix to strip)", () => {
    expect(compactPathLabel("docs/123/plan.md")).toBe("123/plan.md");
  });
});

describe("computeNotableFiles — classification", () => {
  it("labels a .md doc by its compact path, ignoring any frontmatter title", () => {
    const docPath = "docs/205-pr-changed-docs/plan.md";
    fs.mkdirSync(path.join(tmpDir, path.dirname(docPath)), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, docPath),
      "---\ntitle: PR-scoped changed docs\n---\n\n# Body\n",
    );

    const result = computeNotableFiles([{ status: "A", path: docPath }]);
    expect(result).toEqual([
      { path: docPath, label: "205/plan.md", kind: "doc", status: "A" },
    ]);
  });

  it("labels a doc without frontmatter the same way (no disk read at all)", () => {
    const docPath = "docs/045-session-lifecycle/plan.md";
    const result = computeNotableFiles([{ status: "M", path: docPath }]);
    expect(result).toEqual([
      { path: docPath, label: "045/plan.md", kind: "doc", status: "M" },
    ]);
  });

  it("labels a deleted doc that no longer exists on disk", () => {
    const docPath = "docs/099-gone/plan.md";
    const result = computeNotableFiles([{ status: "D", path: docPath }]);
    expect(result).toEqual([
      { path: docPath, label: "099/plan.md", kind: "doc", status: "D" },
    ]);
  });

  it("classifies allowlisted config files (by basename) as config", () => {
    const changes = [
      { status: "M", path: "shipit.yaml" },
      { status: "A", path: "docker-compose.yml" },
      { status: "M", path: "package.json" },
      { status: "M", path: "services/api/docker-compose.yml" },
    ];
    const result = computeNotableFiles(changes);
    expect(result.map((f) => f.kind)).toEqual(["config", "config", "config", "config"]);
    expect(result.map((f) => f.label)).toEqual([
      "shipit.yaml",
      "docker-compose.yml",
      "package.json",
      "api/docker-compose.yml",
    ]);
  });

  it("treats CLAUDE.md / AGENTS.md as config, not docs (allowlist precedence over .md)", () => {
    const result = computeNotableFiles([
      { status: "M", path: "CLAUDE.md" },
      { status: "A", path: "AGENTS.md" },
    ]);
    expect(result).toEqual([
      { path: "CLAUDE.md", label: "CLAUDE.md", kind: "config", status: "M" },
      { path: "AGENTS.md", label: "AGENTS.md", kind: "config", status: "A" },
    ]);
  });

  it("keeps both plan.md and checklist.md from one feature dir as distinct chips", () => {
    // Previously collapsed to a single chip (both resolved to the directory
    // title). Compact path labels tell them apart, so both survive.
    const dir = "docs/210-agent-spawned-sessions";
    const result = computeNotableFiles([
      { status: "M", path: `${dir}/checklist.md` },
      { status: "M", path: `${dir}/plan.md` },
    ]);
    expect(result).toEqual([
      { path: `${dir}/checklist.md`, label: "210/checklist.md", kind: "doc", status: "M" },
      { path: `${dir}/plan.md`, label: "210/plan.md", kind: "doc", status: "M" },
    ]);
  });

  it("keeps same-named docs from different directories (no cross-feature collapse)", () => {
    // The #1877 bug: two features' requirements.md both resolved to the title
    // "Requirements", so one chip was dropped and the survivor pointed at the
    // unrelated feature. Both must survive with distinct labels.
    const result = computeNotableFiles([
      { status: "M", path: "docs/150-multiple-provider-subscriptions/requirements.md" },
      { status: "A", path: "docs/246-native-issue-tracker-evaluation/requirements.md" },
    ]);
    expect(result.map((f) => [f.path, f.label])).toEqual([
      ["docs/150-multiple-provider-subscriptions/requirements.md", "150/requirements.md"],
      ["docs/246-native-issue-tracker-evaluation/requirements.md", "246/requirements.md"],
    ]);
  });

  it("reproduces PR #1877: all 8 changed markdown files get their own chip, in diff order", () => {
    const changes = [
      { status: "M", path: "docs/150-multiple-provider-subscriptions/requirements.md" },
      { status: "A", path: "docs/246-native-issue-tracker-evaluation/checklist.md" },
      { status: "A", path: "docs/246-native-issue-tracker-evaluation/evaluation-requirements.md" },
      { status: "A", path: "docs/246-native-issue-tracker-evaluation/plan.md" },
      { status: "A", path: "docs/246-native-issue-tracker-evaluation/requirements.md" },
      { status: "A", path: "docs/247-private-github-issue-tracker/checklist.md" },
      { status: "A", path: "docs/247-private-github-issue-tracker/plan.md" },
      { status: "A", path: "docs/247-private-github-issue-tracker/requirements.md" },
    ];

    const result = computeNotableFiles(changes);

    expect(result).toHaveLength(8);
    expect(result.map((f) => f.path)).toEqual(changes.map((c) => c.path));
    expect(result.map((f) => f.label)).toEqual([
      "150/requirements.md",
      "246/checklist.md",
      "246/evaluation-requirements.md",
      "246/plan.md",
      "246/requirements.md",
      "247/checklist.md",
      "247/plan.md",
      "247/requirements.md",
    ]);
    expect(new Set(result.map((f) => f.label)).size).toBe(8);
  });

  it("reproduces the shipit/brxzvw shape: same-dir docs sharing a frontmatter title all keep a chip", () => {
    // The second confirmed instance. `plan.md` and `requirements.md` in ONE
    // feature dir carried an IDENTICAL author-written frontmatter `title:` —
    // reasonable authoring under docs/241 (they describe the same feature) —
    // and the old title-keyed collapse dropped the requirements chip entirely
    // (rank plan=0 beat requirements=3). Same-directory and author-chosen, so
    // neither a same-dir-scoped dedupe nor a path-derived-titles-only dedupe
    // would have saved it; only path labels do.
    const dir = "docs/246-shipit-state-out-of-clone";
    fs.mkdirSync(path.join(tmpDir, dir), { recursive: true });
    const sharedFrontmatter = "---\ntitle: Keep ShipIts generated state out of the users repository\n---\n";
    fs.writeFileSync(path.join(tmpDir, dir, "plan.md"), sharedFrontmatter);
    fs.writeFileSync(path.join(tmpDir, dir, "requirements.md"), sharedFrontmatter);
    fs.writeFileSync(path.join(tmpDir, dir, "checklist.md"), "# no frontmatter\n");

    const result = computeNotableFiles([
      { status: "A", path: `${dir}/checklist.md` },
      { status: "A", path: `${dir}/plan.md` },
      { status: "A", path: `${dir}/requirements.md` },
    ]);

    expect(result.map((f) => [f.path, f.label])).toEqual([
      [`${dir}/checklist.md`, "246/checklist.md"],
      [`${dir}/plan.md`, "246/plan.md"],
      [`${dir}/requirements.md`, "246/requirements.md"],
    ]);
  });

  it("never collapses config files sharing a basename", () => {
    const result = computeNotableFiles([
      { status: "M", path: "package.json" },
      { status: "M", path: "services/api/package.json" },
    ]);
    expect(result.map((f) => [f.path, f.label])).toEqual([
      ["package.json", "package.json"],
      ["services/api/package.json", "api/package.json"],
    ]);
  });

  it("classifies a committed HTML mockup as a doc", () => {
    const result = computeNotableFiles([
      { status: "A", path: "docs/205-pr-changed-docs/mockup.html" },
      { status: "M", path: "docs/069-design-system/mocks/tokens.html" },
    ]);
    expect(result).toEqual([
      {
        path: "docs/205-pr-changed-docs/mockup.html",
        label: "205/mockup.html",
        kind: "doc",
        status: "A",
      },
      {
        path: "docs/069-design-system/mocks/tokens.html",
        label: "mocks/tokens.html",
        kind: "doc",
        status: "M",
      },
    ]);
  });

  it("classifies HTML anywhere, not just under docs/ (blanket rule, deliberately)", () => {
    // A location gate was rejected: no other tier here is path-dependent, and a
    // change-set-dependent rule would make a mockup's chip appear or vanish
    // based on what else the PR touched. An app's index.html getting a chip is
    // the accepted cost of that determinism.
    const result = computeNotableFiles([
      { status: "M", path: "index.html" },
      { status: "M", path: "src/templates/email.html" },
    ]);
    expect(result).toEqual([
      { path: "index.html", label: "index.html", kind: "doc", status: "M" },
      { path: "src/templates/email.html", label: "templates/email.html", kind: "doc", status: "M" },
    ]);
  });

  it("matches .htm and mixed-case HTML extensions", () => {
    const result = computeNotableFiles([
      { status: "A", path: "docs/210-thing/legacy.htm" },
      { status: "M", path: "docs/210-thing/Mockup.HTML" },
      { status: "D", path: "docs/210-thing/old.HtM" },
    ]);
    expect(result.map((f) => [f.label, f.kind, f.status])).toEqual([
      ["210/legacy.htm", "doc", "A"],
      ["210/Mockup.HTML", "doc", "M"],
      ["210/old.HtM", "doc", "D"],
    ]);
  });

  it("skips non-notable files (code, lockfiles)", () => {
    const result = computeNotableFiles([
      { status: "M", path: "src/client/App.tsx" },
      { status: "M", path: "package-lock.json" },
      { status: "M", path: "data/sample.csv" },
    ]);
    expect(result).toEqual([]);
  });

  it("classifies added/modified images by extension (case-insensitive)", () => {
    const result = computeNotableFiles([
      { status: "A", path: "public/logo.png" },
      { status: "M", path: "docs/210-thing/mockup.svg" },
      { status: "A", path: "assets/Hero.JPG" },
      { status: "D", path: "assets/old-banner.gif" },
    ]);
    expect(result).toEqual([
      { path: "public/logo.png", label: "public/logo.png", kind: "image", status: "A" },
      { path: "docs/210-thing/mockup.svg", label: "210/mockup.svg", kind: "image", status: "M" },
      { path: "assets/Hero.JPG", label: "assets/Hero.JPG", kind: "image", status: "A" },
      { path: "assets/old-banner.gif", label: "assets/old-banner.gif", kind: "image", status: "D" },
    ]);
  });

  it("never collapses images sharing a basename across directories", () => {
    const result = computeNotableFiles([
      { status: "A", path: "docs/a/diagram.png" },
      { status: "A", path: "docs/b/diagram.png" },
    ]);
    expect(result.map((f) => [f.path, f.label])).toEqual([
      ["docs/a/diagram.png", "a/diagram.png"],
      ["docs/b/diagram.png", "b/diagram.png"],
    ]);
  });

  it("normalizes rename/copy statuses to M and drops unknown statuses", () => {
    const result = computeNotableFiles([
      { status: "R100", path: "shipit.yaml" },
      { status: "C75", path: "package.json" },
      { status: "T", path: "docker-compose.yml" },
    ]);
    expect(result).toEqual([
      { path: "shipit.yaml", label: "shipit.yaml", kind: "config", status: "M" },
      { path: "package.json", label: "package.json", kind: "config", status: "M" },
    ]);
  });
});

describe("notableFilesForBranch — derive from the merge-base diff", () => {
  function git(args: string): void {
    execSync(`git ${args}`, {
      cwd: tmpDir,
      env: { ...process.env, HOME: tmpDir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });
  }

  it("returns the notable files changed on the feature branch vs the base", async () => {
    git("init -q -b main");
    git("config user.email test@test.com");
    git("config user.name Test");
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# Repo\n");
    git("add -A");
    git("commit -qm initial");

    git("checkout -q -b feature");
    // Notable changes
    fs.mkdirSync(path.join(tmpDir, "docs/210-thing"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "docs/210-thing/plan.md"), "---\ntitle: A Thing\n---\n");
    fs.writeFileSync(path.join(tmpDir, "shipit.yaml"), "agent: {}\n");
    // Non-notable change
    fs.writeFileSync(path.join(tmpDir, "src.ts"), "export const x = 1;\n");
    git("add -A");
    git("commit -qm feature");

    const manager = new GitManager(tmpDir);
    const result = await notableFilesForBranch(manager, "main");

    const byPath = Object.fromEntries(result.map((f) => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual(["docs/210-thing/plan.md", "shipit.yaml"]);
    expect(byPath["docs/210-thing/plan.md"]).toMatchObject({ kind: "doc", label: "210/plan.md", status: "A" });
    expect(byPath["shipit.yaml"]).toMatchObject({ kind: "config", label: "shipit.yaml", status: "A" });
  });

  it("ignores notable files that moved on the base after the branch point (merge-base, not two-dot)", async () => {
    git("init -q -b main");
    git("config user.email test@test.com");
    git("config user.name Test");
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# Repo\n");
    git("add -A");
    git("commit -qm initial");

    git("checkout -q -b feature");
    fs.mkdirSync(path.join(tmpDir, "docs/210-thing"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "docs/210-thing/plan.md"), "---\ntitle: A Thing\n---\n");
    git("add -A");
    git("commit -qm feature");

    // `main` advances with its own notable change after the branch diverged.
    // A two-dot `main..HEAD` diff would surface this as a (reverse) change the
    // branch never made; the merge-base diff must not.
    git("checkout -q main");
    fs.writeFileSync(path.join(tmpDir, "shipit.yaml"), "agent: {}\n");
    git("add -A");
    git("commit -qm base-advance");
    git("checkout -q feature");

    const manager = new GitManager(tmpDir);
    const result = await notableFilesForBranch(manager, "main");

    expect(result.map((f) => f.path)).toEqual(["docs/210-thing/plan.md"]);
  });

  it("returns [] when the base ref can't be resolved", async () => {
    git("init -q -b main");
    git("config user.email test@test.com");
    git("config user.name Test");
    fs.writeFileSync(path.join(tmpDir, "plan.md"), "# x\n");
    git("add -A");
    git("commit -qm initial");

    const manager = new GitManager(tmpDir);
    const result = await notableFilesForBranch(manager, "nonexistent-base");
    expect(result).toEqual([]);
  });
});
