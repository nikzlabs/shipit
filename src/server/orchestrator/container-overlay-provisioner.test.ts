import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import simpleGit from "simple-git";
import {
  prepareOverlaySpecs,
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
import { PNPM_VERIFIED_NAMESPACE } from "./overlay-session.js";
import type { SessionInfo } from "../shared/types.js";

const SESSION = { remoteUrl: "https://github.com/owner/repo.git", kind: "repo" } as unknown as SessionInfo;

function makeDeps(
  existingVolumes: string[],
  extra: Partial<OverlayProvisionerDeps> = {},
): OverlayProvisionerDeps & { inspected: string[] } {
  const inspected: string[] = [];
  return {
    docker: {
      getVolume: (name: string) => ({
        inspect: async () => {
          inspected.push(name);
          if (existingVolumes.includes(name)) return { Mountpoint: `/var/lib/docker/volumes/${name}/_data` };
          throw Object.assign(new Error("no such volume"), { statusCode: 404 });
        },
      }),
    },
    inspected,
    ...extra,
  } as unknown as OverlayProvisionerDeps & { inspected: string[] };
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function makeWorkspace(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sibling-overlay-"));
  tmpDirs.push(dir);
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

describe("prepareOverlaySpecs — the pnpm no-lockfile consumer gate (docs/276 section 5)", () => {
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

  async function pnpmWorkspace(opts: { lockfile: boolean; manifest?: object }): Promise<string> {
    const dir = await makeWorkspace();
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify(opts.manifest ?? { packageManager: "pnpm@12.4.1" }),
    );
    if (opts.lockfile) fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    return dir;
  }

  it("mounts the verified base for a pnpm checkout that HAS a lockfile", async () => {
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

  it("releases the claims it took when the all-or-nothing verified gate then refuses", async () => {
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
});
