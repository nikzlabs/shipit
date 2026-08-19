/**
 * nikzlabs/shipit#2426 — which overlay dep dirs a SIBLING container mounts.
 *
 * A plugin companion CLI's invocation container gets its own copy of the
 * session's working tree, so it must nest the SAME per-dep-dir overlays the
 * agent container has — or `/project/node_modules` (and `/plugin`'s, under
 * `repo: self`) is the empty mount point the dep dir is on the workspace volume,
 * and the plugin fails on its own import.
 *
 * These tests pin the decision that keeps the two sides in agreement: the answer
 * comes from what the agent container was PROVISIONED with, and the live
 * workspace is consulted only when there is no container record to read.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

/**
 * A Docker double where only the named volumes exist (404 otherwise), recording
 * every volume it was asked about so a test can tell WHICH path ran.
 */
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

/** A real git workspace whose `node_modules` is git-ignored — what re-derivation needs to yield a spec. */
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
        // The live workspace does not exist, so a re-derivation would have to
        // fail — which is the point. Re-reading `shipit.yaml`, the pnpm signals
        // or `git check-ignore` here is exactly how the sibling ends up with a
        // different dependency tree than the agent.
        workspaceDir: "/nonexistent",
        session: SESSION,
        provisioned,
      },
    );

    expect(pairs).toEqual(provisioned);
  });

  it("applies an authoritative empty answer without re-deriving", async () => {
    // `[]` from the record means the agent container genuinely has no overlay
    // (a pnpm repo, a container from before the feature), so the sibling
    // correctly nests nothing.
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

    // The survivor is still mounted — one missing volume must not cost the run
    // every other dep dir. A `docker create` naming a volume that does not exist
    // conjures an empty one, which looks exactly like the bug being fixed.
    expect(pairs).toEqual([{ depDir: "node_modules", volumeName: "shipit-s1_overlay-live" }]);
    expect(warn.mock.calls.flat().join(" ")).toContain("vendor");
    warn.mockRestore();
  });

  it("falls back to re-derivation only when there is no container record", async () => {
    // A real workspace this time, so re-derivation can actually produce a spec —
    // otherwise both branches would answer `[]` and the test could not tell them
    // apart. `null` is "cannot say": no container record at all.
    const workspaceDir = await makeWorkspace();
    const deps = makeDeps(["shipit-workspace"], { workspaceVolume: "shipit-workspace" });

    await resolveSiblingOverlayDepDirs(deps, {
      sessionId: "s1", workspaceDir, session: SESSION, provisioned: null,
    });

    // Re-derivation resolves the workspace state volume's mountpoint before it
    // can build any spec — so this call is the fingerprint of that path.
    expect(deps.inspected).toContain("shipit-workspace");
  });

  it("never re-derives when a record exists, even an empty one", async () => {
    // The whole point: a `shipit.yaml` edit or a pnpm-signal flip must not be
    // able to give the sibling a different dependency tree than the agent has.
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

/**
 * planning#440 — the in-flight claim's lifecycle. `prepareOverlaySpecs` is where a
 * container's base generation is DECIDED, and from there until `container.start()`
 * returns nothing the disk janitor can observe pins it: the pointer may advance
 * (a same-scope publish) and `docker ps -q` cannot list a container that does not
 * exist yet. The claim taken here is the only thing that keeps
 * `sweepStaleBaseGenerations` off the lowerdir in that window.
 */
describe("prepareOverlaySpecs base-generation claims (planning#440)", () => {
  beforeEach(() => { clearOverlayBaseClaims(); });
  afterEach(() => { clearOverlayBaseClaims(); });

  /** A state dir whose pointer for `node_modules` sits at `generation`. */
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

    // The spec pins g5, so g5 — not the pointer's value at some later moment —
    // is what has to survive the sweep.
    expect(specs.map((s) => [s.scopeHash, s.generation])).toEqual([[scopeHash, 5]]);
    expect(liveOverlayBaseClaims()).toEqual([`${scopeHash}/g5`]);
  });

  it("does not claim on a read-back path, where a RUNNING container already pins the mount", async () => {
    // `requireProvisioned` callers (the compose override, a sibling container)
    // describe what an existing container has mounted. `docker ps` pins that
    // already, and claiming here would retain generations for reasons that have
    // nothing to do with an in-flight create.
    const workspaceDir = await makeWorkspace();
    const scopeHash = nodeModulesHash();
    const stateDir = stateDirWithPointer(scopeHash, 5);
    // The overlay volume exists, so the spec survives the provisioned filter —
    // otherwise an empty result would make the assertion vacuous.
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
    // `attemptContainerCreate` calls this once per attempt; the refreshed expiry
    // is what stops a slow retry loop from outliving its own claim.
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

    // Read the registry a hair past the FIRST claim's expiry: the second claim
    // must still be holding it.
    vi.spyOn(Date, "now").mockReturnValue(realNow + OVERLAY_BASE_CLAIM_MS + 1);
    expect(liveOverlayBaseClaims()).toEqual([`${scopeHash}/g5`]);
    vi.restoreAllMocks();
  });
});
