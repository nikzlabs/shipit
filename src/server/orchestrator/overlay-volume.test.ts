import { describe, it, expect, vi } from "vitest";
import type Docker from "dockerode";
import {
  overlayVolumeName,
  overlayScopeHash,
  overlayBaseDir,
  resolveVolumeMountpoint,
  createOverlayVolume,
  removeOverlayVolume,
  volumeExists,
  OVERLAY_MANAGED_LABEL,
  type OverlaySpec,
} from "./overlay-volume.js";

// A minimal dockerode stand-in: records createVolume calls and lets each test
// script getVolume(name) behaviour (inspect / remove).
function makeFakeDocker(opts: {
  inspect?: (name: string) => Promise<{ Mountpoint?: string }>;
  remove?: (name: string) => Promise<void>;
} = {}) {
  const created: { Name: string; Driver?: string; DriverOpts?: Record<string, string>; Labels?: Record<string, string> }[] = [];
  const removed: string[] = [];
  const docker = {
    createVolume: vi.fn(async (config: { Name: string }) => {
      created.push(config as (typeof created)[number]);
    }),
    getVolume: (name: string) => ({
      inspect: async () =>
        opts.inspect ? opts.inspect(name) : { Mountpoint: `/var/lib/docker/volumes/${name}/_data` },
      remove: async () => {
        removed.push(name);
        if (opts.remove) await opts.remove(name);
      },
    }),
  };
  return { docker: docker as unknown as Docker, created, removed };
}

function notFound(): Error & { statusCode: number } {
  const e = new Error("no such volume") as Error & { statusCode: number };
  e.statusCode = 404;
  return e;
}

/** Poll until `pred()` is true, or throw after `timeoutMs`. */
async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe("overlay naming helpers", () => {
  it("overlayVolumeName matches the disk-janitor orphan-volume regex", () => {
    const sessionId = "abcdef012345-6789-...";
    const name = overlayVolumeName(sessionId);
    expect(name).toBe("shipit-abcdef012345_overlay");
    // The sweep regex in disk-janitor.ts:
    expect(/^shipit-([a-f0-9-]{12})_/.exec(name)?.[1]).toBe("abcdef012345");
  });

  it("overlayScopeHash is deterministic and varies by repo + runtime", () => {
    const a = overlayScopeHash("https://github.com/o/r", "img|x64|glibc-2.31|node22");
    const a2 = overlayScopeHash("https://github.com/o/r", "img|x64|glibc-2.31|node22");
    const diffRepo = overlayScopeHash("https://github.com/o/other", "img|x64|glibc-2.31|node22");
    const diffRuntime = overlayScopeHash("https://github.com/o/r", "img|arm64|musl|node22");
    expect(a).toBe(a2);
    expect(a).toHaveLength(16);
    expect(a).not.toBe(diffRepo);
    expect(a).not.toBe(diffRuntime);
  });

  it("overlayScopeHash is not separator-confusable across the repo/runtime boundary", () => {
    // Without the NUL separator, ("ab","c") and ("a","bc") would collide.
    expect(overlayScopeHash("ab", "c")).not.toBe(overlayScopeHash("a", "bc"));
  });

  it("overlayScopeHash mixes in the dep dir, and omitting it reproduces the legacy hash", () => {
    const repo = "https://github.com/o/r";
    const rt = "img|x64";
    // Omitting depDir is byte-for-byte the old 2-arg hash (publish CAS unaffected).
    expect(overlayScopeHash(repo, rt, undefined)).toBe(overlayScopeHash(repo, rt));
    // A dep dir produces a distinct base, and different dep dirs don't collide.
    const nm = overlayScopeHash(repo, rt, "node_modules");
    const pkg = overlayScopeHash(repo, rt, "packages/app/node_modules");
    expect(nm).not.toBe(overlayScopeHash(repo, rt));
    expect(nm).not.toBe(pkg);
    expect(nm).toHaveLength(16);
    // Not separator-confusable on the dep-dir boundary either.
    expect(overlayScopeHash(repo, "a", "b")).not.toBe(overlayScopeHash(repo, "ab", ""));
  });

  it("overlayVolumeName with a dep dir is stable, distinct per dir, and still sweep-matchable", () => {
    const sessionId = "abcdef012345-6789-...";
    const nm = overlayVolumeName(sessionId, "node_modules");
    const pkg = overlayVolumeName(sessionId, "packages/app/node_modules");
    expect(nm).toMatch(/^shipit-abcdef012345_overlay-[a-f0-9]{8}$/);
    expect(nm).toBe(overlayVolumeName(sessionId, "node_modules")); // stable
    expect(nm).not.toBe(pkg); // distinct per dep dir
    // Still matches the disk-janitor orphan-volume sweep regex.
    expect(/^shipit-([a-f0-9-]{12})_/.exec(nm)?.[1]).toBe("abcdef012345");
  });

  it("overlayBaseDir places the base under overlay-base/<hash>, not dep-cache", () => {
    const dir = overlayBaseDir("/workspace", "0123456789abcdef");
    expect(dir).toBe("/workspace/overlay-base/0123456789abcdef");
    expect(dir).not.toContain("dep-cache");
  });
});

describe("resolveVolumeMountpoint", () => {
  it("returns the inspected Mountpoint", async () => {
    const { docker } = makeFakeDocker();
    expect(await resolveVolumeMountpoint(docker, "shipit-workspace")).toBe(
      "/var/lib/docker/volumes/shipit-workspace/_data",
    );
  });

  it("throws when the volume has no Mountpoint", async () => {
    const { docker } = makeFakeDocker({ inspect: async () => ({}) });
    await expect(resolveVolumeMountpoint(docker, "x")).rejects.toThrow(/no Mountpoint/);
  });
});

describe("createOverlayVolume", () => {
  const spec: OverlaySpec = {
    volumeName: "shipit-abcdef012345_overlay",
    lowerdir: "/data/overlay-base/h1",
    upperdir: "/data/sessions/s1/upper",
    workdir: "/data/sessions/s1/work",
  };

  it("creates a local type=overlay volume with the right opts + managed label", async () => {
    const { docker, created } = makeFakeDocker({ remove: async () => { throw notFound(); } });
    await createOverlayVolume(docker, spec, { "shipit-stack": "prod" });
    expect(created).toHaveLength(1);
    const c = created[0];
    expect(c.Name).toBe(spec.volumeName);
    expect(c.Driver).toBe("local");
    expect(c.DriverOpts).toEqual({
      type: "overlay",
      device: "overlay",
      o: `lowerdir=${spec.lowerdir},upperdir=${spec.upperdir},workdir=${spec.workdir}`,
    });
    expect(c.Labels?.[OVERLAY_MANAGED_LABEL]).toBe("true");
    expect(c.Labels?.["shipit-stack"]).toBe("prod");
  });

  it("removes a pre-existing volume of the same name before recreating", async () => {
    const { docker, created, removed } = makeFakeDocker(); // remove() succeeds (volume existed)
    await createOverlayVolume(docker, spec);
    expect(removed).toContain(spec.volumeName);
    expect(created).toHaveLength(1);
  });

  it("serializes concurrent creates (no interleaving)", async () => {
    // Track entry/exit order of createVolume to prove serialization.
    const order: string[] = [];
    let resolveFirst!: () => void;
    const firstGate = new Promise<void>((r) => { resolveFirst = r; });
    let call = 0;
    const docker = {
      createVolume: vi.fn(async (config: { Name: string }) => {
        const n = config.Name;
        order.push(`enter:${n}`);
        if (call++ === 0) await firstGate; // hold the first create open
        order.push(`exit:${n}`);
      }),
      getVolume: () => ({
        inspect: async () => ({ Mountpoint: "/x" }),
        remove: async () => { throw notFound(); },
      }),
    } as unknown as Docker;

    const p1 = createOverlayVolume(docker, { ...spec, volumeName: "vol-1" });
    const p2 = createOverlayVolume(docker, { ...spec, volumeName: "vol-2" });
    // Wait until vol-1 has entered createVolume (it is now held open).
    await waitFor(() => order.includes("enter:vol-1"));
    // Snapshot while vol-1 is held: vol-2 must not have entered yet.
    const whileHeld = [...order];
    // Release the chain and let both settle BEFORE asserting, so a failed
    // expectation never leaves the module-level serialization chain pending
    // (which would hang the next test).
    resolveFirst();
    await Promise.all([p1, p2]);
    expect(whileHeld).toEqual(["enter:vol-1"]);
    expect(order).toEqual(["enter:vol-1", "exit:vol-1", "enter:vol-2", "exit:vol-2"]);
  });

  it("a failing create does not poison the serialization chain", async () => {
    let first = true;
    const docker = {
      createVolume: vi.fn(async () => {
        if (first) { first = false; throw new Error("boom"); }
      }),
      getVolume: () => ({
        inspect: async () => ({ Mountpoint: "/x" }),
        remove: async () => { throw notFound(); },
      }),
    } as unknown as Docker;

    await expect(createOverlayVolume(docker, { ...spec, volumeName: "v1" })).rejects.toThrow("boom");
    // Second create still runs.
    await expect(createOverlayVolume(docker, { ...spec, volumeName: "v2" })).resolves.toBeUndefined();
  });
});

describe("volumeExists", () => {
  it("returns true when inspect succeeds", async () => {
    const { docker } = makeFakeDocker();
    expect(await volumeExists(docker, "shipit-abc_overlay-deadbeef")).toBe(true);
  });

  it("returns false on 404 (volume never provisioned)", async () => {
    const { docker } = makeFakeDocker({ inspect: async () => { throw notFound(); } });
    expect(await volumeExists(docker, "shipit-abc_overlay-deadbeef")).toBe(false);
  });

  it("propagates non-404 daemon errors", async () => {
    const { docker } = makeFakeDocker({ inspect: async () => { throw new Error("daemon unreachable"); } });
    await expect(volumeExists(docker, "v")).rejects.toThrow("daemon unreachable");
  });
});

describe("removeOverlayVolume", () => {
  it("removes the volume by name", async () => {
    const { docker, removed } = makeFakeDocker();
    await removeOverlayVolume(docker, "shipit-abcdef012345_overlay");
    expect(removed).toContain("shipit-abcdef012345_overlay");
  });

  it("swallows 404 (already gone)", async () => {
    const { docker } = makeFakeDocker({ remove: async () => { throw notFound(); } });
    await expect(removeOverlayVolume(docker, "gone")).resolves.toBeUndefined();
  });

  it("swallows 409 (in-use by a racing teardown)", async () => {
    const conflict = Object.assign(new Error("in use"), { statusCode: 409 });
    const { docker } = makeFakeDocker({ remove: async () => { throw conflict; } });
    await expect(removeOverlayVolume(docker, "busy")).resolves.toBeUndefined();
  });
});
