import { afterEach, beforeEach, describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptyDepDirsContradictingMarker, overlayMountedDepDirs } from "./overlay-dep-check.js";

/**
 * docs/183 — install-marker dep-dir contradiction check. The overlay-mount
 * labeling parser (`overlayMountedDepDirs`) is pure and covered first; the
 * fs-coupled emptiness decision (`emptyDepDirsContradictingMarker`) reads the
 * shipit config + does a non-recursive readdir per dep dir, exercised against
 * real temp workspaces below. The mount type (overlay vs plain) only affects the
 * log label, never the reinstall decision, so an empty plain dir is detected
 * exactly like an empty overlay mount would be.
 */

function mounts(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

describe("overlayMountedDepDirs", () => {
  it("returns dep dirs whose exact mount point is an overlay mount", () => {
    const text = mounts([
      "overlay / overlay rw,relatime,lowerdir=/a:/b,upperdir=/u,workdir=/w 0 0",
      "tmpfs /dev tmpfs rw,nosuid 0 0",
      "ext4 /workspace ext4 rw,relatime 0 0",
      "overlay /workspace/node_modules overlay rw,relatime,lowerdir=/base,upperdir=/up,workdir=/wk 0 0",
    ]);
    expect(overlayMountedDepDirs(text, "/workspace", ["node_modules"])).toEqual(["node_modules"]);
  });

  it("does not match the container root overlay or non-overlay mounts at the dep dir", () => {
    const text = mounts([
      "overlay / overlay rw 0 0",
      "ext4 /workspace/node_modules ext4 rw 0 0",
    ]);
    expect(overlayMountedDepDirs(text, "/workspace", ["node_modules"])).toEqual([]);
  });

  it("handles multiple declared dep dirs, returning only the overlay-mounted ones", () => {
    const text = mounts([
      "overlay /workspace/packages/app/node_modules overlay rw 0 0",
    ]);
    expect(
      overlayMountedDepDirs(text, "/workspace", ["node_modules", "packages/app/node_modules"]),
    ).toEqual(["packages/app/node_modules"]);
  });

  it("returns [] for empty input or no dep dirs", () => {
    expect(overlayMountedDepDirs("", "/workspace", ["node_modules"])).toEqual([]);
    expect(overlayMountedDepDirs("overlay /workspace/node_modules overlay rw 0 0", "/workspace", [])).toEqual([]);
  });
});

describe("emptyDepDirsContradictingMarker", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-depcheck-"));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("flags a present-but-EMPTY default dep dir (the flag-rollback signature)", () => {
    // Default config (no shipit.yaml) → dep dirs = [node_modules]. An empty
    // node_modules is the leftover overlay mountpoint left behind after the flag
    // is rolled off — a matching marker must be distrusted.
    fs.mkdirSync(path.join(workspace, "node_modules"));
    expect(emptyDepDirsContradictingMarker(workspace)).toEqual([
      { depDir: "node_modules", overlay: false },
    ]);
  });

  it("does NOT flag a populated dep dir (skip preserved)", () => {
    fs.mkdirSync(path.join(workspace, "node_modules"));
    fs.writeFileSync(path.join(workspace, "node_modules", "x.js"), "//");
    expect(emptyDepDirsContradictingMarker(workspace)).toEqual([]);
  });

  it("does NOT flag an ABSENT dep dir (legit dep-less / non-Node repo)", () => {
    // node_modules never created — a repo whose install does not populate the
    // default dep dir keeps its marker-skip rather than reinstalling forever.
    expect(emptyDepDirsContradictingMarker(workspace)).toEqual([]);
  });

  it("respects the `agent.dep-dirs: []` opt-out even when a dir is empty", () => {
    fs.writeFileSync(path.join(workspace, "shipit.yaml"), "agent:\n  dep-dirs: []\n");
    fs.mkdirSync(path.join(workspace, "node_modules")); // empty, but opted out
    expect(emptyDepDirsContradictingMarker(workspace)).toEqual([]);
  });

  it("returns only the empty dep dirs when several are declared", () => {
    fs.writeFileSync(
      path.join(workspace, "shipit.yaml"),
      "agent:\n  dep-dirs:\n    - node_modules\n    - packages/app/node_modules\n",
    );
    // node_modules empty (contradicts); packages/app/node_modules populated (ok)
    fs.mkdirSync(path.join(workspace, "node_modules"));
    fs.mkdirSync(path.join(workspace, "packages", "app", "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "packages", "app", "node_modules", "dep.js"), "//");
    expect(emptyDepDirsContradictingMarker(workspace)).toEqual([
      { depDir: "node_modules", overlay: false },
    ]);
  });
});
