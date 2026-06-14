import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

import { GitManager } from "../../shared/git.js";
import { computeNotableFiles, notableFilesForBranch } from "./notable-files.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync("/tmp/shipit-notable-files-test-");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("computeNotableFiles — classification", () => {
  it("classifies a .md file as a doc and resolves its frontmatter title", async () => {
    const docPath = "docs/205-pr-changed-docs/plan.md";
    fs.mkdirSync(path.join(tmpDir, path.dirname(docPath)), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, docPath),
      "---\ntitle: PR-scoped changed docs\n---\n\n# Body\n",
    );

    const result = await computeNotableFiles(tmpDir, [{ status: "A", path: docPath }]);
    expect(result).toEqual([
      { path: docPath, title: "PR-scoped changed docs", kind: "doc", status: "A" },
    ]);
  });

  it("falls back to a path-derived title for a doc without frontmatter", async () => {
    const docPath = "docs/045-session-lifecycle/plan.md";
    fs.mkdirSync(path.join(tmpDir, path.dirname(docPath)), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, docPath), "# No frontmatter here\n");

    const result = await computeNotableFiles(tmpDir, [{ status: "M", path: docPath }]);
    expect(result).toEqual([
      { path: docPath, title: "Session Lifecycle", kind: "doc", status: "M" },
    ]);
  });

  it("falls back to a path-derived title for a deleted doc that no longer exists", async () => {
    const docPath = "docs/099-gone/plan.md";
    const result = await computeNotableFiles(tmpDir, [{ status: "D", path: docPath }]);
    expect(result).toEqual([
      { path: docPath, title: "Gone", kind: "doc", status: "D" },
    ]);
  });

  it("classifies allowlisted config files (by basename) as config", async () => {
    const changes = [
      { status: "M", path: "shipit.yaml" },
      { status: "A", path: "docker-compose.yml" },
      { status: "M", path: "package.json" },
      { status: "M", path: "services/api/docker-compose.yml" },
    ];
    const result = await computeNotableFiles(tmpDir, changes);
    expect(result.map((f) => f.kind)).toEqual(["config", "config", "config", "config"]);
    expect(result.map((f) => f.title)).toEqual([
      "shipit.yaml",
      "docker-compose.yml",
      "package.json",
      "docker-compose.yml",
    ]);
  });

  it("treats CLAUDE.md / AGENTS.md as config, not docs (allowlist precedence over .md)", async () => {
    fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), "---\ntitle: Ignore me\n---\n");
    const result = await computeNotableFiles(tmpDir, [
      { status: "M", path: "CLAUDE.md" },
      { status: "A", path: "AGENTS.md" },
    ]);
    expect(result).toEqual([
      { path: "CLAUDE.md", title: "CLAUDE.md", kind: "config", status: "M" },
      { path: "AGENTS.md", title: "AGENTS.md", kind: "config", status: "A" },
    ]);
  });

  it("skips non-notable files (code, lockfiles, assets)", async () => {
    const result = await computeNotableFiles(tmpDir, [
      { status: "M", path: "src/client/App.tsx" },
      { status: "M", path: "package-lock.json" },
      { status: "A", path: "public/logo.png" },
    ]);
    expect(result).toEqual([]);
  });

  it("normalizes rename/copy statuses to M and drops unknown statuses", async () => {
    const result = await computeNotableFiles(tmpDir, [
      { status: "R100", path: "shipit.yaml" },
      { status: "C75", path: "package.json" },
      { status: "T", path: "docker-compose.yml" },
    ]);
    expect(result).toEqual([
      { path: "shipit.yaml", title: "shipit.yaml", kind: "config", status: "M" },
      { path: "package.json", title: "package.json", kind: "config", status: "M" },
    ]);
  });
});

describe("notableFilesForBranch — derive from a base...HEAD diff", () => {
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
    const result = await notableFilesForBranch(manager, tmpDir, "main");

    const byPath = Object.fromEntries(result.map((f) => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual(["docs/210-thing/plan.md", "shipit.yaml"]);
    expect(byPath["docs/210-thing/plan.md"]).toMatchObject({ kind: "doc", title: "A Thing", status: "A" });
    expect(byPath["shipit.yaml"]).toMatchObject({ kind: "config", title: "shipit.yaml", status: "A" });
  });

  it("returns [] when the base ref can't be resolved", async () => {
    git("init -q -b main");
    git("config user.email test@test.com");
    git("config user.name Test");
    fs.writeFileSync(path.join(tmpDir, "plan.md"), "# x\n");
    git("add -A");
    git("commit -qm initial");

    const manager = new GitManager(tmpDir);
    const result = await notableFilesForBranch(manager, tmpDir, "nonexistent-base");
    expect(result).toEqual([]);
  });
});
