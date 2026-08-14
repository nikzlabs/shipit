/**
 * docs/262 — the copy-on-write layer for a plugin generation. The value here is
 * the DAEMON-HOST path translation: get it wrong and volume creation succeeds
 * while the mount comes up empty, a long way from the cause.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Docker from "dockerode";
import {
  buildPluginOverlaySpec,
  ensurePluginRuntimeOverlay,
  pluginOverlayVolumeName,
  pluginWorkDir,
} from "./plugin-overlay.js";

const base = {
  sessionId: "0123abcd-4567-89ef-0123-456789abcdef",
  repoName: "tools",
  commit: "a".repeat(40),
  stateDir: "/workspace/sessions/sess-1/state",
  checkoutDir: `/workspace/sessions/sess-1/state/plugins/tools/generations/${"a".repeat(40)}`,
};

describe("buildPluginOverlaySpec", () => {
  it("translates every path onto the daemon's view of the state volume", () => {
    const spec = buildPluginOverlaySpec({
      ...base,
      stateRoot: "/workspace",
      volumeMountpoint: "/var/lib/docker/volumes/shipit-workspace/_data",
    });

    const root = "/var/lib/docker/volumes/shipit-workspace/_data/sessions/sess-1/state/plugins/tools";
    expect(spec.lowerdir).toBe(`${root}/generations/${"a".repeat(40)}`);
    expect(spec.upperdir).toBe(`${root}/work/${"a".repeat(40)}/upper`);
    expect(spec.workdir).toBe(`${root}/work/${"a".repeat(40)}/work`);
    // Nothing daemon-side may leak the orchestrator's own root.
    for (const p of [spec.lowerdir, spec.upperdir, spec.workdir]) {
      expect(p.startsWith("/var/lib/docker/")).toBe(true);
    }
  });

  it("keeps orchestrator paths separately, because it must mkdir them itself", () => {
    const spec = buildPluginOverlaySpec({
      ...base,
      stateRoot: "/workspace",
      volumeMountpoint: "/var/lib/docker/volumes/shipit-workspace/_data",
    });
    expect(spec.orchDirs.upperdir).toBe(`${pluginWorkDir(base.stateDir, "tools", base.commit)}/upper`);
    expect(spec.orchDirs.lowerdir).toBe(base.checkoutDir);
    expect(spec.orchDirs.upperdir).not.toBe(spec.upperdir);
  });

  it("is the identity in dev, where both sides see one path", () => {
    const spec = buildPluginOverlaySpec(base);
    expect(spec.lowerdir).toBe(base.checkoutDir);
    expect(spec.upperdir).toBe(spec.orchDirs.upperdir);
  });

  it("leaves a path outside the state root alone rather than rewriting it", () => {
    const spec = buildPluginOverlaySpec({
      ...base,
      checkoutDir: "/elsewhere/checkout",
      stateRoot: "/workspace",
      volumeMountpoint: "/var/lib/docker/volumes/shipit-workspace/_data",
    });
    expect(spec.lowerdir).toBe("/elsewhere/checkout");
  });

  // Install runs against the STAGING dir, which publish then renames. Both
  // lowerdirs share ONE upper layer — which is why the install volume must be
  // removed before the runtime volume is created (the kernel forbids two
  // independently created mounts over one upperdir).
  it("gives staging and published lowerdirs the same upper layer", () => {
    const staging = buildPluginOverlaySpec({ ...base, checkoutDir: `${base.checkoutDir}.staging-ab12cd34` });
    const published = buildPluginOverlaySpec(base);

    expect(staging.lowerdir).not.toBe(published.lowerdir);
    expect(staging.upperdir).toBe(published.upperdir);
    expect(staging.workdir).toBe(published.workdir);
    expect(staging.volumeName).toBe(published.volumeName);
  });
});

describe("pluginOverlayVolumeName", () => {
  it("is per generation, not per repository", () => {
    const a = pluginOverlayVolumeName(base.sessionId, "tools", "a".repeat(40));
    const b = pluginOverlayVolumeName(base.sessionId, "tools", "b".repeat(40));
    expect(a).not.toBe(b);
  });

  it("keeps the session-prefixed shape orphan collection looks for", () => {
    expect(pluginOverlayVolumeName(base.sessionId, "tools", base.commit))
      .toMatch(/^shipit-0123abcd-456_plugin-tools-[0-9a-f]{8}-a{12}$/);
  });

  // Verified against the sweep itself, not against the convention as described:
  // `sweepOrphanSessionVolumes` matches this exact pattern and compares the
  // capture with `sessionId.slice(0, 12)`. An 8-character prefix — the first
  // version of this name — does not match at all, so an orphaned volume would
  // never be reclaimed.
  it("is reclaimable by the disk janitor's orphan sweep", () => {
    const name = pluginOverlayVolumeName(base.sessionId, "tools", base.commit);
    const match = /^shipit-([a-f0-9-]{12})_/.exec(name);
    expect(match?.[1]).toBe(base.sessionId.slice(0, 12));
  });

  it("renders an awkward repo name into something a volume name can hold", () => {
    expect(pluginOverlayVolumeName(base.sessionId, "My Tools/v2!", base.commit))
      .toMatch(/^shipit-0123abcd-456_plugin-my-tools-v2-[0-9a-f]{8}-a{12}$/);
  });
});

/**
 * `ensurePluginRuntimeOverlay` is deliberately an *ensure*: the CLI invocation
 * container and a plugin service both attach ONE volume per generation, and the
 * kernel forbids one upperdir backing two independently created overlay mounts.
 * So two first-consumers arriving together is the ordinary case, not an edge —
 * and `createOverlayVolume` REMOVES an existing same-name volume before
 * creating it, which is what makes the naive check-then-create destructive
 * (review finding).
 */
describe("ensurePluginRuntimeOverlay", () => {
  function fakeDocker() {
    const live = new Set<string>();
    const creates: string[] = [];
    const removes: string[] = [];
    const notFound = (): never => {
      throw Object.assign(new Error("no such volume"), { statusCode: 404 });
    };
    const docker = {
      createVolume: async (spec: { Name: string }) => {
        creates.push(spec.Name);
        live.add(spec.Name);
      },
      getVolume: (name: string) => ({
        inspect: async () => {
          if (!live.has(name)) notFound();
          return { Mountpoint: `/var/lib/docker/volumes/${name}/_data` };
        },
        remove: async () => {
          // 404 when absent, like the daemon — `createOverlayVolume` calls
          // remove-if-exists unconditionally, and counting those would hide the
          // destructive case this test is about.
          if (!live.has(name)) notFound();
          removes.push(name);
          live.delete(name);
        },
      }),
    };
    return { docker: docker as unknown as Docker, creates, removes };
  }

  const args = (stateDir: string) => ({
    sessionId: base.sessionId,
    repoName: "tools",
    commit: base.commit,
    stateDir,
    checkoutDir: path.join(stateDir, "plugins", "tools", "generations", base.commit),
  });

  it("creates the volume exactly once for concurrent first consumers", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-overlay-"));
    try {
      const { docker, creates, removes } = fakeDocker();
      const [a, b] = await Promise.all([
        ensurePluginRuntimeOverlay(docker, args(stateDir)),
        ensurePluginRuntimeOverlay(docker, args(stateDir)),
      ]);

      expect(a).toBe(b);
      // Without the queue both callers see "missing" and the second one deletes
      // the volume the first just created.
      expect(creates).toHaveLength(1);
      expect(removes).toEqual([]);
      // And the layer it points at is there, uncleared — install output
      // lives in `upper/` and this must never be the thing that wipes it.
      expect(fs.existsSync(path.join(pluginWorkDir(stateDir, "tools", base.commit), "upper"))).toBe(true);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("returns an existing volume untouched", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-overlay-"));
    try {
      const { docker, creates, removes } = fakeDocker();
      await ensurePluginRuntimeOverlay(docker, args(stateDir));
      await ensurePluginRuntimeOverlay(docker, args(stateDir));
      expect(creates).toHaveLength(1);
      expect(removes).toEqual([]);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// req 28 — shared dependency bases stacked under the checkout
// ---------------------------------------------------------------------------

describe("buildPluginOverlaySpec with shared dependency bases", () => {
  it("stacks each base BELOW the checkout, and translates them too", () => {
    const spec = buildPluginOverlaySpec({
      ...base,
      depBases: ["/workspace/overlay-base/aaaa/g1", "/workspace/overlay-base/bbbb/g2"],
      volumeMountpoint: "/var/lib/docker/volumes/shipit-workspace/_data",
      stateRoot: "/workspace",
    });

    const lowerdirs = spec.lowerdir.split(":");
    // The repository's own files win over anything a base supplies — a base
    // only ever holds a directory install created, and the checkout is the
    // higher-priority layer by construction.
    expect(lowerdirs[0]).toContain("/plugins/tools/generations/");
    expect(lowerdirs.slice(1)).toEqual([
      "/var/lib/docker/volumes/shipit-workspace/_data/overlay-base/aaaa/g1",
      "/var/lib/docker/volumes/shipit-workspace/_data/overlay-base/bbbb/g2",
    ]);
  });

  it("is byte-identical to the pre-req-28 spec when nothing is pinned", () => {
    expect(buildPluginOverlaySpec({ ...base, depBases: [] }))
      .toEqual(buildPluginOverlaySpec(base));
  });
});

describe("ensurePluginRuntimeOverlay with shared dependency bases", () => {
  /** Records the driver options, which is where the lowerdir stack shows up. */
  function fakeDocker() {
    const live = new Set<string>();
    const creates: { Name: string; DriverOpts?: Record<string, string> }[] = [];
    const docker = {
      createVolume: async (spec: { Name: string; DriverOpts?: Record<string, string> }) => {
        creates.push(spec);
        live.add(spec.Name);
      },
      getVolume: (name: string) => ({
        inspect: async () => {
          if (!live.has(name)) throw Object.assign(new Error("no such volume"), { statusCode: 404 });
          return { Mountpoint: `/var/lib/docker/volumes/${name}/_data` };
        },
        remove: async () => {
          if (!live.has(name)) throw Object.assign(new Error("no such volume"), { statusCode: 404 });
          live.delete(name);
        },
      }),
    };
    return { docker: docker as unknown as Docker, creates };
  }

  /** A published generation whose record pins `pins`. */
  function generation(stateDir: string, pins: string[]): string {
    const dir = path.join(stateDir, "plugins", "tools", "generations", base.commit);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".shipit-generation.json"),
      JSON.stringify({ repoName: "tools", source: "acme/tools", commit: base.commit, basePins: pins }),
    );
    return dir;
  }

  it("mounts the bases the generation itself recorded", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-overlay-"));
    try {
      const { docker, creates } = fakeDocker();
      const checkoutDir = generation(stateDir, [`${"a".repeat(16)}/g1`]);
      fs.mkdirSync(path.join(stateDir, "overlay-base", "a".repeat(16), "g1"), { recursive: true });

      await ensurePluginRuntimeOverlay(docker, {
        sessionId: base.sessionId, repoName: "tools", commit: base.commit,
        stateDir, checkoutDir, depStoreDir: stateDir,
      });

      const o = creates[0]!.DriverOpts!.o;
      expect(o).toContain(`:${path.join(stateDir, "overlay-base", "a".repeat(16), "g1")},upperdir=`);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("refuses rather than mounting a plugin without the dependencies it pinned", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-overlay-"));
    try {
      const { docker, creates } = fakeDocker();
      const checkoutDir = generation(stateDir, [`${"b".repeat(16)}/g1`]);
      // The base is gone. Mounting anyway produces a plugin whose dependencies
      // are silently absent — a "cannot find module" minutes later, with
      // nothing naming the cause.
      await expect(ensurePluginRuntimeOverlay(docker, {
        sessionId: base.sessionId, repoName: "tools", commit: base.commit,
        stateDir, checkoutDir, depStoreDir: stateDir,
      })).rejects.toThrow(/shared dependency layer/);
      expect(creates).toHaveLength(0);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
