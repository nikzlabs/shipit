/**
 * Restart agent must not kill a session's Compose services when nothing about
 * its dependencies changed.
 *
 * **The production incident (2026-09-03).** A session whose branch — and whose
 * `main` — had not touched a `package.json` or a lockfile for two days was
 * restarted. Container creation logged `base generation rotated`, force-removed
 * the two running service containers holding the session's overlay volumes
 * (exit 137), recreated the volumes, and reconciled the stack. The user's dev
 * server died for a base whose contents were byte-identical to the one it was
 * already on.
 *
 * The eviction chain is entirely keyed on the base **generation**, so this test
 * spans it end to end rather than at any single link:
 *
 *   `publishBase` (a code-only `main` commit)
 *     → the scope's pointer generation
 *     → `buildOverlaySpecs`' lowerdir/upperdir → `overlayDriverOpts`
 *     → `createOverlayVolume`, which force-removes every holder of a volume
 *       whose opts disagree (`releaseOverlayVolumeHolders`)
 *     → `applyOverlayDepDirs`, which reconciles the stack when holders were
 *       removed.
 *
 * Both directions are pinned: a code-only commit must traverse it without
 * removing a single container, and a real dependency change must still traverse
 * it exactly as before — a session left mounting a reaped upper layer is the
 * far worse failure (`createOverlayVolume`'s docstring).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Docker from "dockerode";

import { publishBase, readBasePointerByHash, type PublishCandidate } from "../overlay-base.js";
import { buildOverlaySpecs, type DepDirOverlaySpec } from "../overlay-session.js";
import { createOverlayVolume, overlayDriverOpts } from "../overlay-volume.js";

const SESSION_ID = "abcdef012345-0000-0000-0000-000000000000";
const SCOPE = {
  repoUrl: "https://github.com/nicolasalt/reward-tag.git",
  runtimeKey: "sha256:img|x64|glibc-2.39|node22",
};
const DEP_DIRS = ["game/node_modules", "tools/debug/node_modules"];
const WORKER_RUNTIME_KEY = "worker|x64|glibc-2.39|node22";
const INSTALL_COMMANDS = ["npm ci --prefix game", "npm ci --prefix tools/debug"];

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

/**
 * A dockerode stand-in with a real volume table and a real holder table, so the
 * removal that the incident is about is observable rather than stubbed: a
 * `createVolume` on a name that is taken returns the existing volume and ignores
 * the new driver opts, exactly as the daemon does.
 */
function makeFakeDocker() {
  const volumes = new Map<string, string>(); // name → `o=` driver opts
  /** volume name → container ids currently mounting it. */
  const holders = new Map<string, string[]>();
  const removedContainers: string[] = [];

  const docker = {
    listContainers: async (opts: { filters?: { volume?: string[] } }) => {
      const names = opts.filters?.volume ?? [];
      return names.flatMap((v) => (holders.get(v) ?? []).map((Id) => ({ Id, Names: [`/${Id}`] })));
    },
    getContainer: (id: string) => ({
      remove: async () => {
        removedContainers.push(id);
        for (const [vol, ids] of holders) {
          const left = ids.filter((i) => i !== id);
          if (left.length === 0) holders.delete(vol);
          else holders.set(vol, left);
        }
      },
    }),
    getVolume: (name: string) => ({
      inspect: async () => {
        const o = volumes.get(name);
        if (o === undefined) throw Object.assign(new Error("no such volume"), { statusCode: 404 });
        return { Options: { o } };
      },
      remove: async () => {
        if ((holders.get(name) ?? []).length > 0) {
          throw Object.assign(new Error("volume is in use"), { statusCode: 409 });
        }
        volumes.delete(name);
      },
    }),
    createVolume: async (cfg: { Name: string; DriverOpts?: Record<string, string> }) => {
      // The daemon's real behaviour: a taken name wins, opts are ignored.
      if (!volumes.has(cfg.Name)) volumes.set(cfg.Name, cfg.DriverOpts?.o ?? "");
    },
  };

  return { docker: docker as unknown as Docker, volumes, holders, removedContainers };
}

describe("restart agent × overlay base: services survive a code-only commit", () => {
  let tmpDir: string;
  let stateDir: string;
  let repoDir: string;
  let commitSeq: number;

  function commit(msg: string): string {
    commitSeq++;
    fs.writeFileSync(path.join(repoDir, `src-${commitSeq}.ts`), msg);
    git(repoDir, "add", "-A");
    git(repoDir, "commit", "-q", "-m", msg);
    return git(repoDir, "rev-parse", "HEAD");
  }

  function isAncestor(a: string, b: string): Promise<boolean> {
    try {
      execFileSync("git", ["-C", repoDir, "merge-base", "--is-ancestor", a, b], { stdio: "ignore" });
      return Promise.resolve(true);
    } catch {
      return Promise.resolve(false);
    }
  }

  /** A post-install snapshot for one dep dir. */
  function snapshot(tag: string): string {
    const dir = fs.mkdtempSync(path.join(tmpDir, "snap-"));
    fs.writeFileSync(path.join(dir, "installed.txt"), tag);
    return dir;
  }

  /** Publish every dep dir's base at `commit`, keyed by `depsHash`. */
  async function publishAll(commitSha: string, depsHash: string): Promise<string[]> {
    const outcomes: string[] = [];
    for (const depDir of DEP_DIRS) {
      const candidate: PublishCandidate = {
        commit: commitSha,
        exitCode: 0,
        preUserInstall: true,
        sourceIsDefaultBranch: true,
        snapshotDir: snapshot(`${depDir}@${depsHash}`),
        markerStamp: {
          runtimeKey: WORKER_RUNTIME_KEY,
          installCommands: INSTALL_COMMANDS,
          depsHash,
        },
      };
      const res = await publishBase({
        stateDir,
        scope: { ...SCOPE, depDir },
        candidate,
        isAncestor,
        currentDefaultCommit: commitSha,
      });
      outcomes.push(res.outcome);
    }
    return outcomes;
  }

  /** The specs an agent-container creation would build right now. */
  function specsNow(): DepDirOverlaySpec[] {
    return buildOverlaySpecs({
      sessionId: SESSION_ID,
      scope: SCOPE,
      depDirs: DEP_DIRS,
      volumeMountpoint: "/var/lib/docker/volumes/shipit-workspace/_data",
      generationForScope: (scopeHash) => readBasePointerByHash(stateDir, scopeHash)?.generation ?? 0,
    });
  }

  /**
   * The overlay half of an agent-container creation: create each spec's volume,
   * releasing (force-removing) any Compose sibling that holds one whose opts
   * disagree. Mirrors `container-lifecycle.ts`'s create loop.
   */
  async function createAgentContainerOverlays(
    docker: Docker,
    specs: DepDirOverlaySpec[],
  ): Promise<{ overlayVolumesRecreated: boolean }> {
    let overlayVolumesRecreated = false;
    for (const spec of specs) {
      const { releasedHolders } = await createOverlayVolume(docker, spec, {}, {
        releaseHolders: true,
        sessionId: SESSION_ID,
      });
      if (releasedHolders.length > 0) overlayVolumesRecreated = true;
    }
    return { overlayVolumesRecreated };
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ovl-restart-"));
    stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ovl-restart-repo-"));
    git(repoDir, "init", "-q", "-b", "main");
    git(repoDir, "config", "user.email", "test@ship-it.ai");
    git(repoDir, "config", "user.name", "test");
    commitSeq = 0;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("a strictly-newer code-only commit leaves every live Compose holder running", async () => {
    // 1. The session was created: its deps were published, and its agent +
    //    Compose containers were built over that generation.
    const deps = commit("add the game dependencies");
    expect(await publishAll(deps, "sha256:deps-A")).toEqual(["created", "created"]);

    const { docker, volumes, holders, removedContainers } = makeFakeDocker();
    const original = specsNow();
    await createAgentContainerOverlays(docker, original);

    // The session's `game` and `debug` services mount the same volumes.
    holders.set(original[0].volumeName, ["game-1"]);
    holders.set(original[1].volumeName, ["debug-1"]);
    const optsAtCreate = original.map((s) => volumes.get(s.volumeName));

    // 2. `main` advances by commits that touch no dependency input — the deps
    //    hash is unchanged, so a later session's publish is content-equal.
    const codeOnly = commit("swing animations that match the damage patterns");
    expect(await publishAll(codeOnly, "sha256:deps-A")).toEqual([
      "lineage-advanced",
      "lineage-advanced",
    ]);

    // 3. Restart agent: the replacement container re-derives its specs.
    const afterRestart = specsNow();
    expect(afterRestart.map((s) => s.generation)).toEqual(original.map((s) => s.generation));
    expect(afterRestart.map(overlayDriverOpts)).toEqual(original.map(overlayDriverOpts));

    const { overlayVolumesRecreated } = await createAgentContainerOverlays(docker, afterRestart);

    // Nothing was evicted, nothing was recreated, and the volumes still name the
    // generation the running services mounted.
    expect(removedContainers).toEqual([]);
    expect(holders.get(original[0].volumeName)).toEqual(["game-1"]);
    expect(holders.get(original[1].volumeName)).toEqual(["debug-1"]);
    expect(original.map((s) => volumes.get(s.volumeName))).toEqual(optsAtCreate);
    // …so `applyOverlayDepDirs` is never told to reconcile the stack.
    expect(overlayVolumesRecreated).toBe(false);
  });

  it("a real dependency change still evicts the holders and asks for a reconcile", async () => {
    const deps = commit("add the game dependencies");
    await publishAll(deps, "sha256:deps-A");

    const { docker, volumes, holders, removedContainers } = makeFakeDocker();
    const original = specsNow();
    await createAgentContainerOverlays(docker, original);
    holders.set(original[0].volumeName, ["game-1"]);
    holders.set(original[1].volumeName, ["debug-1"]);

    // A lockfile actually moved.
    const bump = commit("upgrade react");
    expect(await publishAll(bump, "sha256:deps-B")).toEqual(["advanced", "advanced"]);

    const afterRestart = specsNow();
    expect(afterRestart.map((s) => s.generation)).toEqual([2, 2]);

    const { overlayVolumesRecreated } = await createAgentContainerOverlays(docker, afterRestart);

    // The siblings are holding a lowerdir that is no longer the session's, so
    // they are removed and the volumes recreated over the new generation.
    expect(removedContainers.sort()).toEqual(["debug-1", "game-1"]);
    expect(overlayVolumesRecreated).toBe(true);
    expect(afterRestart.map((s) => volumes.get(s.volumeName))).toEqual(
      afterRestart.map(overlayDriverOpts),
    );
  });
});
