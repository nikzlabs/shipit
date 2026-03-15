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

  it("skips hidden files and directories but allows .env", async () => {
    fs.writeFileSync(path.join(tmpDir, ".env"), "SECRET=123");
    fs.writeFileSync(path.join(tmpDir, ".env.local"), "SECRET=local");
    fs.writeFileSync(path.join(tmpDir, ".eslintrc"), "{}");
    fs.writeFileSync(path.join(tmpDir, "index.ts"), "");

    const tree = await scanFileTree(tmpDir);
    const names = tree.map((n) => n.name);
    expect(names).toContain(".env");
    expect(names).toContain(".env.local");
    expect(names).not.toContain(".eslintrc");
    expect(names).toContain("index.ts");
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
