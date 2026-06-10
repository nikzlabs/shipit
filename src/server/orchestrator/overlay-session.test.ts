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

import {
  buildOverlaySpecs,
  depDirsForSession,
  isOverlayEligible,
  isOverlayEnabled,
  liveOverlayScopeHashes,
  overlayRuntimeKey,
  resolveOverlayScope,
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
    expect(nm.lowerdir).toBe(`${MP}/overlay-base/${hash}`);
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
