import { describe, expect, it, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import simpleGit from "simple-git";

import {
  buildOverlaySpecs,
  classifyDepDirsForOverlay,
  depDirsForSession,
  missingDepDirParents,
  parseUnignoredByNegation,
  supersededSessionOverlayLayers,
  preStampInstallMarker,
  sessionPnpmStoreDir,
  retiredSharedPnpmStoreRoot,
  PNPM_VERIFIED_NAMESPACE,
  type DepDirOverlaySpec,
  isOverlayEligible,
  isOverlayEnabled,
  liveOverlayScopeHashes,
  sortOverlayDepDirs,
  overlayDepDirsFromMounts,
  overlayPinSegment,
  overlayRuntimeKey,
  resolveOverlayScope,
  validDepDirsForOverlay,
} from "./overlay-session.js";
import { overlayScopeHash, overlayVolumeName } from "./overlay-volume.js";
import { computeInstallDepsHash } from "../shared/deps-hash.js";
import type { SessionInfo } from "../shared/types.js";

const ON = { OVERLAY_DEP_STORE: "1" } as NodeJS.ProcessEnv;
const OFF = { OVERLAY_DEP_STORE: "0" } as NodeJS.ProcessEnv;

function session(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "11112222333344445555666677778888",
    title: "t",
    createdAt: "0",
    lastUsedAt: "0",
    remoteUrl: "https://github.com/acme/repo.git",
    ...over,
  } as SessionInfo;
}

describe("overlay feature gate + eligibility", () => {
  it("is on by default; only OVERLAY_DEP_STORE=0/false kills it (planning#129)", () => {
    expect(isOverlayEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(isOverlayEnabled({ OVERLAY_DEP_STORE: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isOverlayEnabled({ OVERLAY_DEP_STORE: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isOverlayEnabled({ OVERLAY_DEP_STORE: "yes" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isOverlayEnabled({ OVERLAY_DEP_STORE: "" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isOverlayEnabled({ OVERLAY_DEP_STORE: "0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isOverlayEnabled({ OVERLAY_DEP_STORE: "false" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("requires the flag, a remote, and a non-ops kind", () => {
    expect(isOverlayEligible(session(), OFF)).toBe(false);
    expect(isOverlayEligible(session(), ON)).toBe(true);
    expect(isOverlayEligible(session({ remoteUrl: "" }), ON)).toBe(false);
    expect(isOverlayEligible(session({ kind: "ops" }), ON)).toBe(false);
  });

  it("resolveOverlayScope returns null when ineligible, scope when eligible", () => {
    expect(resolveOverlayScope(session(), OFF)).toBeNull();
    const scope = resolveOverlayScope(session(), ON);
    expect(scope).toEqual({
      repoUrl: "https://github.com/acme/repo.git",
      runtimeKey: overlayRuntimeKey(ON),
    });
  });
});

describe("overlayRuntimeKey (planning#196 — pinned base digest, not the full image id)", () => {
  it("uses base digest + arch", () => {
    expect(overlayRuntimeKey({ BASE_IMAGE_DIGEST: "sha256:base" } as NodeJS.ProcessEnv))
      .toBe(`sha256:base|${process.arch}`);
  });

  it("falls back to the worker image id, then IMAGE_DIGEST, then unknown", () => {
    expect(overlayRuntimeKey({ SESSION_WORKER_IMAGE_ID: "sha256:abc" } as NodeJS.ProcessEnv))
      .toBe(`sha256:abc|${process.arch}`);
    expect(overlayRuntimeKey({ IMAGE_DIGEST: "sha256:def" } as NodeJS.ProcessEnv))
      .toBe(`sha256:def|${process.arch}`);
    expect(overlayRuntimeKey({} as NodeJS.ProcessEnv)).toBe(`unknown|${process.arch}`);
  });

  it("a no-op app rebuild preserves the scope key", () => {
    const before = overlayRuntimeKey({
      BASE_IMAGE_DIGEST: "sha256:base",
      SESSION_WORKER_IMAGE_ID: "sha256:worker-v1",
    } as NodeJS.ProcessEnv);
    const after = overlayRuntimeKey({
      BASE_IMAGE_DIGEST: "sha256:base",
      SESSION_WORKER_IMAGE_ID: "sha256:worker-v2",
    } as NodeJS.ProcessEnv);
    expect(after).toBe(before);
  });

  it("a base-digest bump changes the scope key", () => {
    expect(overlayRuntimeKey({ BASE_IMAGE_DIGEST: "sha256:base-A" } as NodeJS.ProcessEnv))
      .not.toBe(overlayRuntimeKey({ BASE_IMAGE_DIGEST: "sha256:base-B" } as NodeJS.ProcessEnv));
  });
});

describe("overlayPinSegment (docs/248 — repo Node pin)", () => {
  const ENV = { BASE_IMAGE_DIGEST: "sha256:base", WORKER_IMAGE_NODE_VERSION: "24.15.0" } as NodeJS.ProcessEnv;
  let dir: string;

  function ws(files: Record<string, string>): string {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-pin-"));
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), body);
    }
    return dir;
  }

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is empty when the repo pins nothing — every existing scope stays identical", () => {
    expect(overlayPinSegment(ws({ "package.json": "{}" }), ENV)).toBe("");
    expect(overlayPinSegment(undefined, ENV)).toBe("");
  });

  it("is empty when the image's Node already satisfies the pin", () => {
    const w = ws({ "package.json": JSON.stringify({ engines: { node: ">=20" } }) });
    expect(overlayPinSegment(w, ENV)).toBe("");
  });

  it("is empty for a pin the resolver rejects — the worker won't switch either", () => {
    expect(overlayPinSegment(ws({ ".nvmrc": "lts/jod" }), ENV)).toBe("");
  });

  it("splits the scope when the pin moves the session off the image's Node", () => {
    expect(overlayPinSegment(ws({ ".nvmrc": "22" }), ENV)).toBe("|pin22");
  });

  it("splits when the image's Node version is unknown, erring toward isolation", () => {
    const w = ws({ "package.json": JSON.stringify({ engines: { node: ">=20" } }) });
    expect(overlayPinSegment(w, { BASE_IMAGE_DIGEST: "sha256:base" } as NodeJS.ProcessEnv))
      .toBe("|pin>=20");
  });

  it("gives two different pins two different scopes", () => {
    const a = overlayPinSegment(ws({ ".nvmrc": "22" }), ENV);
    fs.rmSync(dir, { recursive: true, force: true });
    const b = overlayPinSegment(ws({ ".nvmrc": "20" }), ENV);
    expect(a).not.toBe(b);
  });

  it("threads through resolveOverlayScope", () => {
    const session = { remoteUrl: "https://github.com/o/r" };
    const unpinned = resolveOverlayScope(session, ENV, ws({ "package.json": "{}" }));
    fs.rmSync(dir, { recursive: true, force: true });
    const pinned = resolveOverlayScope(session, ENV, ws({ ".nvmrc": "22" }));
    expect(unpinned?.runtimeKey).toBe(overlayRuntimeKey(ENV));
    expect(pinned?.runtimeKey).toBe(`${overlayRuntimeKey(ENV)}|pin22`);
  });
});

describe("liveOverlayScopeHashes", () => {
  it("is empty when the feature is off and never consults the resolver", () => {
    let consulted = false;
    const live = liveOverlayScopeHashes(
      [session()],
      () => {
        consulted = true;
        return ["node_modules"];
      },
      OFF,
    );
    expect(live.size).toBe(0);
    expect(consulted).toBe(false);
  });

  it("enumerates one scope-hash per (session × dep dir) for the current runtime", () => {
    const rt = overlayRuntimeKey(ON);
    const sessions = [
      session({ id: "a", remoteUrl: "https://github.com/acme/one.git" }),
      session({ id: "b", remoteUrl: "https://github.com/acme/two.git" }),
      session({ id: "c", remoteUrl: "" }),
      session({ id: "d", remoteUrl: "https://github.com/acme/three.git", kind: "ops" }),
      session({ id: "e", remoteUrl: "https://github.com/acme/four.git", diskTier: "evicted" }),
    ];
    const resolve = (s: SessionInfo): string[] =>
      s.remoteUrl === "https://github.com/acme/one.git"
        ? ["node_modules", "packages/app/node_modules"]
        : ["node_modules"];
    const live = liveOverlayScopeHashes(sessions, resolve, ON);
    const NS = PNPM_VERIFIED_NAMESPACE;
    expect(live).toEqual(
      new Set([
        overlayScopeHash("https://github.com/acme/one.git", rt, "node_modules"),
        overlayScopeHash("https://github.com/acme/one.git", rt, "packages/app/node_modules"),
        overlayScopeHash("https://github.com/acme/two.git", rt, "node_modules"),
        overlayScopeHash("https://github.com/acme/one.git", rt, "node_modules", NS),
        overlayScopeHash("https://github.com/acme/one.git", rt, "packages/app/node_modules", NS),
        overlayScopeHash("https://github.com/acme/two.git", rt, "node_modules", NS),
      ]),
    );
  });

  /**
   * Package-manager detection reads the mutable checkout, so "is this a pnpm session right now"
   * cannot decide whether its verified base is live. Claiming both addresses over-retains a hash
   * with no directory, which costs nothing; getting it wrong deletes a base a session is on.
   */
  it("claims the verified-namespace hash for every session, not only pnpm ones", () => {
    const rt = overlayRuntimeKey(ON);
    const live = liveOverlayScopeHashes([session({ id: "a" })], () => ["node_modules"], ON);
    const repo = "https://github.com/acme/repo.git";
    expect(live).toContain(overlayScopeHash(repo, rt, "node_modules", PNPM_VERIFIED_NAMESPACE));
  });

  it("uses the per-dep-dir hash, not the legacy (repo, runtime) hash", () => {
    const rt = overlayRuntimeKey(ON);
    const live = liveOverlayScopeHashes([session({ id: "a" })], () => ["node_modules"], ON);
    expect(live).toContain(overlayScopeHash("https://github.com/acme/repo.git", rt, "node_modules"));
    expect(live).not.toContain(overlayScopeHash("https://github.com/acme/repo.git", rt));
  });

  /**
   * Creation keys the scope on runtime key + `overlayPinSegment(workspaceDir)`; this read used the
   * runtime key alone, so a Node-pinned session's scope was swept despite a current pointer
   * (docs/276-shared-package-cache-integrity section 5, "Ordering and cleanup"). Both are claimed,
   * because the pin comes from the mutable checkout and a sweep must never be what decides.
   */
  it("claims the PINNED scope a Node-pinned session actually mounts, and the unpinned one too", () => {
    const pinnedEnv = { ...ON, WORKER_IMAGE_NODE_VERSION: "24.0.0" };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-pin-"));
    try {
      fs.writeFileSync(path.join(dir, ".nvmrc"), "20.11.0\n");
      const s = session({ id: "a", workspaceDir: dir });
      const pinSegment = overlayPinSegment(dir, pinnedEnv);
      expect(pinSegment).not.toBe("");
      const rt = overlayRuntimeKey(pinnedEnv);
      const repo = "https://github.com/acme/repo.git";

      const live = liveOverlayScopeHashes([s], () => ["node_modules"], pinnedEnv);

      expect(live).toContain(overlayScopeHash(repo, rt + pinSegment, "node_modules"));
      expect(live).toContain(
        overlayScopeHash(repo, rt + pinSegment, "node_modules", PNPM_VERIFIED_NAMESPACE),
      );
      expect(live).toContain(overlayScopeHash(repo, rt, "node_modules"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildOverlaySpecs", () => {
  const MP = "/var/lib/docker/volumes/shipit-workspace/_data";
  const scope = { repoUrl: "https://github.com/acme/repo.git", runtimeKey: "img|x64" };

  it("emits one spec per dep dir with per-dep-dir scope, paths, and mount target", () => {
    const sessionId = "11112222333344445555";
    const specs = buildOverlaySpecs({
      sessionId,
      scope,
      depDirs: ["node_modules", "packages/app/node_modules"],
      volumeMountpoint: MP,
    });
    expect(specs).toHaveLength(2);

    const nm = specs[0];
    const hash = overlayScopeHash(scope.repoUrl, scope.runtimeKey, "node_modules");
    expect(nm.depDir).toBe("node_modules");
    expect(nm.scopeHash).toBe(hash);
    expect(nm.scope).toEqual({ ...scope, depDir: "node_modules" });
    expect(nm.mountPath).toBe("/workspace/node_modules");
    expect(nm.lowerdir).toBe(`${MP}/overlay-base/${hash}/g0`);
    expect(nm.upperdir).toBe(`${MP}/sessions/${sessionId}/overlay/${hash}/g0/upper`);
    expect(nm.workdir).toBe(`${MP}/sessions/${sessionId}/overlay/${hash}/g0/work`);
    expect(nm.volumeName).toBe(overlayVolumeName(sessionId, "node_modules"));

    expect(specs[1].mountPath).toBe("/workspace/packages/app/node_modules");
  });

  it("gives each dep dir a distinct base, upper, and volume (no shared upperdir)", () => {
    const [a, b] = buildOverlaySpecs({
      sessionId: "sess",
      scope,
      depDirs: ["node_modules", "vendor/bundle"],
      volumeMountpoint: MP,
    });
    expect(a.lowerdir).not.toBe(b.lowerdir);
    expect(a.upperdir).not.toBe(b.upperdir);
    expect(a.volumeName).not.toBe(b.volumeName);
  });

  it("returns [] when no dep dirs are declared", () => {
    expect(buildOverlaySpecs({ sessionId: "s", scope, depDirs: [], volumeMountpoint: MP })).toEqual([]);
  });

  it("carries orchestrator-visible orchDirs when a stateRoot is given (and omits them otherwise)", () => {
    const sessionId = "11112222333344445555";
    const hash = overlayScopeHash(scope.repoUrl, scope.runtimeKey, "node_modules");
    const [withRoot] = buildOverlaySpecs({
      sessionId, scope, depDirs: ["node_modules"], volumeMountpoint: MP, stateRoot: "/workspace",
    });
    expect(withRoot.orchDirs).toEqual({
      lowerdir: `/workspace/overlay-base/${hash}/g0`,
      upperdir: `/workspace/sessions/${sessionId}/overlay/${hash}/g0/upper`,
      workdir: `/workspace/sessions/${sessionId}/overlay/${hash}/g0/work`,
      sessionScopeDir: `/workspace/sessions/${sessionId}/overlay/${hash}`,
    });
    const [withoutRoot] = buildOverlaySpecs({
      sessionId, scope, depDirs: ["node_modules"], volumeMountpoint: MP,
    });
    expect(withoutRoot.orchDirs).toBeUndefined();
  });

  it("pins the lowerdir to the resolver's generation (per dep-dir scope)", () => {
    const sessionId = "11112222333344445555";
    const nmHash = overlayScopeHash(scope.repoUrl, scope.runtimeKey, "node_modules");
    const [nm, vendor] = buildOverlaySpecs({
      sessionId,
      scope,
      depDirs: ["node_modules", "vendor/bundle"],
      volumeMountpoint: MP,
      stateRoot: "/workspace",
      generationForScope: (hash) => (hash === nmHash ? 4 : 0),
    });
    expect(nm.lowerdir).toBe(`${MP}/overlay-base/${nmHash}/g4`);
    expect(nm.orchDirs?.lowerdir).toBe(`/workspace/overlay-base/${nmHash}/g4`);
    expect(vendor.lowerdir).toBe(`${MP}/overlay-base/${vendor.scopeHash}/g0`);
  });

  it("keys the per-session upper/work on the SAME generation the lowerdir pins", () => {
    const sessionId = "11112222333344445555";
    const build = (generation: number) => buildOverlaySpecs({
      sessionId,
      scope,
      depDirs: ["node_modules"],
      volumeMountpoint: MP,
      stateRoot: "/workspace",
      generationForScope: () => generation,
    })[0];
    const before = build(262);
    const after = build(265);

    const hash = overlayScopeHash(scope.repoUrl, scope.runtimeKey, "node_modules");
    expect(before.upperdir).toBe(`${MP}/sessions/${sessionId}/overlay/${hash}/g262/upper`);
    expect(after.upperdir).toBe(`${MP}/sessions/${sessionId}/overlay/${hash}/g265/upper`);
    expect(after.lowerdir).not.toBe(before.lowerdir);
    expect(after.upperdir).not.toBe(before.upperdir);
    expect(after.workdir).not.toBe(before.workdir);
    expect(after.orchDirs?.upperdir).not.toBe(before.orchDirs?.upperdir);
    expect(after.orchDirs?.sessionScopeDir).toBe(before.orchDirs?.sessionScopeDir);
  });
});

describe("overlayDepDirsFromMounts (#2426 — adopted containers)", () => {
  const SID = "f0d898c7-1db5-4914-af35-78911563838b";

  const BASE_MOUNTS = [
    { Type: "volume", Name: "shipit_workspace", Destination: "/workspace" },
    { Type: "bind", Source: "/host/uploads", Destination: "/uploads" },
  ];

  it("reads back exactly what buildOverlaySpecs put on the container", () => {
    const specs = buildOverlaySpecs({
      sessionId: SID,
      scope: { repoUrl: "https://github.com/acme/repo.git", runtimeKey: "img|x64" },
      depDirs: ["node_modules", "packages/app/node_modules"],
      volumeMountpoint: "/var/lib/docker/volumes/shipit-workspace/_data",
    });
    const mounts = [
      ...BASE_MOUNTS,
      ...specs.map((s) => ({ Type: "volume", Name: s.volumeName, Destination: s.mountPath })),
    ];

    expect(overlayDepDirsFromMounts(SID, mounts)).toEqual(
      specs.map((s) => ({ depDir: s.depDir, volumeName: s.volumeName })),
    );
  });

  it("orders the pairs independently of the mount table's order", () => {
    const vols = {
      nm: overlayVolumeName(SID, "node_modules"),
      dist: overlayVolumeName(SID, "dist"),
      app: overlayVolumeName(SID, "packages/app/node_modules"),
    };
    const mount = (name: string, dest: string) => ({ Type: "volume", Name: name, Destination: dest });
    const one = [
      mount(vols.nm, "/workspace/node_modules"),
      mount(vols.dist, "/workspace/dist"),
      mount(vols.app, "/workspace/packages/app/node_modules"),
    ];
    const other = [one[2], one[0], one[1]];

    expect(overlayDepDirsFromMounts(SID, one)).toEqual(overlayDepDirsFromMounts(SID, other));
    expect(overlayDepDirsFromMounts(SID, one).map((p) => p.depDir))
      .toEqual(["dist", "node_modules", "packages/app/node_modules"]);
  });

  it("agrees with the order the create path records, for the same set", () => {
    const specs = buildOverlaySpecs({
      sessionId: SID,
      scope: { repoUrl: "https://github.com/acme/repo.git", runtimeKey: "img|x64" },
      depDirs: ["packages/app/node_modules", "node_modules"],
      volumeMountpoint: "/var/lib/docker/volumes/shipit-workspace/_data",
    });
    const fromCreate = sortOverlayDepDirs(
      specs.map((s) => ({ depDir: s.depDir, volumeName: s.volumeName })),
    );
    const fromMounts = overlayDepDirsFromMounts(
      SID,
      specs.map((s) => ({ Type: "volume", Name: s.volumeName, Destination: s.mountPath })),
    );
    expect(fromMounts).toEqual(fromCreate);
  });

  it("returns [] for a container that genuinely has no dep-dir overlay", () => {
    expect(overlayDepDirsFromMounts(SID, BASE_MOUNTS)).toEqual([]);
    expect(overlayDepDirsFromMounts(SID, undefined)).toEqual([]);
  });

  it("ignores the workspace volume, the pnpm store, and another session's volumes", () => {
    const mounts = [
      ...BASE_MOUNTS,
      { Type: "bind", Source: "/state/pnpm-store/abc", Destination: "/workspace/.pnpm-store" },
      {
        Type: "volume",
        Name: overlayVolumeName("99998888777766665555", "node_modules"),
        Destination: "/workspace/node_modules",
      },
    ];
    expect(overlayDepDirsFromMounts(SID, mounts)).toEqual([]);
  });

  it("ignores an overlay volume mounted outside the workspace", () => {
    const mounts = [
      { Type: "volume", Name: overlayVolumeName(SID, "node_modules"), Destination: "/workspace" },
      { Type: "volume", Name: overlayVolumeName(SID, "vendor"), Destination: "/elsewhere/vendor" },
    ];
    expect(overlayDepDirsFromMounts(SID, mounts)).toEqual([]);
  });
});

describe("supersededSessionOverlayLayers", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  function scopeDir(names: string[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ovl-gen-"));
    tmpDirs.push(dir);
    for (const n of names) fs.mkdirSync(path.join(dir, n), { recursive: true });
    return dir;
  }

  it("returns every generation dir except the one about to be mounted", () => {
    const dir = scopeDir(["g262", "g263", "g265"]);
    expect(supersededSessionOverlayLayers(dir, 265).sort()).toEqual([
      path.join(dir, "g262"),
      path.join(dir, "g263"),
    ]);
  });

  it("returns [] when the only generation present is the current one", () => {
    const dir = scopeDir(["g265"]);
    expect(supersededSessionOverlayLayers(dir, 265)).toEqual([]);
  });

  it("returns [] for an absent scope dir (a cold session)", () => {
    expect(supersededSessionOverlayLayers("/nope/does/not/exist", 0)).toEqual([]);
  });

  it("ignores anything that is neither a generation dir nor the legacy layout", () => {
    const dir = scopeDir(["g1", "gfoo", "index"]);
    fs.writeFileSync(path.join(dir, "g9"), "a file, not a generation dir");
    expect(supersededSessionOverlayLayers(dir, 2)).toEqual([path.join(dir, "g1")]);
  });

  it("counts the legacy generation-agnostic upper/work as superseded", () => {
    const dir = scopeDir(["upper", "work"]);
    expect(supersededSessionOverlayLayers(dir, 3).sort()).toEqual([
      path.join(dir, "upper"),
      path.join(dir, "work"),
    ]);
  });
});

describe("depDirsForSession", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  function workspace(yaml?: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-depdirs-"));
    tmpDirs.push(dir);
    if (yaml !== undefined) fs.writeFileSync(path.join(dir, "shipit.yaml"), yaml);
    return dir;
  }

  it("returns [] when the session has no workspace dir", () => {
    expect(depDirsForSession({ workspaceDir: undefined })).toEqual([]);
  });

  it("reads declared agent.dep-dirs from the workspace shipit.yaml", () => {
    const dir = workspace("agent:\n  dep-dirs:\n    - node_modules\n    - packages/web/node_modules\n");
    expect(depDirsForSession({ workspaceDir: dir })).toEqual([
      "node_modules",
      "packages/web/node_modules",
    ]);
  });

  it("defaults to [node_modules] when there is no shipit.yaml", () => {
    expect(depDirsForSession({ workspaceDir: workspace() })).toEqual(["node_modules"]);
  });
});

describe("validDepDirsForOverlay", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  async function repo(opts: { gitignore?: string; dirs?: string[] } = {}): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-validate-"));
    tmpDirs.push(dir);
    await simpleGit(dir).init();
    if (opts.gitignore !== undefined) fs.writeFileSync(path.join(dir, ".gitignore"), opts.gitignore);
    for (const d of opts.dirs ?? []) fs.mkdirSync(path.join(dir, d), { recursive: true });
    return dir;
  }

  it("keeps a git-ignored dep dir whose parent exists", async () => {
    const dir = await repo({ gitignore: "node_modules\n" });
    expect(await validDepDirsForOverlay(["node_modules"], dir)).toEqual(["node_modules"]);
  });

  it("keeps a dep dir matched by a directory-only pattern when the dir does not exist yet", async () => {
    const dir = await repo({ gitignore: "node_modules/\n" });
    expect(await validDepDirsForOverlay(["node_modules"], dir)).toEqual(["node_modules"]);
  });

  it("keeps a dep dir matched by a directory-only pattern when the dir exists", async () => {
    const dir = await repo({ gitignore: "node_modules/\n", dirs: ["node_modules"] });
    expect(await validDepDirsForOverlay(["node_modules"], dir)).toEqual(["node_modules"]);
  });

  it("keeps a nested dep dir under a directory-only pattern when absent", async () => {
    const dir = await repo({ gitignore: "node_modules/\n", dirs: ["packages/app"] });
    expect(await validDepDirsForOverlay(["packages/app/node_modules"], dir)).toEqual([
      "packages/app/node_modules",
    ]);
  });

  it("still drops a non-ignored dep dir that does not exist (slash query must not false-positive)", async () => {
    const dir = await repo({ gitignore: "node_modules/\n" });
    expect(await validDepDirsForOverlay(["vendor"], dir)).toEqual([]);
  });

  it("drops a dep dir that is tracked source (not git-ignored)", async () => {
    const dir = await repo({ gitignore: "node_modules\n", dirs: ["src"] });
    expect(await validDepDirsForOverlay(["src"], dir)).toEqual([]);
  });

  it("drops a dep dir whose missing parent is tracked source the clone should have had", async () => {
    const dir = await repo({ gitignore: "node_modules\n" });
    expect(await validDepDirsForOverlay(["packages/app/node_modules"], dir)).toEqual([]);
  });

  // The incident: `.tools/` is ignored, so no clone ever has it; requiring the parent dropped
  // the dep dir on every session and nothing else created it.
  it("keeps a dep dir whose missing parent is itself git-ignored", async () => {
    const dir = await repo({ gitignore: ".tools/\n" });
    expect(await validDepDirsForOverlay([".tools/blender"], dir)).toEqual([".tools/blender"]);
  });

  it("keeps a dep dir under two missing ignored levels", async () => {
    const dir = await repo({ gitignore: ".cache\n" });
    expect(await validDepDirsForOverlay([".cache/a/b"], dir)).toEqual([".cache/a/b"]);
  });

  it("drops a dep dir with a tracked missing level between existing and ignored ones", async () => {
    const dir = await repo({ gitignore: "node_modules\n", dirs: ["packages"] });
    expect(await validDepDirsForOverlay(["packages/app/node_modules"], dir)).toEqual([]);
  });

  // `git check-ignore` answers the slash form from the containing rule: under `*` + `!foo` it
  // reports `foo/` ignored while `foo` is not. Treating that as an ignored parent would accept
  // an absent TRACKED directory — exactly what the old parent test rejected.
  it("drops a dep dir whose missing parent is explicitly un-ignored by a negation rule", async () => {
    const dir = await repo({ gitignore: "*\n!foo\n" });
    const got = await classifyDepDirsForOverlay(["foo/node_modules"], dir);
    expect(got.valid).toEqual([]);
    expect(got.dropped).toEqual([{ depDir: "foo/node_modules", reason: "missing-tracked-parent" }]);
  });

  it("drops a dep dir that a negation rule re-includes as tracked source", async () => {
    const dir = await repo({ gitignore: "*\n!vendor\n", dirs: ["vendor"] });
    const got = await classifyDepDirsForOverlay(["vendor"], dir);
    expect(got.valid).toEqual([]);
    expect(got.dropped).toEqual([{ depDir: "vendor", reason: "not-git-ignored" }]);
  });

  // A negation elsewhere in the file must not disqualify an unrelated ignored ancestor.
  it("keeps an ignored dep dir when the negation applies to a SIBLING path", async () => {
    const dir = await repo({ gitignore: "*\n!src\n.tools/\n", dirs: ["src"] });
    expect(await validDepDirsForOverlay([".tools/blender"], dir)).toEqual([".tools/blender"]);
  });

  it("reports the reason each dropped dep dir was dropped", async () => {
    const dir = await repo({ gitignore: ".tools/\n", dirs: ["src"] });
    const got = await classifyDepDirsForOverlay([".tools/blender", "src", "vendor"], dir);
    expect(got.valid).toEqual([".tools/blender"]);
    expect(got.dropped).toEqual([
      { depDir: "src", reason: "not-git-ignored" },
      { depDir: "vendor", reason: "not-git-ignored" },
    ]);
  });

  it("reports missing-tracked-parent for an ignored dir under an absent source path", async () => {
    const dir = await repo({ gitignore: "node_modules\n" });
    const got = await classifyDepDirsForOverlay(["packages/app/node_modules"], dir);
    expect(got.valid).toEqual([]);
    expect(got.dropped).toEqual([
      { depDir: "packages/app/node_modules", reason: "missing-tracked-parent" },
    ]);
  });

  it("reports git-unavailable for every entry when git cannot answer", async () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-nongit-reason-"));
    tmpDirs.push(nonGit);
    const got = await classifyDepDirsForOverlay(["node_modules"], nonGit);
    expect(got.valid).toEqual([]);
    expect(got.dropped).toEqual([{ depDir: "node_modules", reason: "git-unavailable" }]);
  });

  it("keeps a nested dep dir when its parent exists and it is ignored", async () => {
    const dir = await repo({ gitignore: "node_modules\n", dirs: ["packages/app"] });
    expect(await validDepDirsForOverlay(["packages/app/node_modules"], dir)).toEqual([
      "packages/app/node_modules",
    ]);
  });

  it("filters a mixed list to only the valid dep dirs", async () => {
    const dir = await repo({ gitignore: "node_modules\n", dirs: ["src", "packages/app"] });
    const got = await validDepDirsForOverlay(
      ["node_modules", "src", "packages/app/node_modules", "packages/missing/node_modules"],
      dir,
    );
    expect(got).toEqual(["node_modules", "packages/app/node_modules"]);
  });

  it("returns [] for an empty input and for a non-git directory (conservative)", async () => {
    const dir = await repo({ gitignore: "node_modules\n" });
    expect(await validDepDirsForOverlay([], dir)).toEqual([]);
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-nongit-"));
    tmpDirs.push(nonGit);
    fs.mkdirSync(path.join(nonGit, "node_modules"));
    expect(await validDepDirsForOverlay(["node_modules"], nonGit)).toEqual([]);
  });
});

describe("parseUnignoredByNegation", () => {
  it("collects only the paths whose matching rule is a negation", () => {
    const out = [
      ".gitignore:2:!foo\tfoo",
      ".gitignore:1:*\tfoo/",
      ".gitignore:1:*\tbar",
      "::\tsrc",
    ].join("\n");
    expect(parseUnignoredByNegation(out)).toEqual(new Set(["foo"]));
  });

  it("tolerates a colon in the ignore file's own path and an empty output", () => {
    expect(parseUnignoredByNegation("a:b/.gitignore:3:!keep\tkeep")).toEqual(new Set(["keep"]));
    expect(parseUnignoredByNegation("")).toEqual(new Set());
  });
});

describe("missingDepDirParents", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("lists every absent ancestor, shallowest first, and none that exist", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-parents-"));
    tmpDirs.push(dir);
    fs.mkdirSync(path.join(dir, "packages"));
    expect(missingDepDirParents("node_modules", dir)).toEqual([]);
    expect(missingDepDirParents("packages/app/node_modules", dir)).toEqual(["packages/app"]);
    expect(missingDepDirParents(".tools/blender", dir)).toEqual([".tools"]);
    expect(missingDepDirParents("a/b/c", dir)).toEqual(["a", "a/b"]);
  });
});

describe("preStampInstallMarker (docs/183 base-hit pre-stamp)", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  async function gitWorkspace(installCmd = "npm install"): Promise<{ dir: string; head: string }> {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "prestamp-"));
    tmpDirs.push(sessionDir);
    const dir = path.join(sessionDir, "workspace");
    fs.mkdirSync(dir, { recursive: true });
    const git = simpleGit(dir);
    await git.init();
    await git.addConfig("user.email", "t@t");
    await git.addConfig("user.name", "t");
    fs.writeFileSync(path.join(dir, "shipit.yaml"), `agent:\n  install:\n    - ${installCmd}\n`);
    await git.add(".");
    await git.commit("init");
    const head = (await git.revparse(["HEAD"])).trim();
    return { dir, head };
  }

  function spec(scopeHash: string, generation: number): DepDirOverlaySpec {
    return {
      volumeName: `shipit-x_overlay-${scopeHash.slice(0, 8)}`,
      lowerdir: `/mp/overlay-base/${scopeHash}/g${generation}`,
      upperdir: "/mp/sessions/x/overlay/h/upper",
      workdir: "/mp/sessions/x/overlay/h/work",
      depDir: "node_modules",
      mountPath: "/workspace/node_modules",
      scope: { repoUrl: "r", runtimeKey: "rt", depDir: "node_modules" },
      scopeHash,
      generation,
    };
  }

  function pointer(
    commit: string,
    generation: number,
    marker?: { runtimeKey: string; installCommands: string[]; depsHash?: string | null },
  ) {
    return {
      scopeHash: "h1", commit, depth: 1, generation,
      baseDir: `/state/overlay-base/h1/g${generation}`,
      updatedAt: "2026-06-10T00:00:00Z",
      ...(marker ? { marker } : {}),
    };
  }

  function writeNpmDepFiles(dir: string, lock = '{"lockfileVersion":3}'): string {
    fs.writeFileSync(path.join(dir, "package.json"), '{"name":"x"}');
    fs.writeFileSync(path.join(dir, "package-lock.json"), lock);
    const hash = computeInstallDepsHash(dir, ["npm install"], null);
    if (hash === null) throw new Error("expected a non-null deps hash");
    return hash;
  }

  const WORKER_RT = "img|x64|glibc-2.36|node24";

  function markerPathFor(workspaceDir: string): string {
    return path.join(path.dirname(workspaceDir), "state", "shared", ".install-done");
  }

  it("stamps the marker when commit, generation, commands, and runtime key all line up", async () => {
    const { dir, head } = await gitWorkspace();
    const ok = await preStampInstallMarker({
      stateDir: "/state",
      workspaceDir: dir,
      specs: [spec("h1", 3)],
      readPointer: () => pointer(head, 3, { runtimeKey: WORKER_RT, installCommands: ["npm install"] }),
    });
    expect(ok).toBe(true);
    const written = JSON.parse(fs.readFileSync(markerPathFor(dir), "utf8"));
    expect(written).toMatchObject({
      version: 2,
      sourceCommit: head,
      runtimeKey: WORKER_RT,
      installCommands: ["npm install"],
    });
    expect(written.depsHash).toBeNull();
  });

  it("stamps a content depsHash when the dep input files exist (docs/197)", async () => {
    const { dir, head } = await gitWorkspace();
    fs.writeFileSync(path.join(dir, "package.json"), '{"name":"x"}');
    fs.writeFileSync(path.join(dir, "package-lock.json"), '{"lockfileVersion":3}');
    const ok = await preStampInstallMarker({
      stateDir: "/state",
      workspaceDir: dir,
      specs: [spec("h1", 3)],
      readPointer: () => pointer(head, 3, { runtimeKey: WORKER_RT, installCommands: ["npm install"] }),
    });
    expect(ok).toBe(true);
    const written = JSON.parse(fs.readFileSync(markerPathFor(dir), "utf8"));
    expect(typeof written.depsHash).toBe("string");
    expect(written.depsHash).toHaveLength(64);
  });

  /**
   * docs/276-shared-package-cache-integrity section 5: the verified pnpm base is published UNBUILT
   * and reconciles nothing, so a pre-stamp would make a matching session skip the install that runs
   * its approved builds and reconciles its own graph. Decided off the SPEC, so the refusal cannot
   * address a different scope than the mount.
   */
  it("refuses to pre-stamp a pnpm session, on inputs that stamp an npm one", async () => {
    const { dir, head } = await gitWorkspace("pnpm install");
    const ptr = pointer(head, 3, { runtimeKey: WORKER_RT, installCommands: ["pnpm install"] });
    const verified = {
      ...spec("h1", 3),
      scope: { repoUrl: "r", runtimeKey: "rt", depDir: "node_modules", namespace: PNPM_VERIFIED_NAMESPACE },
    };

    // Control: the identical inputs in the un-namespaced scope DO stamp, so this cell fails on the
    // namespace and not on some unrelated refusal.
    expect(await preStampInstallMarker({
      stateDir: "/state", workspaceDir: dir, specs: [spec("h1", 3)], readPointer: () => ptr,
    })).toBe(true);
    fs.rmSync(markerPathFor(dir));

    expect(await preStampInstallMarker({
      stateDir: "/state", workspaceDir: dir, specs: [verified], readPointer: () => ptr,
    })).toBe(false);
    expect(fs.existsSync(markerPathFor(dir))).toBe(false);
  });

  it("declines on commit mismatch, generation mismatch, command mismatch, or a pointer without marker", async () => {
    const { dir, head } = await gitWorkspace();
    const cases = [
      pointer("f".repeat(40), 3, { runtimeKey: WORKER_RT, installCommands: ["npm install"] }),
      pointer(head, 4, { runtimeKey: WORKER_RT, installCommands: ["npm install"] }),
      pointer(head, 3, { runtimeKey: WORKER_RT, installCommands: ["pnpm install"] }),
      pointer(head, 3),
    ];
    for (const ptr of cases) {
      expect(await preStampInstallMarker({
        stateDir: "/state", workspaceDir: dir, specs: [spec("h1", 3)], readPointer: () => ptr,
      })).toBe(false);
    }
    expect(fs.existsSync(markerPathFor(dir))).toBe(false);
  });

  it("hands the written marker dir + file back to the worker uid (no root-owned state dir)", async () => {
    const { dir, head } = await gitWorkspace();
    const chown = vi.fn();
    const ok = await preStampInstallMarker({
      stateDir: "/state",
      workspaceDir: dir,
      specs: [spec("h1", 3)],
      readPointer: () => pointer(head, 3, { runtimeKey: WORKER_RT, installCommands: ["npm install"] }),
      chown,
    });
    expect(ok).toBe(true);
    expect(chown).toHaveBeenCalledWith(path.dirname(markerPathFor(dir)));
    expect(chown).toHaveBeenCalledWith(markerPathFor(dir));
  });

  it("does not chown when no marker is written (declined pre-stamp)", async () => {
    const { dir } = await gitWorkspace();
    const chown = vi.fn();
    const ok = await preStampInstallMarker({
      stateDir: "/state",
      workspaceDir: dir,
      specs: [spec("h1", 3)],
      readPointer: () => pointer("f".repeat(40), 3, { runtimeKey: WORKER_RT, installCommands: ["npm install"] }),
      chown,
    });
    expect(ok).toBe(false);
    expect(chown).not.toHaveBeenCalled();
  });

  it("never clobbers an existing marker", async () => {
    const { dir, head } = await gitWorkspace();
    fs.mkdirSync(path.dirname(markerPathFor(dir)), { recursive: true });
    fs.writeFileSync(markerPathFor(dir), "EXISTING");
    const ok = await preStampInstallMarker({
      stateDir: "/state",
      workspaceDir: dir,
      specs: [spec("h1", 3)],
      readPointer: () => pointer(head, 3, { runtimeKey: WORKER_RT, installCommands: ["npm install"] }),
    });
    expect(ok).toBe(false);
    expect(fs.readFileSync(markerPathFor(dir), "utf8")).toBe("EXISTING");
  });

  // The incident: two of three declared dirs were mounted, the base hit stamped on that partial
  // quorum, and the install step that fills the third never ran while ShipIt reported success.
  it("refuses to stamp when a declared dep dir is not among the mounted specs", async () => {
    const { dir, head } = await gitWorkspace();
    fs.writeFileSync(
      path.join(dir, "shipit.yaml"),
      "agent:\n  install:\n    - npm install\n  dep-dirs:\n    - node_modules\n    - .tools/blender\n",
    );
    const ok = await preStampInstallMarker({
      stateDir: "/state",
      workspaceDir: dir,
      specs: [spec("h1", 3)],
      readPointer: () => pointer(head, 3, { runtimeKey: WORKER_RT, installCommands: ["npm install"] }),
    });
    expect(ok).toBe(false);
    expect(fs.existsSync(markerPathFor(dir))).toBe(false);
  });

  it("stamps when every declared dep dir has a spec", async () => {
    const { dir, head } = await gitWorkspace();
    fs.writeFileSync(
      path.join(dir, "shipit.yaml"),
      "agent:\n  install:\n    - npm install\n  dep-dirs:\n    - node_modules\n    - .tools/blender\n",
    );
    const blender = { ...spec("h2", 3), depDir: ".tools/blender", mountPath: "/workspace/.tools/blender" };
    const ok = await preStampInstallMarker({
      stateDir: "/state",
      workspaceDir: dir,
      specs: [spec("h1", 3), blender],
      readPointer: () => pointer(head, 3, { runtimeKey: WORKER_RT, installCommands: ["npm install"] }),
    });
    expect(ok).toBe(true);
  });

  it("stamps on a commit MISMATCH when the pointer's depsHash matches this workspace (docs/198)", async () => {
    const { dir, head } = await gitWorkspace();
    const depsHash = writeNpmDepFiles(dir);
    const ok = await preStampInstallMarker({
      stateDir: "/state",
      workspaceDir: dir,
      specs: [spec("h1", 3)],
      readPointer: () =>
        pointer("f".repeat(40), 3, { runtimeKey: WORKER_RT, installCommands: ["npm install"], depsHash }),
    });
    expect(ok).toBe(true);
    const written = JSON.parse(fs.readFileSync(markerPathFor(dir), "utf8"));
    expect(written.sourceCommit).toBe(head);
    expect(written.depsHash).toBe(depsHash);
  });

  it("does NOT stamp on a commit mismatch when the dep files DIFFER (docs/198)", async () => {
    const { dir } = await gitWorkspace();
    writeNpmDepFiles(dir, '{"lockfileVersion":3}');
    const otherHash = "a".repeat(64);
    const ok = await preStampInstallMarker({
      stateDir: "/state",
      workspaceDir: dir,
      specs: [spec("h1", 3)],
      readPointer: () =>
        pointer("f".repeat(40), 3, { runtimeKey: WORKER_RT, installCommands: ["npm install"], depsHash: otherHash }),
    });
    expect(ok).toBe(false);
    expect(fs.existsSync(markerPathFor(dir))).toBe(false);
  });

  it("does NOT take the content path against a legacy pointer with no depsHash (docs/198)", async () => {
    const { dir } = await gitWorkspace();
    writeNpmDepFiles(dir);
    const ok = await preStampInstallMarker({
      stateDir: "/state",
      workspaceDir: dir,
      specs: [spec("h1", 3)],
      readPointer: () =>
        pointer("f".repeat(40), 3, { runtimeKey: WORKER_RT, installCommands: ["npm install"] }),
    });
    expect(ok).toBe(false);
  });

  it("does NOT take the content path when this workspace has no content key (commit mismatch, null hash)", async () => {
    const { dir } = await gitWorkspace();
    const ok = await preStampInstallMarker({
      stateDir: "/state",
      workspaceDir: dir,
      specs: [spec("h1", 3)],
      readPointer: () =>
        pointer("f".repeat(40), 3, { runtimeKey: WORKER_RT, installCommands: ["npm install"], depsHash: "b".repeat(64) }),
    });
    expect(ok).toBe(false);
  });

  it("content path still requires command + runtime agreement (docs/198)", async () => {
    const { dir } = await gitWorkspace();
    const depsHash = writeNpmDepFiles(dir);
    const ok = await preStampInstallMarker({
      stateDir: "/state",
      workspaceDir: dir,
      specs: [spec("h1", 3)],
      readPointer: () =>
        pointer("f".repeat(40), 3, { runtimeKey: WORKER_RT, installCommands: ["pnpm install"], depsHash }),
    });
    expect(ok).toBe(false);
  });

  it("requires EVERY dep dir's pointer to match (one cold scope blocks the stamp)", async () => {
    const { dir, head } = await gitWorkspace();
    const ptrs: Record<string, ReturnType<typeof pointer> | null> = {
      h1: pointer(head, 3, { runtimeKey: WORKER_RT, installCommands: ["npm install"] }),
      h2: null,
    };
    const ok = await preStampInstallMarker({
      stateDir: "/state",
      workspaceDir: dir,
      specs: [spec("h1", 3), { ...spec("h2", 0), scopeHash: "h2" }],
      readPointer: (_s, hash) => ptrs[hash] ?? null,
    });
    expect(ok).toBe(false);
  });
});

// docs/276 section 5: the store is private per session. The runtime key deliberately plays no
// part — two sessions of the SAME repo on the SAME runtime must not share a store index.
describe("pnpm store helpers", () => {
  it("sessionPnpmStoreDir is keyed by session and lives under the session's directory", () => {
    const dir = sessionPnpmStoreDir("/state", "sess-1");
    expect(dir).toBe(path.join("/state", "sessions", "sess-1", "overlay", "pnpm-store"));
    expect(sessionPnpmStoreDir("/state", "sess-2")).not.toBe(dir);
  });

  it("the retired shared root is the path the janitor ages out", () => {
    expect(retiredSharedPnpmStoreRoot("/state")).toBe(path.join("/state", "pnpm-store"));
  });
});
