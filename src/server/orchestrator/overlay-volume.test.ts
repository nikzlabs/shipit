import { describe, it, expect, vi } from "vitest";
import type Docker from "dockerode";
import {
  overlayVolumeName,
  overlayScopeHash,
  overlayBaseDir,
  resolveVolumeMountpoint,
  createOverlayVolume,
  overlayDriverOpts,
  overlayVolumeState,
  releaseOverlayVolumeHolders,
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

function conflict(msg = "volume is in use"): Error & { statusCode: number } {
  const e = new Error(msg) as Error & { statusCode: number };
  e.statusCode = 409;
  return e;
}

/**
 * A Docker double that models the daemon's ACTUAL volume semantics, which is the
 * whole subject of the 2026-08-19 ops finding: `docker volume create` against a
 * name that already exists returns the EXISTING volume and silently ignores the
 * new driver opts. A double that just records the call cannot see that bug.
 *
 * `heldBy` names volumes a container still mounts — their removal 409s, exactly as
 * the daemon's does.
 */
function makeVolumeStore(opts: {
  seed?: Record<string, { o: string; labels?: Record<string, string> }>;
  heldBy?: Record<string, string[]>;
  onCreate?: (name: string) => Promise<void>;
} = {}) {
  interface Vol { Options: Record<string, string>; Labels: Record<string, string> }
  const store = new Map<string, Vol>();
  for (const [name, v] of Object.entries(opts.seed ?? {})) {
    store.set(name, {
      Options: { type: "overlay", device: "overlay", o: v.o },
      Labels: v.labels ?? { [OVERLAY_MANAGED_LABEL]: "true" },
    });
  }
  const held = new Map<string, string[]>(Object.entries(opts.heldBy ?? {}));
  const created: { Name: string; Driver?: string; DriverOpts?: Record<string, string>; Labels?: Record<string, string> }[] = [];
  const removed: string[] = [];
  const removedContainers: string[] = [];

  const docker = {
    createVolume: vi.fn(async (config: { Name: string; DriverOpts?: Record<string, string>; Labels?: Record<string, string> }) => {
      created.push(config);
      if (opts.onCreate) await opts.onCreate(config.Name);
      // The silent no-op that made the bug invisible.
      if (store.has(config.Name)) return;
      store.set(config.Name, { Options: config.DriverOpts ?? {}, Labels: config.Labels ?? {} });
    }),
    getVolume: (name: string) => ({
      inspect: async () => {
        const v = store.get(name);
        if (!v) throw notFound();
        return { Mountpoint: `/var/lib/docker/volumes/${name}/_data`, ...v };
      },
      remove: async () => {
        removed.push(name);
        if (!store.has(name)) throw notFound();
        if ((held.get(name) ?? []).length > 0) throw conflict();
        store.delete(name);
      },
    }),
    listContainers: vi.fn(async (args: { filters?: { volume?: string[] } }) => {
      const wanted = new Set(args.filters?.volume ?? []);
      const ids = new Set<string>();
      for (const [vol, containers] of held) {
        if (wanted.has(vol)) for (const c of containers) ids.add(c);
      }
      return [...ids].map((id) => ({ Id: id, Names: [`/${id}`] }));
    }),
    getContainer: (id: string) => ({
      remove: async () => {
        removedContainers.push(id);
        for (const [vol, containers] of held) {
          held.set(vol, containers.filter((c) => c !== id));
        }
      },
    }),
  };
  return { docker: docker as unknown as Docker, store, created, removed, removedContainers };
}

describe("createOverlayVolume", () => {
  const spec: OverlaySpec = {
    volumeName: "shipit-abcdef012345_overlay",
    lowerdir: "/data/overlay-base/h1",
    upperdir: "/data/sessions/s1/upper",
    workdir: "/data/sessions/s1/work",
  };
  const optsOf = (s: OverlaySpec) => `lowerdir=${s.lowerdir},upperdir=${s.upperdir},workdir=${s.workdir}`;

  it("creates a local type=overlay volume with the right opts + managed label", async () => {
    const { docker, created } = makeVolumeStore();
    await createOverlayVolume(docker, spec, { "shipit-stack": "prod" });
    expect(created).toHaveLength(1);
    const c = created[0];
    expect(c.Name).toBe(spec.volumeName);
    expect(c.Driver).toBe("local");
    expect(c.DriverOpts).toEqual({
      type: "overlay",
      device: "overlay",
      o: optsOf(spec),
    });
    expect(c.Labels?.[OVERLAY_MANAGED_LABEL]).toBe("true");
    expect(c.Labels?.["shipit-stack"]).toBe("prod");
  });

  it("removes a pre-existing volume whose opts disagree before recreating", async () => {
    const { docker, created, removed } = makeVolumeStore({
      seed: { [spec.volumeName]: { o: "lowerdir=/stale,upperdir=/stale/u,workdir=/stale/w" } },
    });
    await createOverlayVolume(docker, spec);
    expect(removed).toContain(spec.volumeName);
    expect(created).toHaveLength(1);
  });

  // A volume that is ALREADY exactly what the spec asks for is left alone —
  // removing it would need every container mounting it torn down first, and the
  // no-rotation restart (docs/127) exists precisely to keep those running.
  it("leaves an already-correct volume alone", async () => {
    const { docker, created, removed } = makeVolumeStore({
      seed: { [spec.volumeName]: { o: optsOf(spec) } },
    });
    await createOverlayVolume(docker, spec);
    expect(removed).toEqual([]);
    expect(created).toEqual([]);
  });

  // Labels are stamped for parity with the sweeps, which key on the volume NAME.
  // A label drift must NOT be treated as a mismatch: the recreate it would trigger
  // costs the session's whole Compose stack a teardown for a volume that mounts
  // exactly the same three directories.
  it("leaves a correct volume alone even when its labels drifted", async () => {
    const { docker, created, removed } = makeVolumeStore({
      seed: { [spec.volumeName]: { o: optsOf(spec), labels: {} } },
    });
    await createOverlayVolume(docker, spec, { "shipit-stack": "prod" });
    expect(created).toEqual([]);
    expect(removed).toEqual([]);
  });

  // The recreate above is what lets the driver opts follow a since-rotated base.
  // It only tells the truth if the SPEC moved on every axis: the ops finding of
  // 2026-08-17 was a recreated volume whose lowerdir advanced a generation while
  // its upperdir/workdir stayed put, so the daemon remounted an upper built
  // against a different lower. Both halves must rotate together.
  it("recreates with a lowerdir AND upper/work that rotate together on a generation bump", async () => {
    const { docker, created } = makeVolumeStore();
    const gen = (n: number): OverlaySpec => ({
      volumeName: spec.volumeName,
      lowerdir: `/data/overlay-base/h1/g${n}`,
      upperdir: `/data/sessions/s1/overlay/h1/g${n}/upper`,
      workdir: `/data/sessions/s1/overlay/h1/g${n}/work`,
    });
    await createOverlayVolume(docker, gen(262));
    await createOverlayVolume(docker, gen(265));
    expect(created).toHaveLength(2);
    expect(created[0].DriverOpts?.o).toBe(
      "lowerdir=/data/overlay-base/h1/g262," +
      "upperdir=/data/sessions/s1/overlay/h1/g262/upper," +
      "workdir=/data/sessions/s1/overlay/h1/g262/work",
    );
    // No path from the previous generation survives into the new mount.
    expect(created[1].DriverOpts?.o).not.toContain("g262");
  });

  // THE regression of 2026-08-19. Four production sessions ran on an overlay whose
  // upperdir and workdir had been reaped: the pre-create removal 409'd (a Compose
  // sibling still mounted the volume), `createVolume` returned the existing volume
  // with its stale opts, and NOTHING said so. A create that cannot honour its spec
  // must fail loudly — a container that will not start beats one that starts on a
  // dead upper layer, where `tsc` reports success and writes nothing.
  it("throws when a 409 on the pre-create removal leaves the reaped generation's opts", async () => {
    const staleOpts = "lowerdir=/data/overlay-base/h1/g2," +
      "upperdir=/data/sessions/s1/overlay/h1/g2/upper," +
      "workdir=/data/sessions/s1/overlay/h1/g2/work";
    const rotated: OverlaySpec = {
      volumeName: spec.volumeName,
      lowerdir: "/data/overlay-base/h1/g3",
      upperdir: "/data/sessions/s1/overlay/h1/g3/upper",
      workdir: "/data/sessions/s1/overlay/h1/g3/work",
    };
    const { docker, store } = makeVolumeStore({
      seed: { [spec.volumeName]: { o: staleOpts } },
      heldBy: { [spec.volumeName]: ["dev-1"] },
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(createOverlayVolume(docker, rotated)).rejects.toThrow(
      /was not created with the requested driver opts/,
    );
    // And the daemon still holds the stale one — the point being that the caller
    // now KNOWS, rather than starting a container over it.
    expect(store.get(spec.volumeName)?.Options.o).toBe(staleOpts);
  });

  it("serializes concurrent creates (no interleaving)", async () => {
    // Track entry/exit order of createVolume to prove serialization.
    const order: string[] = [];
    let resolveFirst!: () => void;
    const firstGate = new Promise<void>((r) => { resolveFirst = r; });
    let call = 0;
    const { docker } = makeVolumeStore({
      onCreate: async (name) => {
        order.push(`enter:${name}`);
        if (call++ === 0) await firstGate; // hold the first create open
        order.push(`exit:${name}`);
      },
    });

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
    const { docker } = makeVolumeStore({
      onCreate: async () => {
        if (first) { first = false; throw new Error("boom"); }
      },
    });

    await expect(createOverlayVolume(docker, { ...spec, volumeName: "v1" })).rejects.toThrow("boom");
    // Second create still runs.
    await expect(createOverlayVolume(docker, { ...spec, volumeName: "v2" })).resolves.toBeUndefined();
  });
});

describe("overlayVolumeState", () => {
  const spec: OverlaySpec = {
    volumeName: "shipit-abcdef012345_overlay-dba27c31",
    lowerdir: "/data/overlay-base/h1/g3",
    upperdir: "/data/sessions/s1/overlay/h1/g3/upper",
    workdir: "/data/sessions/s1/overlay/h1/g3/work",
  };

  it("reports absent / match / mismatch", async () => {
    expect(await overlayVolumeState(makeVolumeStore().docker, spec)).toBe("absent");
    expect(await overlayVolumeState(
      makeVolumeStore({ seed: { [spec.volumeName]: { o: overlayDriverOpts(spec) } } }).docker,
      spec,
    )).toBe("match");
    // The production shape: the base advanced to g3 but the volume still names g2,
    // whose upper/work `prepareOverlayDirs` has already deleted.
    expect(await overlayVolumeState(
      makeVolumeStore({
        seed: { [spec.volumeName]: { o: overlayDriverOpts({ ...spec, lowerdir: "/data/overlay-base/h1/g2" }) } },
      }).docker,
      spec,
    )).toBe("mismatch");
  });

  it("propagates a non-404 daemon error rather than guessing", async () => {
    const docker = {
      getVolume: () => ({ inspect: async () => { throw new Error("daemon unreachable"); } }),
    } as unknown as Docker;
    await expect(overlayVolumeState(docker, spec)).rejects.toThrow("daemon unreachable");
  });
});

describe("releaseOverlayVolumeHolders", () => {
  const volumeName = "shipit-abcdef012345_overlay-dba27c31";

  it("removes every container holding the named volumes, so the recreate can proceed", async () => {
    const { docker, removedContainers } = makeVolumeStore({
      seed: { [volumeName]: { o: "lowerdir=/g2,upperdir=/g2/u,workdir=/g2/w" } },
      heldBy: { [volumeName]: ["dev-1", "assetgen-1"] },
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const released = await releaseOverlayVolumeHolders(docker, [volumeName], { sessionId: "s1" });

    expect(released.sort()).toEqual(["assetgen-1", "dev-1"]);
    expect(removedContainers.sort()).toEqual(["assetgen-1", "dev-1"]);
    // The removal that used to 409 now succeeds.
    await expect(docker.getVolume(volumeName).remove({ force: true })).resolves.toBeUndefined();
  });

  it("is a no-op for an empty list (no daemon call at all)", async () => {
    const { docker } = makeVolumeStore();
    expect(await releaseOverlayVolumeHolders(docker, [])).toEqual([]);
    expect((docker as unknown as { listContainers: { mock: { calls: unknown[] } } }).listContainers.mock.calls).toHaveLength(0);
  });

  it("survives a daemon that cannot list containers — the create-time check is the backstop", async () => {
    const docker = {
      listContainers: async () => { throw new Error("daemon unreachable"); },
    } as unknown as Docker;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await releaseOverlayVolumeHolders(docker, [volumeName])).toEqual([]);
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
