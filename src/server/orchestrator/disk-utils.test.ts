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

  // The allowlist is the safety property (SHI-192: never blanket-`rm` the
  // session root and take `uploads/` with it), so every addition is deliberate
  // and lands here. `state` joined it in docs/246: ShipIt's generated state is
  // regenerable, and the install marker DESCRIBES the checkout — leaving it
  // behind when `workspace/` is reclaimed makes it outlive the clone it refers
  // to, so the restored session skips an install it needs and comes back
  // dep-less.
  it("only ever targets the allowlisted regenerable subdirs", () => {
    expect(REGENERABLE_SESSION_SUBDIRS).toEqual(["workspace", "overlay", "state"]);
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
