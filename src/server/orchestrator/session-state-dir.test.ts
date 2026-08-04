import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  sessionStateDir,
  sessionStateDirForWorkspace,
  sweepLegacyCloneArtifacts,
  SESSION_STATE_SUBDIR,
} from "./session-state-dir.js";

describe("sessionStateDirForWorkspace (docs/246)", () => {
  it("resolves the sibling state dir for the standard layout", () => {
    expect(sessionStateDirForWorkspace("/data/sessions/abc/workspace")).toBe(
      path.join("/data/sessions/abc", SESSION_STATE_SUBDIR),
    );
  });

  it("agrees with sessionStateDir on the session dir it derives", () => {
    const sessionDir = "/data/sessions/abc";
    expect(sessionStateDirForWorkspace(path.join(sessionDir, "workspace"))).toBe(
      sessionStateDir(sessionDir),
    );
  });

  // SHI-286 — the pre-`workspace/` flat layout (sessionDir === workspaceDir) is
  // no longer serviceable. It must NOT degrade into a bare `path.dirname`: that
  // yields `<sessionsRoot>/state` for every flat session on the host — one
  // directory, one shared `.install-done` between all of them. Nor may it return
  // a "no state dir" sentinel, which is what used to let callers keep writing
  // ShipIt's artifacts into the user's clone. It refuses.
  it("throws on the legacy flat layout instead of collapsing into sessionsRoot", () => {
    expect(() => sessionStateDirForWorkspace("/data/sessions/abc")).toThrow(
      /<sessionDir>\/workspace/,
    );
  });

  it("never hands two flat-layout clones the same directory (it hands them none)", () => {
    expect(() => sessionStateDirForWorkspace("/data/sessions/abc")).toThrow();
    expect(() => sessionStateDirForWorkspace("/data/sessions/def")).toThrow();
  });

  // A clone with a trailing slash still names the `workspace` segment — the
  // shape the production census checked for separately.
  it("accepts a trailing-slash clone path", () => {
    expect(sessionStateDirForWorkspace("/data/sessions/abc/workspace/")).toBe(
      path.join("/data/sessions/abc", SESSION_STATE_SUBDIR),
    );
  });

  // The resolved state dir is a SIBLING of the clone, never inside it — the
  // property that used to need a separate containment check on the container
  // side. Deriving both sides from this one function makes it structural.
  it("resolves outside the clone it was derived from", () => {
    const clone = "/data/sessions/abc/workspace";
    const rel = path.relative(clone, sessionStateDirForWorkspace(clone));
    expect(rel.startsWith("..")).toBe(true);
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
    // SHI-285 — a session upgraded from a ShipIt that ran Docker-secrets mode
    // has this one too; req 6 covers what earlier versions left behind.
    fs.writeFileSync(path.join(shipitDir(), "secrets-entrypoint.sh"), "#!/bin/sh\n");

    const removed = sweepLegacyCloneArtifacts(clone);

    expect(removed.sort()).toEqual(
      [".env.agent", ".install-done", "ci-logs", "compose.override.yml", "secrets-entrypoint.sh"].sort(),
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
