import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import simpleGit from "simple-git";
import {
  MOUNT_VERIFIED_PNPM_BASE,
  prepareOverlaySpecs,
  preparePnpmStore,
  resolveSiblingOverlayDepDirs,
} from "./container-overlay-provisioner.js";
import type { OverlayProvisionerDeps } from "./container-overlay-provisioner.js";
import { overlayScopeHash, overlayVolumeName } from "./overlay-volume.js";
import { overlayRuntimeKey } from "./overlay-session.js";
import {
  clearOverlayBaseClaims,
  liveOverlayBaseClaims,
  newOverlayClaimToken,
  releaseOverlayBaseClaims,
} from "./overlay-base-claims.js";
import { PNPM_VERIFIED_NAMESPACE, sessionOverlayGenDir } from "./overlay-session.js";
import { INSTALL_MARKER_FILE, sessionSharedStateDir, sessionStateDirForWorkspace } from "./session-state-dir.js";
import type { SessionInfo } from "../shared/types.js";

const SESSION = { remoteUrl: "https://github.com/owner/repo.git", kind: "repo" } as unknown as SessionInfo;

interface DockerQuery { volumeFilters?: unknown; containerFilters?: unknown }

function makeDeps(
  existingVolumes: string[],
  extra: Partial<OverlayProvisionerDeps> & {
    /** Overlay volumes of a container created before the gate, and whatever still mounts them. */
    overlayVolumes?: string[];
    holders?: string[];
    dockerFails?: boolean;
    queries?: DockerQuery;
  } = {},
): OverlayProvisionerDeps & { inspected: string[] } {
  const inspected: string[] = [];
  const { overlayVolumes, holders, dockerFails, queries, ...rest } = extra;
  return {
    docker: {
      getVolume: (name: string) => ({
        inspect: async () => {
          inspected.push(name);
          if (existingVolumes.includes(name)) return { Mountpoint: `/var/lib/docker/volumes/${name}/_data` };
          throw Object.assign(new Error("no such volume"), { statusCode: 404 });
        },
      }),
      listVolumes: async (opts?: { filters?: unknown }) => {
        if (queries) queries.volumeFilters = opts?.filters;
        if (dockerFails) throw new Error("docker is unreachable");
        return { Volumes: (overlayVolumes ?? []).map((Name) => ({ Name })) };
      },
      listContainers: async (opts?: { filters?: unknown }) => {
        if (queries) queries.containerFilters = opts?.filters;
        return (holders ?? []).map((name) => ({ Id: name, Names: [name] }));
      },
    },
    inspected,
    ...rest,
  } as unknown as OverlayProvisionerDeps & { inspected: string[] };
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function makeWorkspace(at?: string): Promise<string> {
  let dir: string;
  if (at) {
    dir = at;
    fs.mkdirSync(dir, { recursive: true });
  } else {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sibling-overlay-"));
    tmpDirs.push(dir);
  }
  fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n");
  fs.writeFileSync(path.join(dir, "package.json"), "{}");
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig("user.email", "t@example.com");
  await git.addConfig("user.name", "t");
  await git.add(".");
  await git.commit("init");
  return dir;
}

describe("resolveSiblingOverlayDepDirs (#2426)", () => {
  it("mounts exactly what the agent container was provisioned with", async () => {
    const provisioned = [
      { depDir: "node_modules", volumeName: "shipit-s1_overlay-aaaa" },
      { depDir: "packages/app/node_modules", volumeName: "shipit-s1_overlay-bbbb" },
    ];

    const pairs = await resolveSiblingOverlayDepDirs(
      makeDeps(provisioned.map((p) => p.volumeName)),
      {
        sessionId: "s1",
        workspaceDir: "/nonexistent",
        session: SESSION,
        provisioned,
      },
    );

    expect(pairs).toEqual(provisioned);
  });

  it("applies an authoritative empty answer without re-deriving", async () => {
    const pairs = await resolveSiblingOverlayDepDirs(makeDeps([]), {
      sessionId: "s1",
      workspaceDir: "/nonexistent",
      session: SESSION,
      provisioned: [],
    });

    expect(pairs).toEqual([]);
  });

  it("drops a recorded pair whose volume has gone, and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const pairs = await resolveSiblingOverlayDepDirs(makeDeps(["shipit-s1_overlay-live"]), {
      sessionId: "s1",
      workspaceDir: "/nonexistent",
      session: SESSION,
      provisioned: [
        { depDir: "node_modules", volumeName: "shipit-s1_overlay-live" },
        { depDir: "vendor", volumeName: "shipit-s1_overlay-gone" },
      ],
    });

    expect(pairs).toEqual([{ depDir: "node_modules", volumeName: "shipit-s1_overlay-live" }]);
    expect(warn.mock.calls.flat().join(" ")).toContain("vendor");
    warn.mockRestore();
  });

  it("falls back to re-derivation only when there is no container record", async () => {
    const workspaceDir = await makeWorkspace();
    const deps = makeDeps(["shipit-workspace"], { workspaceVolume: "shipit-workspace" });

    await resolveSiblingOverlayDepDirs(deps, {
      sessionId: "s1", workspaceDir, session: SESSION, provisioned: null,
    });

    expect(deps.inspected).toContain("shipit-workspace");
  });

  it("never re-derives when a record exists, even an empty one", async () => {
    const workspaceDir = await makeWorkspace();

    for (const provisioned of [[], [{ depDir: "node_modules", volumeName: "shipit-s1_overlay-aaaa" }]]) {
      const deps = makeDeps(["shipit-s1_overlay-aaaa"], { workspaceVolume: "shipit-workspace" });
      await resolveSiblingOverlayDepDirs(deps, {
        sessionId: "s1", workspaceDir, session: SESSION, provisioned,
      });
      expect(deps.inspected).not.toContain("shipit-workspace");
    }
  });
});

describe("prepareOverlaySpecs base-generation claims (planning#440)", () => {
  afterEach(() => { clearOverlayBaseClaims(); });

  function stateDirWithPointer(
    scopeHash: string,
    generation: number,
    opts: { materialize?: boolean } = {},
  ): string {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-claim-state-"));
    tmpDirs.push(stateDir);
    const metaDir = path.join(stateDir, "overlay-base-meta");
    fs.mkdirSync(metaDir, { recursive: true });
    const baseDir = path.join(stateDir, "overlay-base", scopeHash, `g${generation}`);
    fs.writeFileSync(
      path.join(metaDir, `${scopeHash}.json`),
      JSON.stringify({
        scopeHash, commit: "a".repeat(40), depth: 1, generation, baseDir,
        updatedAt: "2026-08-19T10:00:00Z",
      }),
    );
    if (opts.materialize !== false) fs.mkdirSync(baseDir, { recursive: true });
    return stateDir;
  }

  const nodeModulesHash = (): string =>
    overlayScopeHash(SESSION.remoteUrl!, overlayRuntimeKey(), "node_modules");

  it("claims exactly the generation the spec pins, on a creation path", async () => {
    const workspaceDir = await makeWorkspace();
    const scopeHash = nodeModulesHash();
    const stateDir = stateDirWithPointer(scopeHash, 5);
    const deps = makeDeps(["shipit-workspace"], { workspaceVolume: "shipit-workspace", stateDir });

    const specs = await prepareOverlaySpecs(deps, {
      sessionId: "11111111-1111-4111-8111-111111111111",
      workspaceDir,
      session: SESSION,
      claimToken: newOverlayClaimToken(),
    });

    expect(specs.map((s) => [s.scopeHash, s.generation])).toEqual([[scopeHash, 5]]);
    expect(liveOverlayBaseClaims()).toEqual([`${scopeHash}/g5`]);
  });

  it("does not claim on a read-back path, where a RUNNING container already pins the mount", async () => {
    const workspaceDir = await makeWorkspace();
    const scopeHash = nodeModulesHash();
    const stateDir = stateDirWithPointer(scopeHash, 5);
    const sessionId = "22222222-2222-4222-8222-222222222222";
    const volumeName = overlayVolumeName(sessionId, "node_modules");
    const deps = makeDeps(["shipit-workspace", volumeName], {
      workspaceVolume: "shipit-workspace", stateDir,
    });

    const specs = await prepareOverlaySpecs(deps, {
      sessionId, workspaceDir, session: SESSION, requireProvisioned: true,
    });

    expect(specs).toHaveLength(1);
    expect(liveOverlayBaseClaims()).toEqual([]);
  });

  it("holds the claim until its own token is released, however long the mount takes (docs/276)", async () => {
    const workspaceDir = await makeWorkspace();
    const scopeHash = nodeModulesHash();
    const stateDir = stateDirWithPointer(scopeHash, 5);
    const deps = makeDeps(["shipit-workspace"], { workspaceVolume: "shipit-workspace", stateDir });
    const token = newOverlayClaimToken();
    const opts = { sessionId: "33333333-3333-4333-8333-333333333333", workspaceDir, session: SESSION };

    await prepareOverlaySpecs(deps, { ...opts, claimToken: token });
    // An hour of select→mount — six times the expiry this replaced — still holds.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60 * 60_000);
    expect(liveOverlayBaseClaims()).toEqual([`${scopeHash}/g5`]);
    vi.restoreAllMocks();

    // Re-selecting under the same token is idempotent; one release covers every dep dir it claimed.
    await prepareOverlaySpecs(deps, { ...opts, claimToken: token });
    expect(liveOverlayBaseClaims()).toEqual([`${scopeHash}/g5`]);
    releaseOverlayBaseClaims(token);
    expect(liveOverlayBaseClaims()).toEqual([]);
  });

  /**
   * Two creation ATTEMPTS for one session overlap in production: a standby create the runner stopped
   * waiting for, plus the cold-create fallback. A session-keyed claim let the second attempt's
   * release drop the first attempt's protection while it was still mounting (review, 2026-09-21).
   */
  it("does not let one attempt's release drop another attempt's claim for the SAME session", async () => {
    const workspaceDir = await makeWorkspace();
    const scopeHash = nodeModulesHash();
    const stateDir = stateDirWithPointer(scopeHash, 5);
    const deps = makeDeps(["shipit-workspace"], { workspaceVolume: "shipit-workspace", stateDir });
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const first = newOverlayClaimToken();
    const second = newOverlayClaimToken();

    await prepareOverlaySpecs(deps, { sessionId, workspaceDir, session: SESSION, claimToken: first });
    await prepareOverlaySpecs(deps, { sessionId, workspaceDir, session: SESSION, claimToken: second });
    releaseOverlayBaseClaims(second);

    expect(liveOverlayBaseClaims()).toEqual([`${scopeHash}/g5`]);
    releaseOverlayBaseClaims(first);
    expect(liveOverlayBaseClaims()).toEqual([]);
  });

  it("keeps a generation claimed while ANOTHER session still holds it", async () => {
    const workspaceDir = await makeWorkspace();
    const scopeHash = nodeModulesHash();
    const stateDir = stateDirWithPointer(scopeHash, 5);
    const deps = makeDeps(["shipit-workspace"], { workspaceVolume: "shipit-workspace", stateDir });
    const a = newOverlayClaimToken();
    const b = newOverlayClaimToken();

    await prepareOverlaySpecs(deps, {
      sessionId: "44444444-4444-4444-8444-444444444444", workspaceDir, session: SESSION, claimToken: a,
    });
    await prepareOverlaySpecs(deps, {
      sessionId: "55555555-5555-4555-8555-555555555555", workspaceDir, session: SESSION, claimToken: b,
    });
    releaseOverlayBaseClaims(a);

    expect(liveOverlayBaseClaims()).toEqual([`${scopeHash}/g5`]);
    releaseOverlayBaseClaims(b);
    expect(liveOverlayBaseClaims()).toEqual([]);
  });

  it("selects generation 0 when the published generation is gone, and never recreates it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const workspaceDir = await makeWorkspace();
    const scopeHash = nodeModulesHash();
    const stateDir = stateDirWithPointer(scopeHash, 5, { materialize: false });
    const deps = makeDeps(["shipit-workspace"], { workspaceVolume: "shipit-workspace", stateDir });

    const specs = await prepareOverlaySpecs(deps, {
      sessionId: "66666666-6666-4666-8666-666666666666",
      workspaceDir,
      session: SESSION,
      claimToken: newOverlayClaimToken(),
    });

    expect(specs.map((s) => s.generation)).toEqual([0]);
    expect(liveOverlayBaseClaims()).toEqual([`${scopeHash}/g0`]);
    expect(fs.existsSync(path.join(stateDir, "overlay-base", scopeHash, "g5"))).toBe(false);
    warn.mockRestore();
  });
});

describe("prepareOverlaySpecs — the pnpm consumer gates (docs/276 section 5, planning#606)", () => {
  afterEach(() => { clearOverlayBaseClaims(); });

  const pnpmScopeHash = (): string =>
    overlayScopeHash(SESSION.remoteUrl!, overlayRuntimeKey(), "node_modules", PNPM_VERIFIED_NAMESPACE);

  function verifiedStateDir(generation: number): string {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-pnpm-state-"));
    tmpDirs.push(stateDir);
    const scopeHash = pnpmScopeHash();
    const metaDir = path.join(stateDir, "overlay-base-meta");
    fs.mkdirSync(metaDir, { recursive: true });
    const baseDir = path.join(stateDir, "overlay-base", scopeHash, `g${generation}`);
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(
      path.join(metaDir, `${scopeHash}.json`),
      JSON.stringify({
        scopeHash, commit: "b".repeat(40), depth: 1, generation, baseDir,
        updatedAt: "2026-09-21T10:00:00Z",
      }),
    );
    return stateDir;
  }

  async function pnpmWorkspace(opts: { lockfile: boolean; manifest?: object; at?: string }): Promise<string> {
    const dir = await makeWorkspace(opts.at);
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify(opts.manifest ?? { packageManager: "pnpm@12.4.1" }),
    );
    if (opts.lockfile) fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    return dir;
  }

  // The repair (planning#606 step 2) flips MOUNT_VERIFIED_PNPM_BASE and nothing else, so the two
  // tests below swap places with it: what must hold is asserted on whichever side is shipped.
  it.runIf(MOUNT_VERIFIED_PNPM_BASE)("mounts the verified base for a pnpm checkout that HAS a lockfile", async () => {
    const workspaceDir = await pnpmWorkspace({ lockfile: true });
    const stateDir = verifiedStateDir(3);
    const deps = makeDeps(["shipit-workspace"], { workspaceVolume: "shipit-workspace", stateDir });

    const specs = await prepareOverlaySpecs(deps, {
      sessionId: "77777777-7777-4777-8777-777777777777",
      workspaceDir,
      session: SESSION,
    });

    expect(specs.map((s) => [s.scopeHash, s.generation])).toEqual([[pnpmScopeHash(), 3]]);
  });

  // planning#606: `pnpm add` chmods bin targets it does not own, so a mounted base fails req 9.
  it.runIf(!MOUNT_VERIFIED_PNPM_BASE)(
    "gives an otherwise ELIGIBLE pnpm checkout with a published pointer no base lowerdir",
    async () => {
      const workspaceDir = await pnpmWorkspace({ lockfile: true });
      const stateDir = verifiedStateDir(3);
      const deps = makeDeps(["shipit-workspace"], { workspaceVolume: "shipit-workspace", stateDir });

      const specs = await prepareOverlaySpecs(deps, {
        sessionId: "77777777-7777-4777-8777-777777777777",
        workspaceDir,
        session: SESSION,
        claimToken: newOverlayClaimToken(),
      });

      expect(specs).toEqual([]);
      expect(liveOverlayBaseClaims()).toEqual([]);
    },
  );

  // The gate is the package manager's, not the overlay's: the same state dir and pointer shape
  // still mount for an npm checkout, so an empty answer above cannot be the fixture being inert.
  it("leaves an npm checkout with a published pointer mounting its base", async () => {
    const workspaceDir = await makeWorkspace();
    const scopeHash = overlayScopeHash(SESSION.remoteUrl!, overlayRuntimeKey(), "node_modules");
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-npm-state-"));
    tmpDirs.push(stateDir);
    const metaDir = path.join(stateDir, "overlay-base-meta");
    fs.mkdirSync(metaDir, { recursive: true });
    const baseDir = path.join(stateDir, "overlay-base", scopeHash, "g3");
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(
      path.join(metaDir, `${scopeHash}.json`),
      JSON.stringify({
        scopeHash, commit: "c".repeat(40), depth: 1, generation: 3, baseDir,
        updatedAt: "2026-09-21T10:00:00Z",
      }),
    );
    const deps = makeDeps(["shipit-workspace"], { workspaceVolume: "shipit-workspace", stateDir });

    const specs = await prepareOverlaySpecs(deps, {
      sessionId: "66666666-6666-4666-8666-666666666666",
      workspaceDir,
      session: SESSION,
      claimToken: newOverlayClaimToken(),
    });

    expect(specs.map((s) => [s.scopeHash, s.generation])).toEqual([[scopeHash, 3]]);
  });

  // The store is private per session (req 1) whether or not a base is mounted; the gate is a
  // lowerdir decision only.
  it("still gives a pnpm session its own private store", async () => {
    const workspaceDir = await pnpmWorkspace({ lockfile: true });
    const stateDir = verifiedStateDir(3);

    const storeDir = preparePnpmStore(
      { workspaceVolume: "shipit-workspace", stateDir },
      { sessionId: "55555555-5555-4555-8555-555555555555", workspaceDir, session: SESSION },
    );

    expect(storeDir).toBe(
      path.join(stateDir, "sessions", "55555555-5555-4555-8555-555555555555", "overlay", "pnpm-store"),
    );
  });

  // The two gates below still state the contract, but while planning#606 holds the gate above
  // answers first; what discriminates them is `hasPnpmLockfile` / `usesVerifiedBaseCompatiblePnpm`
  // in `shared/pnpm-repo.test.ts`.
  it("gives a pnpm checkout with NO lockfile no base lowerdir, and claims nothing", async () => {
    const workspaceDir = await pnpmWorkspace({ lockfile: false });
    const stateDir = verifiedStateDir(3);
    const deps = makeDeps(["shipit-workspace"], { workspaceVolume: "shipit-workspace", stateDir });

    const specs = await prepareOverlaySpecs(deps, {
      sessionId: "88888888-8888-4888-8888-888888888888",
      workspaceDir,
      session: SESSION,
      claimToken: newOverlayClaimToken(),
    });

    expect(specs).toEqual([]);
    expect(liveOverlayBaseClaims()).toEqual([]);
  });

  // Measured 2026-09-21: a pnpm 10 consumer does not fail on a base the pinned pnpm 12 builder
  // produced — it prints "Recreating node_modules" and reinstalls, which over an overlay whiteouts
  // every base file into this session's upper. A plain private install is strictly cheaper.
  it("gives a pnpm checkout pinned to an older store version no base lowerdir", async () => {
    // Both declaration routes: measured on corepack 0.34.6 that `devEngines.packageManager` alone,
    // with no top-level `packageManager`, selects pnpm 10.28.2.
    const pins = [
      { packageManager: "pnpm@10.28.2" },
      { devEngines: { packageManager: { name: "pnpm", version: "10.28.2" } } },
    ];
    for (const [i, manifest] of pins.entries()) {
      const workspaceDir = await pnpmWorkspace({ lockfile: true, manifest });
      const stateDir = verifiedStateDir(3);
      const deps = makeDeps(["shipit-workspace"], { workspaceVolume: "shipit-workspace", stateDir });

      const specs = await prepareOverlaySpecs(deps, {
        sessionId: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${i}`,
        workspaceDir,
        session: SESSION,
        claimToken: newOverlayClaimToken(),
      });

      expect(specs, JSON.stringify(manifest)).toEqual([]);
      expect(liveOverlayBaseClaims()).toEqual([]);
    }
  });

  // Dormant while planning#606 holds: the gate above returns before any claim is taken, so this
  // asserts nothing about the release until the repair flips MOUNT_VERIFIED_PNPM_BASE back.
  it.runIf(MOUNT_VERIFIED_PNPM_BASE)("releases the claims it took when the all-or-nothing verified gate then refuses", async () => {
    const workspaceDir = await pnpmWorkspace({ lockfile: true });
    // A pnpm checkout with a lockfile but NO published pointer in the verified namespace.
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-pnpm-nopointer-"));
    tmpDirs.push(stateDir);
    const deps = makeDeps(["shipit-workspace"], { workspaceVolume: "shipit-workspace", stateDir });

    const specs = await prepareOverlaySpecs(deps, {
      sessionId: "99999999-9999-4999-8999-999999999999",
      workspaceDir,
      session: SESSION,
      claimToken: newOverlayClaimToken(),
    });

    expect(specs).toEqual([]);
    expect(liveOverlayBaseClaims()).toEqual([]);
  });

  // A session that mounted a base before the gate existed: its upper has lost its lower, and the
  // marker stamped over the merged view would make this start skip the install into an empty
  // node_modules.
  describe("a session that already had a verified base mounted (planning#606)", () => {
    async function mountedSession(sessionId: string): Promise<{
      workspaceDir: string; stateDir: string; markerFile: string; sessionScopeDir: string;
    }> {
      const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-pnpm-mounted-"));
      tmpDirs.push(sessionDir);
      const workspaceDir = await pnpmWorkspace({ lockfile: true, at: path.join(sessionDir, "workspace") });
      const stateDir = verifiedStateDir(3);
      const upper = path.join(sessionOverlayGenDir(stateDir, sessionId, pnpmScopeHash(), 3), "upper");
      fs.mkdirSync(upper, { recursive: true });
      fs.writeFileSync(path.join(upper, ".modules.yaml"), "storeDir: /workspace/.pnpm-store\n");
      const markerFile = path.join(
        sessionSharedStateDir(sessionStateDirForWorkspace(workspaceDir)),
        INSTALL_MARKER_FILE,
      );
      fs.mkdirSync(path.dirname(markerFile), { recursive: true });
      fs.writeFileSync(markerFile, "{}");
      return {
        workspaceDir, stateDir, markerFile,
        sessionScopeDir: path.join(stateDir, "sessions", sessionId, "overlay", pnpmScopeHash()),
      };
    }

    it("discards its overlay layers and its install marker on the next container start", async () => {
      const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const { workspaceDir, stateDir, markerFile, sessionScopeDir } = await mountedSession(sessionId);
      const deps = makeDeps(["shipit-workspace"], { workspaceVolume: "shipit-workspace", stateDir });

      const specs = await prepareOverlaySpecs(deps, {
        sessionId, workspaceDir, session: SESSION, claimToken: newOverlayClaimToken(),
      });

      expect(specs).toEqual([]);
      expect(fs.existsSync(sessionScopeDir)).toBe(false);
      expect(fs.existsSync(markerFile)).toBe(false);
    });

    // A layer selected under an older namespace or runtime key sits at a scope hash today's inputs
    // cannot reconstruct, and its marker would still skip the install.
    it("discards a layer whose scope hash the current inputs no longer name", async () => {
      const sessionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
      const { workspaceDir, stateDir, markerFile } = await mountedSession(sessionId);
      const retired = path.join(stateDir, "sessions", sessionId, "overlay", "0123456789abcdef", "g1", "upper");
      fs.mkdirSync(retired, { recursive: true });
      const deps = makeDeps(["shipit-workspace"], { workspaceVolume: "shipit-workspace", stateDir });

      await prepareOverlaySpecs(deps, {
        sessionId, workspaceDir, session: SESSION, claimToken: newOverlayClaimToken(),
      });

      expect(fs.existsSync(path.dirname(path.dirname(retired)))).toBe(false);
      expect(fs.existsSync(markerFile)).toBe(false);
    });

    // A preview preserved across an agent-container restart still mounts the upper; emptying it
    // under the running service is worse than keeping it until the next start.
    it("keeps layers a container still mounts, but drops the marker either way", async () => {
      const sessionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
      const { workspaceDir, stateDir, markerFile, sessionScopeDir } = await mountedSession(sessionId);
      const overlayVolume = overlayVolumeName(sessionId, "node_modules");
      const queries: DockerQuery = {};
      const deps = makeDeps(["shipit-workspace"], {
        workspaceVolume: "shipit-workspace", stateDir,
        overlayVolumes: [overlayVolume], holders: ["/dev-1"], queries,
      });

      const specs = await prepareOverlaySpecs(deps, {
        sessionId, workspaceDir, session: SESSION, claimToken: newOverlayClaimToken(),
      });

      expect(specs).toEqual([]);
      expect(fs.existsSync(sessionScopeDir)).toBe(true);
      expect(fs.existsSync(markerFile)).toBe(false);
      // The two queries must address THIS session's volumes: a prefix naming another session's
      // would report no holder and delete an upper that is mounted.
      expect(queries.volumeFilters).toEqual({ name: [overlayVolumeName(sessionId)] });
      expect(queries.containerFilters).toEqual({ volume: [overlayVolume] });
    });

    // Unreadable must count as held: deleting on a Docker error is the destructive direction.
    it("keeps layers when Docker cannot say what mounts them", async () => {
      const sessionId = "abababab-abab-4bab-8bab-ababababab01";
      const { workspaceDir, stateDir, markerFile, sessionScopeDir } = await mountedSession(sessionId);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const deps = makeDeps(["shipit-workspace"], {
        workspaceVolume: "shipit-workspace", stateDir, dockerFails: true,
      });

      await prepareOverlaySpecs(deps, {
        sessionId, workspaceDir, session: SESSION, claimToken: newOverlayClaimToken(),
      });

      warn.mockRestore();
      expect(fs.existsSync(sessionScopeDir)).toBe(true);
      expect(fs.existsSync(markerFile)).toBe(false);
    });

    // The private pnpm store lives beside the layers and is not one.
    it("never discards the session's pnpm store", async () => {
      const sessionId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
      const { workspaceDir, stateDir } = await mountedSession(sessionId);
      const store = path.join(stateDir, "sessions", sessionId, "overlay", "pnpm-store", "v11");
      fs.mkdirSync(store, { recursive: true });
      const deps = makeDeps(["shipit-workspace"], { workspaceVolume: "shipit-workspace", stateDir });

      await prepareOverlaySpecs(deps, {
        sessionId, workspaceDir, session: SESSION, claimToken: newOverlayClaimToken(),
      });

      expect(fs.existsSync(store)).toBe(true);
    });

    it("leaves them alone on a read-back path, where a container may still have them mounted", async () => {
      const sessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      const { workspaceDir, stateDir, markerFile, sessionScopeDir } = await mountedSession(sessionId);
      const deps = makeDeps(["shipit-workspace"], { workspaceVolume: "shipit-workspace", stateDir });

      const specs = await prepareOverlaySpecs(deps, {
        sessionId, workspaceDir, session: SESSION, requireProvisioned: true,
      });

      expect(specs).toEqual([]);
      expect(fs.existsSync(sessionScopeDir)).toBe(true);
      expect(fs.existsSync(markerFile)).toBe(true);
    });
  });
});
