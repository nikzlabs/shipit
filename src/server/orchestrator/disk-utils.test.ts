import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reclaimRegenerableSessionDirs, reclaimBlockedSessionCaches, REGENERABLE_SESSION_SUBDIRS } from "./disk-utils.js";

describe("reclaimRegenerableSessionDirs (SHI-192)", () => {
  let tmpDir: string;
  let sessionRoot: string;
  let workspaceDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reclaim-test-"));
    sessionRoot = path.join(tmpDir, "sessions", "sess-1");
    workspaceDir = path.join(sessionRoot, "workspace");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes the workspace checkout AND the overlay sibling", async () => {
    fs.mkdirSync(path.join(workspaceDir, ".git"), { recursive: true });
    fs.mkdirSync(path.join(sessionRoot, "overlay", "hash", "upper"), { recursive: true });

    const { removed, failed } = await reclaimRegenerableSessionDirs(workspaceDir);

    expect(failed).toEqual([]);
    expect(removed).toEqual([
      path.join(sessionRoot, "workspace"),
      path.join(sessionRoot, "overlay"),
    ]);
    expect(fs.existsSync(workspaceDir)).toBe(false);
    expect(fs.existsSync(path.join(sessionRoot, "overlay"))).toBe(false);
  });

  it("preserves durable siblings (uploads/) — never a blanket rm of the session root", async () => {
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(path.join(sessionRoot, "overlay"), { recursive: true });
    fs.mkdirSync(path.join(sessionRoot, "uploads"), { recursive: true });
    fs.writeFileSync(path.join(sessionRoot, "uploads", "photo.png"), "x");

    await reclaimRegenerableSessionDirs(workspaceDir);

    expect(fs.existsSync(sessionRoot)).toBe(true);
    expect(fs.existsSync(path.join(sessionRoot, "uploads", "photo.png"))).toBe(true);
  });

  it("skips a missing target without counting it (orphan overlay, workspace already gone)", async () => {
    // Only overlay/ exists — the workspace checkout was already reclaimed.
    fs.mkdirSync(path.join(sessionRoot, "overlay"), { recursive: true });

    const { removed, failed } = await reclaimRegenerableSessionDirs(workspaceDir);

    expect(failed).toEqual([]);
    expect(removed).toEqual([path.join(sessionRoot, "overlay")]);
  });

  it("is a no-op (no removals) when nothing regenerable exists", async () => {
    fs.mkdirSync(sessionRoot, { recursive: true });

    const { removed, failed } = await reclaimRegenerableSessionDirs(workspaceDir);

    expect(removed).toEqual([]);
    expect(failed).toEqual([]);
  });

  // SHI-293 — this used to assert the CONTENTS of REGENERABLE_SESSION_SUBDIRS,
  // which is worthless as a guard: the reclaim built its target list by hand and
  // never read the constant, so docs/246's addition of `state` passed the test
  // and changed nothing. The marker kept outliving the clone it describes.
  // Assert the EFFECT instead — every listed subdir is actually removed.
  it("removes every subdir named in REGENERABLE_SESSION_SUBDIRS", async () => {
    for (const sub of REGENERABLE_SESSION_SUBDIRS) {
      fs.mkdirSync(path.join(sessionRoot, sub, "content"), { recursive: true });
    }
    fs.mkdirSync(path.join(sessionRoot, "uploads"), { recursive: true });

    await reclaimRegenerableSessionDirs(workspaceDir);

    for (const sub of REGENERABLE_SESSION_SUBDIRS) {
      expect(fs.existsSync(path.join(sessionRoot, sub)), `${sub} should be reclaimed`).toBe(false);
    }
    expect(fs.existsSync(path.join(sessionRoot, "uploads"))).toBe(true);
  });

  // The specific regression: the install marker must not survive the checkout it
  // describes, or the restored session skips an install it needs.
  it("reclaims the state dir, so the install marker cannot outlive the clone", async () => {
    fs.mkdirSync(path.join(sessionRoot, "state", "shared"), { recursive: true });
    fs.writeFileSync(path.join(sessionRoot, "state", "shared", ".install-done"), "{}");
    fs.mkdirSync(workspaceDir, { recursive: true });

    const { removed } = await reclaimRegenerableSessionDirs(workspaceDir);

    expect(removed).toContain(path.join(sessionRoot, "state"));
    expect(fs.existsSync(path.join(sessionRoot, "state", "shared", ".install-done"))).toBe(false);
  });
});

// SHI-294 — the partial reclaim used when an eviction is blocked because the
// checkout is the only copy of some work: take the regenerable install-delta
// cache, leave everything that can't be restored.
describe("reclaimBlockedSessionCaches (SHI-294)", () => {
  let tmpDir: string;
  let sessionRoot: string;
  let workspaceDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reclaim-overlay-"));
    sessionRoot = path.join(tmpDir, "sessions", "sess-1");
    workspaceDir = path.join(sessionRoot, "workspace");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const markerFile = () => path.join(sessionRoot, "state", "shared", ".install-done");

  it("removes overlay/ while leaving the checkout and durable siblings alone", async () => {
    fs.mkdirSync(path.join(workspaceDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "src", "wip.ts"), "uncommittable work");
    fs.mkdirSync(path.join(sessionRoot, "overlay", "hash", "upper"), { recursive: true });
    fs.mkdirSync(path.join(sessionRoot, "uploads"), { recursive: true });
    fs.mkdirSync(path.join(sessionRoot, "state", "shared"), { recursive: true });
    fs.writeFileSync(path.join(sessionRoot, "state", "ci-logs.json"), "regenerable, but not ours");

    const { removed, message } = await reclaimBlockedSessionCaches(workspaceDir);

    expect(message).toBeUndefined();
    expect(removed).toEqual([path.join(sessionRoot, "overlay")]);
    expect(fs.existsSync(path.join(sessionRoot, "overlay"))).toBe(false);
    // The whole point: the work that can't be recovered stays.
    expect(fs.existsSync(path.join(workspaceDir, "src", "wip.ts"))).toBe(true);
    expect(fs.existsSync(path.join(sessionRoot, "uploads"))).toBe(true);
    // Only the marker is taken from state/ — the rest of the dir is untouched.
    expect(fs.existsSync(path.join(sessionRoot, "state", "ci-logs.json"))).toBe(true);
  });

  // The upper and the marker must move together: with the upper gone, the dep
  // dir remounts over a POPULATED shared lower, so the present-but-empty
  // contradiction check never fires and a surviving marker would skip the
  // install — leaving the session with the base's deps and none of its own.
  it("takes the install marker with the overlay", async () => {
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(path.join(sessionRoot, "overlay"), { recursive: true });
    fs.mkdirSync(path.dirname(markerFile()), { recursive: true });
    fs.writeFileSync(markerFile(), JSON.stringify({ sourceCommit: "abc" }));

    const { removed } = await reclaimBlockedSessionCaches(workspaceDir);

    expect(removed).toContain(markerFile());
    expect(fs.existsSync(markerFile())).toBe(false);
  });

  it("is an idempotent no-op when there is nothing to reclaim", async () => {
    fs.mkdirSync(workspaceDir, { recursive: true });

    expect(await reclaimBlockedSessionCaches(workspaceDir)).toEqual({ removed: [] });
    expect(await reclaimBlockedSessionCaches(workspaceDir)).toEqual({ removed: [] });
    expect(fs.existsSync(workspaceDir)).toBe(true);
  });
});
