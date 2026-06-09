/**
 * docs/183 Phase 3/4 — overlay-session orchestration tests.
 *
 * Covers the pure/lifecycle logic that ties the proven overlay mechanism
 * (`overlay-volume.ts`) and decision (`overlay-base.ts`) halves to the session
 * lifecycle: the feature gate + eligibility, the orchestrator runtime
 * fingerprint, daemon-host spec construction (incl. the upper-persists /
 * workdir-resets contract), the publish-after-install eligibility short-circuit
 * and snapshot→publish path, and the GC live-source set. The actual daemon
 * overlay mount + compose wiring are host-gated and verified by the Phase-0/4
 * spikes (FINDINGS.md), not here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildOverlaySpec,
  isOverlayEligible,
  isOverlayEnabled,
  liveOverlayScopeHashes,
  overlayRuntimeKey,
  publishOverlayBaseAfterInstall,
  resolveOverlayScope,
} from "./overlay-session.js";
import { overlayBaseDir, overlayScopeHash, overlayVolumeName } from "./overlay-volume.js";
import { readBasePointer, type OverlayScope } from "./overlay-base.js";
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

describe("buildOverlaySpec", () => {
  let stateDir: string;
  const MOUNTPOINT = "/var/lib/docker/volumes/shipit-workspace/_data";

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "overlay-spec-"));
  });
  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  const deps = (over: Partial<Parameters<typeof buildOverlaySpec>[2]> = {}) => ({
    docker: {} as never,
    stateDir,
    workspaceVolume: "shipit-workspace",
    resolveMountpoint: async () => MOUNTPOINT,
    ...over,
  });

  it("resolves daemon-host absolute paths under the volume mountpoint", async () => {
    const scope: OverlayScope = { repoUrl: "r", runtimeKey: "k" };
    const s = session({ id: "abcdef0123456789aaaa" });
    const spec = await buildOverlaySpec(s, scope, deps());
    const hash = overlayScopeHash("r", "k");

    expect(spec.volumeName).toBe(overlayVolumeName(s.id));
    expect(spec.lowerdir).toBe(`${MOUNTPOINT}/overlay-base/${hash}`);
    expect(spec.upperdir).toBe(`${MOUNTPOINT}/sessions/${s.id}/overlay-upper`);
    expect(spec.workdir).toBe(`${MOUNTPOINT}/sessions/${s.id}/overlay-work`);
  });

  it("creates the (empty, cold-start v0) base dir and the upper/work dirs", async () => {
    const scope: OverlayScope = { repoUrl: "r", runtimeKey: "k" };
    const s = session({ id: "abcdef0123456789aaaa" });
    await buildOverlaySpec(s, scope, deps());
    const hash = overlayScopeHash("r", "k");
    expect(fsSync.existsSync(overlayBaseDir(stateDir, hash))).toBe(true);
    expect(fsSync.existsSync(path.join(stateDir, "sessions", s.id, "overlay-upper"))).toBe(true);
    expect(fsSync.existsSync(path.join(stateDir, "sessions", s.id, "overlay-work"))).toBe(true);
  });

  it("preserves the upper across rebuilds but resets the workdir", async () => {
    const scope: OverlayScope = { repoUrl: "r", runtimeKey: "k" };
    const s = session({ id: "abcdef0123456789aaaa" });
    await buildOverlaySpec(s, scope, deps());

    const upper = path.join(stateDir, "sessions", s.id, "overlay-upper");
    const work = path.join(stateDir, "sessions", s.id, "overlay-work");
    // Simulate session work landing in the upper + scratch in the workdir.
    await fs.writeFile(path.join(upper, "keep.txt"), "session work");
    await fs.writeFile(path.join(work, "scratch.txt"), "stale");

    await buildOverlaySpec(s, scope, deps());
    expect(fsSync.existsSync(path.join(upper, "keep.txt"))).toBe(true); // upper preserved
    expect(fsSync.existsSync(path.join(work, "scratch.txt"))).toBe(false); // work reset
  });
});

describe("publishOverlayBaseAfterInstall", () => {
  let stateDir: string;
  const scope: OverlayScope = { repoUrl: "r", runtimeKey: "k" };

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "overlay-pub-"));
  });
  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("short-circuits (no snapshot pull) when HEAD isn't the default commit", async () => {
    const fetchSnapshot = vi.fn();
    const res = await publishOverlayBaseAfterInstall(session(), scope, {
      stateDir,
      workerUrl: "http://worker",
      isAncestor: async () => true,
      currentDefaultCommit: "deadbeef",
      fetchHeadCommit: async () => "0ffsetc0mmit", // diverged from default
      fetchSnapshot,
    });
    expect(res?.outcome).toBe("skipped-ineligible");
    expect(fetchSnapshot).not.toHaveBeenCalled();
  });

  it("short-circuits (no snapshot pull) when the base is already at this commit", async () => {
    const COMMIT = "cafef00dcafef00dcafef00dcafef00dcafef00d";
    // Seed a base at COMMIT via a first publish.
    const seed = vi.fn(async (_url: string, dest: string) => {
      await fs.mkdir(dest, { recursive: true });
      await fs.writeFile(path.join(dest, "marker"), "v0");
    });
    await publishOverlayBaseAfterInstall(session(), scope, {
      stateDir, workerUrl: "http://worker",
      isAncestor: async () => false,
      currentDefaultCommit: COMMIT,
      fetchHeadCommit: async () => COMMIT,
      fetchSnapshot: seed,
    });
    // Second call at the same commit must not pull a snapshot again.
    const fetchSnapshot = vi.fn();
    const res = await publishOverlayBaseAfterInstall(session(), scope, {
      stateDir, workerUrl: "http://worker",
      isAncestor: async () => false,
      currentDefaultCommit: COMMIT,
      fetchHeadCommit: async () => COMMIT,
      fetchSnapshot,
    });
    expect(res?.outcome).toBe("skipped-equal");
    expect(fetchSnapshot).not.toHaveBeenCalled();
  });

  it("returns null when HEAD can't be resolved", async () => {
    const res = await publishOverlayBaseAfterInstall(session(), scope, {
      stateDir,
      workerUrl: "http://worker",
      isAncestor: async () => true,
      currentDefaultCommit: "deadbeef",
      fetchHeadCommit: async () => null,
    });
    expect(res).toBeNull();
  });

  it("publishes a v0 base from the worker snapshot when source is the default tip", async () => {
    const COMMIT = "cafef00dcafef00dcafef00dcafef00dcafef00d";
    // The snapshot tar is written by the worker; stub it as a dir of files.
    const fetchSnapshot = vi.fn(async (_url: string, dest: string) => {
      await fs.mkdir(dest, { recursive: true });
      await fs.writeFile(path.join(dest, "node_modules-marker"), "deps");
    });

    const res = await publishOverlayBaseAfterInstall(session(), scope, {
      stateDir,
      workerUrl: "http://worker",
      isAncestor: async () => false,
      currentDefaultCommit: COMMIT,
      fetchHeadCommit: async () => COMMIT,
      fetchSnapshot,
    });

    expect(fetchSnapshot).toHaveBeenCalledOnce();
    expect(res?.outcome).toBe("created");
    const pointer = readBasePointer(stateDir, scope);
    expect(pointer?.commit).toBe(COMMIT);
    // The base contents were materialized from the snapshot.
    const hash = overlayScopeHash(scope.repoUrl, scope.runtimeKey);
    expect(fsSync.existsSync(path.join(overlayBaseDir(stateDir, hash), "node_modules-marker"))).toBe(true);
    // The temp snapshot dir was cleaned up.
    expect(fsSync.existsSync(path.join(stateDir, "overlay-snapshots", `${session().id}-${hash}`))).toBe(false);
  });

  it("cleans up the snapshot dir even when the fetch throws", async () => {
    const COMMIT = "cafef00dcafef00dcafef00dcafef00dcafef00d";
    const fetchSnapshot = vi.fn(async (_url: string, dest: string) => {
      await fs.mkdir(dest, { recursive: true });
      throw new Error("snapshot boom");
    });
    await expect(
      publishOverlayBaseAfterInstall(session(), scope, {
        stateDir,
        workerUrl: "http://worker",
        isAncestor: async () => false,
        currentDefaultCommit: COMMIT,
        fetchHeadCommit: async () => COMMIT,
        fetchSnapshot,
      }),
    ).rejects.toThrow("snapshot boom");
    const hash = overlayScopeHash(scope.repoUrl, scope.runtimeKey);
    expect(fsSync.existsSync(path.join(stateDir, "overlay-snapshots", `${session().id}-${hash}`))).toBe(false);
  });
});

describe("liveOverlayScopeHashes", () => {
  it("is empty when the feature is off", () => {
    expect(liveOverlayScopeHashes([session()], OFF).size).toBe(0);
  });

  it("includes non-evicted repo-backed non-ops sessions for the current runtime", () => {
    const rt = overlayRuntimeKey(ON);
    const sessions = [
      session({ id: "a", remoteUrl: "https://github.com/acme/one.git" }),
      session({ id: "b", remoteUrl: "https://github.com/acme/two.git" }),
      session({ id: "c", remoteUrl: "", }), // no remote → skipped
      session({ id: "d", remoteUrl: "https://github.com/acme/three.git", kind: "ops" }), // ops → skipped
      session({ id: "e", remoteUrl: "https://github.com/acme/four.git", diskTier: "evicted" }), // evicted → skipped
    ];
    const live = liveOverlayScopeHashes(sessions, ON);
    expect(live).toEqual(
      new Set([
        overlayScopeHash("https://github.com/acme/one.git", rt),
        overlayScopeHash("https://github.com/acme/two.git", rt),
      ]),
    );
  });
});
