import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildOverlaySpecs, type DepDirOverlaySpec } from "./overlay-session.js";
import { overlayDriverOpts } from "./overlay-volume.js";

function asRoot(cmd: string, args: string[]): { status: number | null; stderr: string } {
  const argv = process.getuid?.() === 0 ? [cmd, ...args] : ["sudo", "-n", cmd, ...args];
  return spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
}

interface Fixture {
  root: string;
  merged: string;
  spec: DepDirOverlaySpec;
  mounted: boolean;
}

const fixtures: Fixture[] = [];

// The base already holds an optimizer cache, as one captured from a session with a dev server does.
function baseWithOptimizerCache(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ovl-redirect-"));
  const [spec] = buildOverlaySpecs({
    sessionId: "session",
    scope: { repoUrl: "https://example.com/repo.git", runtimeKey: "img|x64" },
    depDirs: ["node_modules"],
    volumeMountpoint: root,
  });
  fs.mkdirSync(path.join(spec.lowerdir, ".vite", "deps"), { recursive: true });
  fs.writeFileSync(path.join(spec.lowerdir, ".vite", "deps", "old.js"), "old");
  fs.mkdirSync(spec.upperdir, { recursive: true });
  fs.mkdirSync(spec.workdir, { recursive: true });
  const merged = path.join(root, "merged");
  fs.mkdirSync(merged);
  const fixture = { root, merged, spec, mounted: false };
  fixtures.push(fixture);
  return fixture;
}

function mount(fixture: Fixture, opts: string): { status: number | null; stderr: string } {
  const res = asRoot("mount", ["-t", "overlay", "overlay", "-o", opts, fixture.merged]);
  fixture.mounted = res.status === 0;
  return res;
}

function unmountAll(): void {
  for (const fixture of fixtures.splice(0)) {
    if (fixture.mounted) {
      const res = asRoot("umount", [fixture.merged]);
      // Deleting the tree under a live mount would delete through the merged view.
      if (res.status !== 0) throw new Error(`could not unmount ${fixture.merged}: ${res.stderr}`);
      // The kernel leaves root-owned entries in the work and upper dirs.
      asRoot("rm", ["-rf", fixture.root]);
    }
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

// A redirect is a trusted.* xattr, which a user namespace cannot write: this needs real root.
const canMount = (() => {
  if (process.platform !== "linux") return false;
  try {
    const fixture = baseWithOptimizerCache();
    return mount(fixture, overlayDriverOpts(fixture.spec)).status === 0;
  } finally {
    unmountAll();
  }
})();

// Vite's optimizer commit: retire the live cache directory, then move the new one into place.
function commitOptimizerRun(merged: string): { deps: string; retired: string } {
  const cache = path.join(merged, ".vite");
  const deps = path.join(cache, "deps");
  const processing = path.join(cache, "deps_temp_new");
  const retired = path.join(cache, "deps_temp_old");
  fs.mkdirSync(processing);
  fs.writeFileSync(path.join(processing, "new.js"), "new");
  fs.renameSync(deps, retired);
  fs.renameSync(processing, deps);
  return { deps, retired };
}

describe("renaming a directory that lives in a dep-dir overlay's base", () => {
  afterEach(unmountAll);

  // A session container cannot mount, so the cases below skip there; CI must not skip them silently.
  it.runIf(process.env.GITHUB_ACTIONS === "true")("can mount an overlay on a CI runner", () => {
    expect(canMount).toBe(true);
  });

  it.runIf(canMount)("replaces a cache directory the base holds, under the options a session mounts with", () => {
    const fixture = baseWithOptimizerCache();
    expect(mount(fixture, overlayDriverOpts(fixture.spec))).toMatchObject({ status: 0 });

    const { deps, retired } = commitOptimizerRun(fixture.merged);

    expect(fs.readdirSync(deps)).toEqual(["new.js"]);
    expect(fs.readFileSync(path.join(retired, "old.js"), "utf8")).toBe("old");
    fs.rmSync(retired, { recursive: true });
    expect(fs.readdirSync(path.join(fixture.merged, ".vite"))).toEqual(["deps"]);
    // The base is shared by every session of the repo and must not change.
    expect(fs.readdirSync(path.join(fixture.spec.lowerdir, ".vite", "deps"))).toEqual(["old.js"]);
  });

  it.runIf(canMount)("fails with EXDEV without the redirect option", () => {
    const fixture = baseWithOptimizerCache();
    const opts = `${overlayDriverOpts({ ...fixture.spec, redirectDir: false })},redirect_dir=off`;
    expect(mount(fixture, opts)).toMatchObject({ status: 0 });

    expect(() => commitOptimizerRun(fixture.merged)).toThrow(/EXDEV/);
  });
});
