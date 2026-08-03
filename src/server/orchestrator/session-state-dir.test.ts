import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  sessionStateDir,
  sessionStateDirForWorkspace,
  resolveContainerStateDir,
  sweepLegacyCloneArtifacts,
  SESSION_STATE_SUBDIR,
} from "./session-state-dir.js";

describe("sessionStateDirForWorkspace (docs/246)", () => {
  it("resolves the sibling state dir for the standard layout", () => {
    expect(sessionStateDirForWorkspace("/data/sessions/abc/workspace")).toBe(
      path.join("/data/sessions/abc", SESSION_STATE_SUBDIR),
    );
  });

  // The whole reason this isn't a bare `path.dirname`: under the legacy flat
  // layout (sessionDir === workspaceDir) dirname yields sessionsRoot, and every
  // session's state would land in the same directory.
  it("returns null on the legacy flat layout instead of collapsing into sessionsRoot", () => {
    expect(sessionStateDirForWorkspace("/data/sessions/abc")).toBeNull();
  });

  it("agrees with sessionStateDir on the session dir it derives", () => {
    const sessionDir = "/data/sessions/abc";
    expect(sessionStateDirForWorkspace(path.join(sessionDir, "workspace"))).toBe(
      sessionStateDir(sessionDir),
    );
  });
});

describe("resolveContainerStateDir (docs/246)", () => {
  it("resolves the sibling state dir for the standard layout", () => {
    expect(resolveContainerStateDir("/data/sessions/abc/workspace")).toBe(
      path.join("/data/sessions/abc", SESSION_STATE_SUBDIR),
    );
  });

  // Regression: the runner factory passes `sessionDir = dirname(workspaceDir)`
  // (app-lifecycle.ts), so a FLAT session used to resolve to
  // `<sessionsRoot>/state` — outside its own clone, so a containment check
  // passed it, but SHARED by every flat session on the host. They would have
  // mounted one directory and shared a single install marker, while host-side
  // callers looked somewhere else entirely.
  it("returns null for a flat-layout clone instead of a host-shared directory", () => {
    expect(resolveContainerStateDir("/data/sessions/abc")).toBeNull();
  });

  it("gives two flat sessions no shared directory", () => {
    expect(resolveContainerStateDir("/data/sessions/abc")).toBeNull();
    expect(resolveContainerStateDir("/data/sessions/def")).toBeNull();
  });

  it("returns null when the clone path is absent", () => {
    expect(resolveContainerStateDir(undefined)).toBeNull();
  });

  // The host and container sides must never derive different answers.
  it("agrees with the host-side resolver by construction", () => {
    const clone = "/data/sessions/abc/workspace";
    expect(resolveContainerStateDir(clone)).toBe(sessionStateDirForWorkspace(clone));
  });
});

describe("sweepLegacyCloneArtifacts (docs/246 req 6)", () => {
  let clone: string;
  const shipitDir = () => path.join(clone, ".shipit");

  beforeEach(() => {
    clone = fs.mkdtempSync(path.join(os.tmpdir(), "clone-sweep-"));
    // A real repo: the sweep asks `git ls-files` for provenance, and treats an
    // unknown answer (no repo, no git) as TRACKED — refusing to delete is
    // recoverable, deleting is not. Production clones are always repos.
    execFileSync("git", ["init", "-q"], { cwd: clone });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: clone });
    execFileSync("git", ["config", "user.name", "t"], { cwd: clone });
    fs.mkdirSync(shipitDir(), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(clone, { recursive: true, force: true });
  });

  it("removes every generated artifact and drops the emptied directory", () => {
    fs.writeFileSync(path.join(shipitDir(), "compose.override.yml"), "x");
    fs.writeFileSync(path.join(shipitDir(), ".install-done"), "{}");
    fs.writeFileSync(path.join(shipitDir(), ".env.agent"), "A=1");
    fs.mkdirSync(path.join(shipitDir(), "ci-logs"));
    fs.writeFileSync(path.join(shipitDir(), "ci-logs", "1.log"), "boom");

    const removed = sweepLegacyCloneArtifacts(clone);

    expect(removed.sort()).toEqual(
      [".env.agent", ".install-done", "ci-logs", "compose.override.yml"].sort(),
    );
    expect(fs.existsSync(shipitDir())).toBe(false);
  });

  // A user is free to keep their own files under `.shipit/`. Removing the
  // directory wholesale would delete someone else's content to clean up ours.
  it("keeps the directory and any file ShipIt did not generate", () => {
    fs.writeFileSync(path.join(shipitDir(), "compose.override.yml"), "x");
    fs.writeFileSync(path.join(shipitDir(), "notes.md"), "mine");

    const removed = sweepLegacyCloneArtifacts(clone);

    expect(removed).toEqual(["compose.override.yml"]);
    expect(fs.existsSync(path.join(shipitDir(), "notes.md"))).toBe(true);
    expect(fs.existsSync(shipitDir())).toBe(true);
  });

  it("is a no-op (and does not throw) when there is no .shipit directory", () => {
    fs.rmSync(shipitDir(), { recursive: true, force: true });
    expect(sweepLegacyCloneArtifacts(clone)).toEqual([]);
  });

  // Matching on filename is not proof of provenance: a repo may legitimately
  // commit its own `.shipit/compose.override.yml`. Deleting it would be silent
  // and land in the next auto-commit.
  it("never sweeps a git-tracked path, even one with a generated artifact's name", () => {
    fs.writeFileSync(path.join(shipitDir(), "compose.override.yml"), "mine");
    execFileSync("git", ["add", ".shipit/compose.override.yml"], { cwd: clone });
    execFileSync("git", ["commit", "-qm", "user owns this"], { cwd: clone });

    expect(sweepLegacyCloneArtifacts(clone)).toEqual([]);
    expect(fs.readFileSync(path.join(shipitDir(), "compose.override.yml"), "utf-8")).toBe("mine");
  });

  it("treats an unknown provenance answer (not a git repo) as tracked", () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "clone-nogit-"));
    fs.mkdirSync(path.join(bare, ".shipit"), { recursive: true });
    fs.writeFileSync(path.join(bare, ".shipit", ".install-done"), "{}");
    try {
      expect(sweepLegacyCloneArtifacts(bare)).toEqual([]);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it("is idempotent", () => {
    fs.writeFileSync(path.join(shipitDir(), ".install-done"), "{}");
    expect(sweepLegacyCloneArtifacts(clone)).toEqual([".install-done"]);
    expect(sweepLegacyCloneArtifacts(clone)).toEqual([]);
  });
});
