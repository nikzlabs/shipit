import { describe, it, expect, vi } from "vitest";
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
  generationId: "a".repeat(40),
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
    expect(spec.orchDirs.upperdir).toBe(`${pluginWorkDir(base.stateDir, "tools", base.generationId)}/upper`);
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

  it("distinguishes a rebuild of a commit from the build it was made beside", () => {
    const commit = "a".repeat(40);
    const first = pluginOverlayVolumeName(base.sessionId, "tools", commit);
    const rebuilt = pluginOverlayVolumeName(base.sessionId, "tools", `${commit}.deadbeef`);
    expect(rebuilt).not.toBe(first);
    expect(rebuilt).not.toBe(pluginOverlayVolumeName(base.sessionId, "tools", `${commit}.feedface`));
    expect(first).toBe(`shipit-${base.sessionId.slice(0, 12)}_plugin-tools-${
      /-([0-9a-f]{8})-a{12}$/.exec(first)![1]}-${commit.slice(0, 12)}`);
  });

  it("keeps the session-prefixed shape orphan collection looks for", () => {
    expect(pluginOverlayVolumeName(base.sessionId, "tools", base.generationId))
      .toMatch(/^shipit-0123abcd-456_plugin-tools-[0-9a-f]{8}-a{12}$/);
  });

  it("is reclaimable by the disk janitor's orphan sweep", () => {
    const name = pluginOverlayVolumeName(base.sessionId, "tools", base.generationId);
    const match = /^shipit-([a-f0-9-]{12})_/.exec(name);
    expect(match?.[1]).toBe(base.sessionId.slice(0, 12));
  });

  it("renders an awkward repo name into something a volume name can hold", () => {
    expect(pluginOverlayVolumeName(base.sessionId, "My Tools/v2!", base.generationId))
      .toMatch(/^shipit-0123abcd-456_plugin-my-tools-v2-[0-9a-f]{8}-a{12}$/);
  });
});

describe("ensurePluginRuntimeOverlay", () => {
  function fakeDocker(seed?: {
    name: string;
    options?: Record<string, string> | null;
    held?: boolean;
  }) {
    const live = new Set<string>();
    const creates: string[] = [];
    const removes: string[] = [];
    const containerRemoves: string[] = [];
    const notFound = (): never => {
      throw Object.assign(new Error("no such volume"), { statusCode: 404 });
    };
    const opts = new Map<string, { Options?: Record<string, string> | null; Labels?: Record<string, string> }>();
    if (seed) {
      live.add(seed.name);
      opts.set(seed.name, { Options: seed.options ?? null });
    }
    const docker = {
      createVolume: async (spec: { Name: string; DriverOpts?: Record<string, string>; Labels?: Record<string, string> }) => {
        creates.push(spec.Name);
        // Docker ignores new options for an existing volume name.
        if (live.has(spec.Name)) return;
        live.add(spec.Name);
        opts.set(spec.Name, { Options: spec.DriverOpts, Labels: spec.Labels });
      },
      getVolume: (name: string) => ({
        inspect: async () => {
          if (!live.has(name)) notFound();
          return { Mountpoint: `/var/lib/docker/volumes/${name}/_data`, ...(opts.get(name) ?? {}) };
        },
        remove: async () => {
          if (!live.has(name)) notFound();
          if (seed?.held && name === seed.name) {
            throw Object.assign(new Error("volume is in use"), { statusCode: 409 });
          }
          removes.push(name);
          live.delete(name);
        },
      }),
      listContainers: async () => (
        seed?.held ? [{ Id: "holder-1", Names: ["/cli-1"] }] : []
      ),
      getContainer: (id: string) => ({
        remove: async () => { containerRemoves.push(id); },
      }),
    };
    return { docker: docker as unknown as Docker, creates, removes, containerRemoves, opts };
  }

  const args = (stateDir: string) => ({
    sessionId: base.sessionId,
    repoName: "tools",
    generationId: base.generationId,
    stateDir,
    checkoutDir: path.join(stateDir, "plugins", "tools", "generations", base.generationId),
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
      expect(creates).toHaveLength(1);
      expect(removes).toEqual([]);
      expect(fs.existsSync(path.join(pluginWorkDir(stateDir, "tools", base.generationId), "upper"))).toBe(true);
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

  it("repairs a plain impostor volume instead of latching on it", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-overlay-"));
    try {
      const name = pluginOverlayVolumeName(base.sessionId, "tools", base.generationId);
      const { docker, creates, removes, opts } = fakeDocker({ name, options: null });
      await ensurePluginRuntimeOverlay(docker, args(stateDir));
      expect(removes).toEqual([name]);
      expect(creates).toEqual([name]);
      expect(opts.get(name)?.Options?.type).toBe("overlay");
      expect(opts.get(name)?.Options?.o).toContain("lowerdir=");
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("repairs a concurrent pair of first consumers against one impostor exactly once", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-overlay-"));
    try {
      const name = pluginOverlayVolumeName(base.sessionId, "tools", base.generationId);
      const { docker, creates, removes } = fakeDocker({ name, options: null });
      const [a, b] = await Promise.all([
        ensurePluginRuntimeOverlay(docker, args(stateDir)),
        ensurePluginRuntimeOverlay(docker, args(stateDir)),
      ]);
      expect(a).toBe(b);
      expect(removes).toEqual([name]);
      expect(creates).toEqual([name]);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("throws on a held impostor rather than mounting it, and does not evict the holder", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-overlay-"));
    try {
      const name = pluginOverlayVolumeName(base.sessionId, "tools", base.generationId);
      const { docker, removes, containerRemoves } = fakeDocker({ name, options: null, held: true });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await expect(ensurePluginRuntimeOverlay(docker, args(stateDir)))
          .rejects.toThrow(/could not be recreated with the requested driver opts/);
        expect(removes).toEqual([]);
        expect(containerRemoves).toEqual([]);
      } finally {
        warn.mockRestore();
      }
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("buildPluginOverlaySpec with shared dependency bases", () => {
  it("stacks each base BELOW the checkout, and translates them too", () => {
    const spec = buildPluginOverlaySpec({
      ...base,
      depBases: ["/workspace/overlay-base/aaaa/g1", "/workspace/overlay-base/bbbb/g2"],
      volumeMountpoint: "/var/lib/docker/volumes/shipit-workspace/_data",
      stateRoot: "/workspace",
    });

    const lowerdirs = spec.lowerdir.split(":");
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
  function fakeDocker() {
    const live = new Set<string>();
    const creates: { Name: string; DriverOpts?: Record<string, string>; Labels?: Record<string, string> }[] = [];
    const docker = {
      createVolume: async (spec: { Name: string; DriverOpts?: Record<string, string>; Labels?: Record<string, string> }) => {
        creates.push(spec);
        live.add(spec.Name);
      },
      getVolume: (name: string) => ({
        inspect: async () => {
          if (!live.has(name)) throw Object.assign(new Error("no such volume"), { statusCode: 404 });
          const created = creates.find((c) => c.Name === name);
          return {
            Mountpoint: `/var/lib/docker/volumes/${name}/_data`,
            Options: created?.DriverOpts,
            Labels: created?.Labels,
          };
        },
        remove: async () => {
          if (!live.has(name)) throw Object.assign(new Error("no such volume"), { statusCode: 404 });
          live.delete(name);
        },
      }),
    };
    return { docker: docker as unknown as Docker, creates };
  }

  function generation(stateDir: string, pins: string[]): string {
    const dir = path.join(stateDir, "plugins", "tools", "generations", base.generationId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".shipit-generation.json"),
      JSON.stringify({ repoName: "tools", source: "acme/tools", commit: base.generationId, basePins: pins }),
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
        sessionId: base.sessionId, repoName: "tools", generationId: base.generationId,
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
      await expect(ensurePluginRuntimeOverlay(docker, {
        sessionId: base.sessionId, repoName: "tools", generationId: base.generationId,
        stateDir, checkoutDir, depStoreDir: stateDir,
      })).rejects.toThrow(/shared dependency layer/);
      expect(creates).toHaveLength(0);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
