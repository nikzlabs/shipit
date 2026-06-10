import { describe, it, expect } from "vitest";
import { overlayMountedDepDirs } from "./overlay-dep-check.js";

/**
 * docs/183 — overlay-aware install-marker validation. The fs-coupled wrapper
 * (`overlayBackedEmptyDepDirs`) reads `/proc/self/mounts`, which only reflects
 * real overlay mounts inside a session container; the parsing + selection logic
 * is pure (`overlayMountedDepDirs`) and covered here.
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
