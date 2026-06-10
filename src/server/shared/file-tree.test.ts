import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanFileTree } from "./file-tree.js";

describe("scanFileTree", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-tree-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns an empty array for an empty directory", async () => {
    const tree = await scanFileTree(tmpDir);
    expect(tree).toEqual([]);
  });

  it("returns files at the root level", async () => {
    fs.writeFileSync(path.join(tmpDir, "index.ts"), "");
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");

    const tree = await scanFileTree(tmpDir);
    expect(tree).toEqual([
      { name: "index.ts", path: "index.ts", type: "file" },
      { name: "package.json", path: "package.json", type: "file" },
    ]);
  });

  it("returns directories with children before files", async () => {
    fs.writeFileSync(path.join(tmpDir, "README.md"), "");
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.writeFileSync(path.join(tmpDir, "src", "app.ts"), "");

    const tree = await scanFileTree(tmpDir);
    expect(tree).toEqual([
      {
        name: "src",
        path: "src",
        type: "directory",
        children: [
          { name: "app.ts", path: "src/app.ts", type: "file" },
        ],
      },
      { name: "README.md", path: "README.md", type: "file" },
    ]);
  });

  it("handles nested directory structures", async () => {
    fs.mkdirSync(path.join(tmpDir, "src", "components"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "components", "App.tsx"), "");
    fs.writeFileSync(path.join(tmpDir, "src", "index.ts"), "");

    const tree = await scanFileTree(tmpDir);
    expect(tree).toEqual([
      {
        name: "src",
        path: "src",
        type: "directory",
        children: [
          {
            name: "components",
            path: "src/components",
            type: "directory",
            children: [
              { name: "App.tsx", path: "src/components/App.tsx", type: "file" },
            ],
          },
          { name: "index.ts", path: "src/index.ts", type: "file" },
        ],
      },
    ]);
  });

  it("skips node_modules directory", async () => {
    fs.mkdirSync(path.join(tmpDir, "node_modules", "react"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "node_modules", "react", "index.js"), "");
    fs.writeFileSync(path.join(tmpDir, "index.ts"), "");

    const tree = await scanFileTree(tmpDir);
    expect(tree).toEqual([
      { name: "index.ts", path: "index.ts", type: "file" },
    ]);
  });

  it("skips .git directory", async () => {
    fs.mkdirSync(path.join(tmpDir, ".git", "refs"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".git", "HEAD"), "");
    fs.writeFileSync(path.join(tmpDir, "index.ts"), "");

    const tree = await scanFileTree(tmpDir);
    expect(tree).toEqual([
      { name: "index.ts", path: "index.ts", type: "file" },
    ]);
  });

  it("skips .vibe-chat-history directory", async () => {
    fs.mkdirSync(path.join(tmpDir, ".vibe-chat-history"));
    fs.writeFileSync(path.join(tmpDir, ".vibe-chat-history", "session.json"), "{}");
    fs.writeFileSync(path.join(tmpDir, "index.ts"), "");

    const tree = await scanFileTree(tmpDir);
    expect(tree).toEqual([
      { name: "index.ts", path: "index.ts", type: "file" },
    ]);
  });

  it("skips dist directory", async () => {
    fs.mkdirSync(path.join(tmpDir, "dist"));
    fs.writeFileSync(path.join(tmpDir, "dist", "bundle.js"), "");
    fs.writeFileSync(path.join(tmpDir, "index.ts"), "");

    const tree = await scanFileTree(tmpDir);
    expect(tree).toEqual([
      { name: "index.ts", path: "index.ts", type: "file" },
    ]);
  });

  it("shows dotfiles by default (.npmrc, .gitignore, .env, rc files)", async () => {
    // Dotfiles are real, editable source and must be visible in the IDE just
    // like VS Code shows them. Show-by-default replaces the old allowlist —
    // see docs/096-claude-skills-access/plan.md.
    fs.writeFileSync(path.join(tmpDir, ".env"), "SECRET=123");
    fs.writeFileSync(path.join(tmpDir, ".env.local"), "SECRET=local");
    fs.writeFileSync(path.join(tmpDir, ".npmrc"), "registry=https://example.com");
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "node_modules");
    fs.writeFileSync(path.join(tmpDir, ".dockerignore"), ".git");
    fs.writeFileSync(path.join(tmpDir, ".editorconfig"), "");
    fs.writeFileSync(path.join(tmpDir, ".eslintrc"), "{}");
    fs.writeFileSync(path.join(tmpDir, "index.ts"), "");

    const tree = await scanFileTree(tmpDir);
    const names = tree.map((n) => n.name);
    expect(names).toContain(".env");
    expect(names).toContain(".env.local");
    expect(names).toContain(".npmrc");
    expect(names).toContain(".gitignore");
    expect(names).toContain(".dockerignore");
    expect(names).toContain(".editorconfig");
    expect(names).toContain(".eslintrc");
    expect(names).toContain("index.ts");
  });

  it("hides pure junk and internal data files (.DS_Store, session bookkeeping)", async () => {
    fs.writeFileSync(path.join(tmpDir, ".DS_Store"), "");
    fs.writeFileSync(path.join(tmpDir, ".shipit-usage.json"), "{}");
    fs.writeFileSync(path.join(tmpDir, ".vibe-sessions.json"), "{}");
    fs.writeFileSync(path.join(tmpDir, ".npmrc"), "");
    fs.writeFileSync(path.join(tmpDir, "index.ts"), "");

    const tree = await scanFileTree(tmpDir);
    const names = tree.map((n) => n.name);
    expect(names).not.toContain(".DS_Store");
    expect(names).not.toContain(".shipit-usage.json");
    expect(names).not.toContain(".vibe-sessions.json");
    expect(names).toContain(".npmrc");
    expect(names).toContain("index.ts");
  });

  it("keeps WORKSPACE_SKIP_DIRS hidden even though they are dotfiles", async () => {
    // Inverting dotfile visibility must NOT regress the directory skips —
    // .git internals and the ShipIt-in-ShipIt metadir skips (feature 118).
    fs.mkdirSync(path.join(tmpDir, ".git"));
    fs.writeFileSync(path.join(tmpDir, ".git", "HEAD"), "");
    fs.mkdirSync(path.join(tmpDir, ".shipit"));
    fs.writeFileSync(path.join(tmpDir, ".shipit", ".env.dev"), "SECRET=1");
    fs.mkdirSync(path.join(tmpDir, ".inner-shipit"));
    fs.writeFileSync(path.join(tmpDir, ".inner-shipit", "db.sqlite"), "");
    fs.mkdirSync(path.join(tmpDir, "sessions"));
    fs.writeFileSync(path.join(tmpDir, "sessions", "clone.txt"), "");
    fs.writeFileSync(path.join(tmpDir, ".npmrc"), "");

    const tree = await scanFileTree(tmpDir);
    const names = tree.map((n) => n.name);
    expect(names).not.toContain(".git");
    expect(names).not.toContain(".shipit");
    expect(names).not.toContain(".inner-shipit");
    expect(names).not.toContain("sessions");
    expect(names).toContain(".npmrc");
  });

  it("shows .claude/ in the tree (skills are part of the codebase)", async () => {
    // See docs/096-claude-skills-access/plan.md — `.claude/skills/` files are
    // editable artifacts that ship with the project; they must be visible in
    // the IDE file panel just like any other source file.
    fs.mkdirSync(path.join(tmpDir, ".claude", "skills", "my-skill"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".claude", "skills", "my-skill", "SKILL.md"), "# my skill");
    fs.writeFileSync(path.join(tmpDir, "index.ts"), "");

    const tree = await scanFileTree(tmpDir);
    const names = tree.map((n) => n.name);
    expect(names).toContain(".claude");
    expect(names).toContain("index.ts");

    // Recursively walk into .claude — SKILL.md should be discoverable.
    const claude = tree.find((n) => n.name === ".claude");
    expect(claude?.type).toBe("directory");
    const skills = (claude as { children?: { name: string }[] }).children?.find((c) => c.name === "skills");
    expect(skills).toBeTruthy();
  });

  it("sorts directories alphabetically and files alphabetically", async () => {
    fs.mkdirSync(path.join(tmpDir, "zebra"));
    fs.mkdirSync(path.join(tmpDir, "alpha"));
    fs.writeFileSync(path.join(tmpDir, "z.ts"), "");
    fs.writeFileSync(path.join(tmpDir, "a.ts"), "");

    const tree = await scanFileTree(tmpDir);
    const names = tree.map((n) => n.name);
    expect(names).toEqual(["alpha", "zebra", "a.ts", "z.ts"]);
  });

  it("returns empty array for non-existent directory", async () => {
    const tree = await scanFileTree(path.join(tmpDir, "does-not-exist"));
    expect(tree).toEqual([]);
  });

  it("does not include uploads when workspace is a subdirectory of session dir", async () => {
    // The session dir layout is: {sessionDir}/workspace/ (git repo) + {sessionDir}/uploads/
    // scanFileTree only runs on the workspace subdir, so uploads are invisible.
    const sessionDir = tmpDir;
    const workspaceDir = path.join(sessionDir, "workspace");
    const uploadsDir = path.join(sessionDir, "uploads");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(uploadsDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "index.ts"), "");
    fs.writeFileSync(path.join(uploadsDir, "photo.png"), Buffer.alloc(10));

    // Scanning the workspace dir should not include uploads (they're a sibling)
    const tree = await scanFileTree(workspaceDir);
    expect(tree).toEqual([
      { name: "index.ts", path: "index.ts", type: "file" },
    ]);
  });
});
