/**
 * docs/183 — overlay-session gating/scope/GC tests.
 *
 * Covers the design-agnostic reusable foundation: the feature gate + eligibility,
 * the orchestrator runtime fingerprint, and the GC live-source set. The per-session
 * mount-spec construction, snapshot pull, and publish-after-install flow were
 * whole-workspace-shaped and removed in the dep-dir pivot (they will be rebuilt
 * per declared dep dir); the publish CAS itself remains covered by
 * `overlay-base.test.ts`.
 */

import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import simpleGit from "simple-git";

import {
  buildOverlaySpecs,
  depDirsForSession,
  preStampInstallMarker,
  type DepDirOverlaySpec,
  isOverlayEligible,
  isOverlayEnabled,
  liveOverlayScopeHashes,
  overlayRuntimeKey,
  resolveOverlayScope,
  validDepDirsForOverlay,
} from "./overlay-session.js";
import { overlayScopeHash, overlayVolumeName } from "./overlay-volume.js";
import type { SessionInfo } from "../shared/types.js";

const ON = { OVERLAY_DEP_STORE: "1" } as NodeJS.ProcessEnv;
const OFF = {} as NodeJS.ProcessEnv;

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
  it("is off by default and on for 1/true", () => {
    expect(isOverlayEnabled(OFF)).toBe(false);
    expect(isOverlayEnabled({ OVERLAY_DEP_STORE: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isOverlayEnabled({ OVERLAY_DEP_STORE: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isOverlayEnabled({ OVERLAY_DEP_STORE: "yes" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("requires the flag, a remote, and a non-ops kind", () => {
    expect(isOverlayEligible(session(), OFF)).toBe(false); // flag off
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

describe("overlayRuntimeKey", () => {
  it("uses image id + arch, falling back to unknown", () => {
    expect(overlayRuntimeKey({ SESSION_WORKER_IMAGE_ID: "sha256:abc" } as NodeJS.ProcessEnv))
      .toBe(`sha256:abc|${process.arch}`);
    expect(overlayRuntimeKey({ IMAGE_DIGEST: "sha256:def" } as NodeJS.ProcessEnv))
      .toBe(`sha256:def|${process.arch}`);
    expect(overlayRuntimeKey({} as NodeJS.ProcessEnv)).toBe(`unknown|${process.arch}`);
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
      session({ id: "c", remoteUrl: "" }), // no remote → skipped
      session({ id: "d", remoteUrl: "https://github.com/acme/three.git", kind: "ops" }), // ops → skipped
      session({ id: "e", remoteUrl: "https://github.com/acme/four.git", diskTier: "evicted" }), // evicted → skipped
    ];
    // The first session declares two dep dirs; the rest declare one.
    const resolve = (s: SessionInfo): string[] =>
      s.remoteUrl === "https://github.com/acme/one.git"
        ? ["node_modules", "packages/app/node_modules"]
        : ["node_modules"];
    const live = liveOverlayScopeHashes(sessions, resolve, ON);
    expect(live).toEqual(
      new Set([
        overlayScopeHash("https://github.com/acme/one.git", rt, "node_modules"),
        overlayScopeHash("https://github.com/acme/one.git", rt, "packages/app/node_modules"),
        overlayScopeHash("https://github.com/acme/two.git", rt, "node_modules"),
      ]),
    );
  });

  it("uses the per-dep-dir hash, not the legacy (repo, runtime) hash", () => {
    const rt = overlayRuntimeKey(ON);
    const live = liveOverlayScopeHashes([session({ id: "a" })], () => ["node_modules"], ON);
    expect(live).toContain(overlayScopeHash("https://github.com/acme/repo.git", rt, "node_modules"));
    // The legacy 2-arg hash must NOT appear — it would never match a dep-dir base.
    expect(live).not.toContain(overlayScopeHash("https://github.com/acme/repo.git", rt));
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
    // No generation resolver → generation 0, the empty cold-start lowerdir.
    expect(nm.lowerdir).toBe(`${MP}/overlay-base/${hash}/g0`);
    expect(nm.upperdir).toBe(`${MP}/sessions/${sessionId}/overlay/${hash}/upper`);
    expect(nm.workdir).toBe(`${MP}/sessions/${sessionId}/overlay/${hash}/work`);
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
      upperdir: `/workspace/sessions/${sessionId}/overlay/${hash}/upper`,
      workdir: `/workspace/sessions/${sessionId}/overlay/${hash}/work`,
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
    // The other dep dir's scope has no base yet — cold-start g0.
    expect(vendor.lowerdir).toBe(`${MP}/overlay-base/${vendor.scopeHash}/g0`);
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
    // The fresh-clone case the overlay targets: `node_modules/` (trailing
    // slash) is the common .gitignore form, and the dep dir is absent until
    // the first install. `git check-ignore node_modules` does NOT match a
    // directory-only pattern for a non-existent path — only the slash-form
    // query does. Regression: prod fresh sessions silently got no overlay.
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
    // `src` exists and is committed-style source — not ignored → must not be overlaid.
    expect(await validDepDirsForOverlay(["src"], dir)).toEqual([]);
  });

  it("drops a dep dir whose parent directory does not exist", async () => {
    const dir = await repo({ gitignore: "node_modules\n" });
    // packages/app was never created → no real parent to nest the overlay onto.
    expect(await validDepDirsForOverlay(["packages/app/node_modules"], dir)).toEqual([]);
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

describe("preStampInstallMarker (docs/183 base-hit pre-stamp)", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  async function gitWorkspace(installCmd = "npm install"): Promise<{ dir: string; head: string }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prestamp-"));
    tmpDirs.push(dir);
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

  function pointer(commit: string, generation: number, marker?: { runtimeKey: string; installCommands: string[] }) {
    return {
      scopeHash: "h1", commit, depth: 1, generation,
      baseDir: `/state/overlay-base/h1/g${generation}`,
      updatedAt: "2026-06-10T00:00:00Z",
      ...(marker ? { marker } : {}),
    };
  }

  const WORKER_RT = "img|x64|glibc-2.36|node24";

  it("stamps the marker when commit, generation, commands, and runtime key all line up", async () => {
    const { dir, head } = await gitWorkspace();
    const ok = await preStampInstallMarker({
      stateDir: "/state",
      workspaceDir: dir,
      specs: [spec("h1", 3)],
      readPointer: () => pointer(head, 3, { runtimeKey: WORKER_RT, installCommands: ["npm install"] }),
    });
    expect(ok).toBe(true);
    const written = JSON.parse(fs.readFileSync(path.join(dir, ".shipit", ".install-done"), "utf8"));
    expect(written).toMatchObject({
      version: 2,
      sourceCommit: head,
      runtimeKey: WORKER_RT,
      installCommands: ["npm install"],
    });
    // docs/197 — no package.json/lockfile in this workspace, so there is nothing
    // to content-key: the pre-stamp records a null depsHash (commit-only).
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
    const written = JSON.parse(fs.readFileSync(path.join(dir, ".shipit", ".install-done"), "utf8"));
    expect(typeof written.depsHash).toBe("string");
    expect(written.depsHash).toHaveLength(64);
  });

  it("declines on commit mismatch, generation mismatch, command mismatch, or a pointer without marker", async () => {
    const { dir, head } = await gitWorkspace();
    const cases = [
      pointer("f".repeat(40), 3, { runtimeKey: WORKER_RT, installCommands: ["npm install"] }), // other commit
      pointer(head, 4, { runtimeKey: WORKER_RT, installCommands: ["npm install"] }),           // pointer moved on
      pointer(head, 3, { runtimeKey: WORKER_RT, installCommands: ["pnpm install"] }),          // other commands
      pointer(head, 3),                                                                        // no marker recorded
    ];
    for (const ptr of cases) {
      expect(await preStampInstallMarker({
        stateDir: "/state", workspaceDir: dir, specs: [spec("h1", 3)], readPointer: () => ptr,
      })).toBe(false);
    }
    expect(fs.existsSync(path.join(dir, ".shipit", ".install-done"))).toBe(false);
  });

  it("never clobbers an existing marker", async () => {
    const { dir, head } = await gitWorkspace();
    fs.mkdirSync(path.join(dir, ".shipit"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".shipit", ".install-done"), "EXISTING");
    const ok = await preStampInstallMarker({
      stateDir: "/state",
      workspaceDir: dir,
      specs: [spec("h1", 3)],
      readPointer: () => pointer(head, 3, { runtimeKey: WORKER_RT, installCommands: ["npm install"] }),
    });
    expect(ok).toBe(false);
    expect(fs.readFileSync(path.join(dir, ".shipit", ".install-done"), "utf8")).toBe("EXISTING");
  });

  it("requires EVERY dep dir's pointer to match (one cold scope blocks the stamp)", async () => {
    const { dir, head } = await gitWorkspace();
    const ptrs: Record<string, ReturnType<typeof pointer> | null> = {
      h1: pointer(head, 3, { runtimeKey: WORKER_RT, installCommands: ["npm install"] }),
      h2: null, // second dep dir has no base yet
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
