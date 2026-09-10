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
  OVERLAY_BASE_CLAIM_MS,
} from "./overlay-base-claims.js";
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

  function stateDirWithPointer(scopeHash: string, generation: number): string {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-claim-state-"));
    tmpDirs.push(stateDir);
    const metaDir = path.join(stateDir, "overlay-base-meta");
    fs.mkdirSync(metaDir, { recursive: true });
    fs.writeFileSync(
      path.join(metaDir, `${scopeHash}.json`),
      JSON.stringify({
        scopeHash, commit: "a".repeat(40), depth: 1, generation,
        baseDir: path.join(stateDir, "overlay-base", scopeHash, `g${generation}`),
        updatedAt: "2026-08-19T10:00:00Z",
      }),
    );
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

  it("re-claims on every creation attempt, so a retried create keeps its window open", async () => {
    const workspaceDir = await makeWorkspace();
    const scopeHash = nodeModulesHash();
    const stateDir = stateDirWithPointer(scopeHash, 5);
    const deps = makeDeps(["shipit-workspace"], { workspaceVolume: "shipit-workspace", stateDir });
    const opts = {
      sessionId: "33333333-3333-4333-8333-333333333333",
      workspaceDir,
      session: SESSION,
    };

    await prepareOverlaySpecs(deps, opts);
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow + OVERLAY_BASE_CLAIM_MS - 1);
    await prepareOverlaySpecs(deps, opts);

    vi.spyOn(Date, "now").mockReturnValue(realNow + OVERLAY_BASE_CLAIM_MS + 1);
    expect(liveOverlayBaseClaims()).toEqual([`${scopeHash}/g5`]);
    vi.restoreAllMocks();
  });
});
