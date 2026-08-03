import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reclaimRegenerableSessionDirs, REGENERABLE_SESSION_SUBDIRS } from "./disk-utils.js";

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
