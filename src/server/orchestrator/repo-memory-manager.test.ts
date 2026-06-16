import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  repoMemoryDir,
  provisionRepoMemory,
  syncMemoryBack,
  REPO_MEMORY_SUBDIR,
} from "./repo-memory-manager.js";
import { perSessionCredentialsDir } from "./session-credentials-scaffold.js";

describe("per-repo Claude memory sharing (docs/155)", () => {
  let root: string;
  const sid = "memsession01";
  const repoHash = "abc123def456abcd";

  const sharedDir = () => repoMemoryDir(root, repoHash);
  const sessionMemoryDir = () =>
    path.join(perSessionCredentialsDir(root, sid), ".claude", "projects", "-workspace", "memory");

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-mem-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("repoMemoryDir resolves under the repo-memory subdir keyed by hash", () => {
    expect(repoMemoryDir(root, repoHash)).toBe(path.join(root, REPO_MEMORY_SUBDIR, repoHash));
  });

  it("provisionRepoMemory copies shared files into the session memory subtree", () => {
    fs.mkdirSync(sharedDir(), { recursive: true });
    fs.writeFileSync(path.join(sharedDir(), "MEMORY.md"), "- index");
    fs.writeFileSync(path.join(sharedDir(), "user-likes-tabs.md"), "tabs");

    provisionRepoMemory(root, sid, repoHash);

    expect(fs.readFileSync(path.join(sessionMemoryDir(), "MEMORY.md"), "utf8")).toBe("- index");
    expect(fs.readFileSync(path.join(sessionMemoryDir(), "user-likes-tabs.md"), "utf8")).toBe("tabs");
  });

  it("provisionRepoMemory creates an empty shared dir when none exists yet", () => {
    provisionRepoMemory(root, sid, repoHash);
    expect(fs.existsSync(sharedDir())).toBe(true);
    expect(fs.existsSync(sessionMemoryDir())).toBe(true);
  });

  it("syncMemoryBack mirrors session-written files back to the shared dir", () => {
    fs.mkdirSync(sessionMemoryDir(), { recursive: true });
    fs.writeFileSync(path.join(sessionMemoryDir(), "new-note.md"), "insight");

    syncMemoryBack(root, sid, repoHash);

    expect(fs.readFileSync(path.join(sharedDir(), "new-note.md"), "utf8")).toBe("insight");
  });

  it("syncMemoryBack is a no-op when the session never wrote a memory dir", () => {
    fs.mkdirSync(perSessionCredentialsDir(root, sid), { recursive: true });
    expect(() => syncMemoryBack(root, sid, repoHash)).not.toThrow();
    expect(fs.existsSync(sharedDir())).toBe(false);
  });

  it("round-trips: provision-in does not push unchanged files back out", () => {
    fs.mkdirSync(sharedDir(), { recursive: true });
    const sharedFile = path.join(sharedDir(), "kept.md");
    fs.writeFileSync(sharedFile, "original");
    // Back-date the shared file so any naive copy-back (which would set a
    // newer mtime) is detectable.
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(sharedFile, old, old);
    const originalMtime = fs.statSync(sharedFile).mtimeMs;

    provisionRepoMemory(root, sid, repoHash);
    // Session didn't touch the file — sync-back must not rewrite it.
    syncMemoryBack(root, sid, repoHash);

    expect(fs.readFileSync(sharedFile, "utf8")).toBe("original");
    expect(fs.statSync(sharedFile).mtimeMs).toBe(originalMtime);
  });

  it("last-write-wins: a newer session edit overwrites the shared file", () => {
    fs.mkdirSync(sharedDir(), { recursive: true });
    const sharedFile = path.join(sharedDir(), "evolving.md");
    fs.writeFileSync(sharedFile, "v1");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(sharedFile, old, old);

    provisionRepoMemory(root, sid, repoHash);
    // The session's CLI rewrites the memory (newer mtime than the shared copy).
    const sessionFile = path.join(sessionMemoryDir(), "evolving.md");
    fs.writeFileSync(sessionFile, "v2");

    syncMemoryBack(root, sid, repoHash);

    expect(fs.readFileSync(sharedFile, "utf8")).toBe("v2");
  });

  it("nested subdirectories are mirrored both ways", () => {
    fs.mkdirSync(path.join(sharedDir(), "sub"), { recursive: true });
    fs.writeFileSync(path.join(sharedDir(), "sub", "deep.md"), "deep");

    provisionRepoMemory(root, sid, repoHash);
    expect(fs.readFileSync(path.join(sessionMemoryDir(), "sub", "deep.md"), "utf8")).toBe("deep");

    fs.writeFileSync(path.join(sessionMemoryDir(), "sub", "added.md"), "added");
    syncMemoryBack(root, sid, repoHash);
    expect(fs.readFileSync(path.join(sharedDir(), "sub", "added.md"), "utf8")).toBe("added");
  });
});
