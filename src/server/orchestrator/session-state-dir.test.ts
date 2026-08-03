import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
    expect(resolveContainerStateDir("/data/sessions/abc", "/data/sessions/abc/workspace")).toBe(
      path.resolve("/data/sessions/abc/state"),
    );
  });

  // The legacy flat layout would otherwise put `<clone>/state` INSIDE the user's
  // repository — worse than the bug this feature fixes, since it isn't under
  // `.shipit/` and neither the sweep nor the req-7 guard would notice it.
  it("returns null when the state dir would land inside the clone (flat layout)", () => {
    expect(resolveContainerStateDir("/data/sessions/abc", "/data/sessions/abc")).toBeNull();
  });

  it("returns null when workspaceDir is absent and so defaults to the session dir", () => {
    expect(resolveContainerStateDir("/data/sessions/abc", undefined)).toBeNull();
  });

  it("is not fooled by a non-normalized clone path", () => {
    expect(resolveContainerStateDir("/data/sessions/abc", "/data/sessions/abc/")).toBeNull();
  });
});

describe("sweepLegacyCloneArtifacts (docs/246 req 6)", () => {
  let clone: string;
  const shipitDir = () => path.join(clone, ".shipit");

  beforeEach(() => {
    clone = fs.mkdtempSync(path.join(os.tmpdir(), "clone-sweep-"));
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

  it("is idempotent", () => {
    fs.writeFileSync(path.join(shipitDir(), ".install-done"), "{}");
    expect(sweepLegacyCloneArtifacts(clone)).toEqual([".install-done"]);
    expect(sweepLegacyCloneArtifacts(clone)).toEqual([]);
  });
});
