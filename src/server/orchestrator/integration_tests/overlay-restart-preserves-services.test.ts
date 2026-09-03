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
 *   `publishDepDirOverlayBases` (a code-only `main` commit)
 *     → `computeInstallDepsHash` + `hasInstallLifecycleScript` over the REAL
 *       workspace and its `shipit.yaml`
 *     → `publishBase` → the scope's pointer generation
 *     → `buildOverlaySpecs`' lowerdir/upperdir → `overlayDriverOpts`
 *     → `createOverlayVolume`, which force-removes every holder of a volume
 *       whose opts disagree (`releaseOverlayVolumeHolders`)
 *     → `applyOverlayDepDirs`, which is what tells the compose stack to
 *       reconcile.
 *
 * Nothing about the content key is hand-fed: the workspace carries the incident
 * repo's shape (two sub-package manifests + lockfiles, `npm ci --prefix …`
 * commands the allowlist alone rejects, and the `agent.install-inputs` that is
 * why it is content-keyable anyway), so the test fails if the production
 * resolvers stop classifying it the way the incident did.
 *
 * Both directions are pinned: a code-only commit must traverse the chain without
 * removing a single container, and a real dependency change must still traverse
 * it exactly as before — a session left mounting a reaped upper layer is the far
 * worse failure (`createOverlayVolume`'s docstring).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type Docker from "dockerode";

import { computeInstallDepsHash, hasInstallLifecycleScript } from "../../shared/deps-hash.js";
import { readBasePointerByHash } from "../overlay-base.js";
import {
  publishDepDirOverlayBases,
  type AncestryOracle,
  type DepDirPublishOutcome,
} from "../overlay-publish.js";
import { buildOverlaySpecs, overlayRuntimeKey, type DepDirOverlaySpec } from "../overlay-session.js";
import { applyOverlayDepDirs } from "../service-manager-setup.js";
import { ContainerSessionRunner } from "../container-session-runner.js";
import { createOverlayVolume, overlayDriverOpts } from "../overlay-volume.js";
import type { ServiceManager } from "../service-manager.js";
import type { SessionContainerManager } from "../session-container.js";
import type { SessionInfo, LogSource } from "../../shared/types.js";

const SESSION_ID = "abcdef012345-0000-0000-0000-000000000000";
const REPO_URL = "https://github.com/nicolasalt/reward-tag.git";
const DEP_DIRS = ["game/node_modules", "tools/debug/node_modules"];
const WORKER_RUNTIME_KEY = "worker|x64|glibc-2.39|node22";
/** The incident repo's commands — rejected by the allowlist on their own (`--prefix` leaves a positional). */
const INSTALL_COMMANDS = ["npm ci --prefix game", "npm ci --prefix tools/debug"];
/** …which is why it declares its inputs. This is what makes the content key non-null. */
const INSTALL_INPUTS = [
  "game/package.json",
  "game/package-lock.json",
  "tools/debug/package.json",
  "tools/debug/package-lock.json",
];

const SESSION = {
  remoteUrl: REPO_URL,
  kind: "repo",
  workspaceDir: "",
} as unknown as SessionInfo;

/**
 * A dockerode stand-in with a real volume table and a real holder table, so the
 * removal the incident is about is observable rather than stubbed: `createVolume`
 * on a name that is taken returns the existing volume and ignores the new driver
 * opts, exactly as the daemon does.
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

/** A runner that satisfies `instanceof ContainerSessionRunner` without a container behind it. */
function makeRunner(): ContainerSessionRunner {
  const runner = Object.create(ContainerSessionRunner.prototype) as Record<string, unknown>;
  runner.sessionId = SESSION_ID;
  runner.whenWorkerReady = () => Promise.resolve();
  Object.defineProperty(runner, "disposed", { value: false, configurable: true });
  return runner as unknown as ContainerSessionRunner;
}

describe("restart agent × overlay base: services survive a code-only commit", () => {
  let tmpDir: string;
  let stateDir: string;
  let workspaceDir: string;
  let env: NodeJS.ProcessEnv;
  let runtimeKey: string;
  let head: string;
  let commitSeq: number;

  function git(...args: string[]): string {
    return execFileSync("git", ["-C", workspaceDir, ...args], { encoding: "utf8" }).trim();
  }

  /** Commit the current tree and make it the new default-branch HEAD. */
  function commit(msg: string): string {
    git("add", "-A");
    git("commit", "-q", "-m", msg);
    head = git("rev-parse", "HEAD");
    return head;
  }

  /** The publish path's git oracle: HEAD is the default branch, and history only moves forward. */
  const oracle: AncestryOracle = {
    isAncestor: (a, b) => Promise.resolve(a !== b),
    resolveDefaultBranchCommit: () => Promise.resolve(head),
  };

  /**
   * Run the real post-install publish for every dep dir. The worker pull is
   * injected (there is no container), but the content key, the lifecycle-script
   * rule, the eligibility gates and the CAS are all production code.
   */
  async function publishAll(
    /** The commands the install actually ran — must match the workspace's `shipit.yaml`. */
    installCommands: string[] = INSTALL_COMMANDS,
  ): Promise<DepDirPublishOutcome[]> {
    return publishDepDirOverlayBases(
      {
        session: { ...SESSION, workspaceDir },
        workerUrl: "http://worker",
        installOk: true,
        installCommands,
      },
      {
        stateDir,
        createRepoGit: () => oracle,
        getBareCacheDir: (url) => path.join(tmpDir, "cache", encodeURIComponent(url)),
        env,
        fetchHeadInfo: () => Promise.resolve({ commit: head, runtimeKey: WORKER_RUNTIME_KEY }),
        // The snapshot's bytes are the installed tree; they track the lockfile so
        // a real dependency change genuinely produces different base contents.
        fetchSnapshot: (_url, depDir) =>
          Promise.resolve(Readable.from([Buffer.from(`${depDir}@${lockfileTag}`)])),
        extract: async (stream, destDir) => {
          const chunks: Buffer[] = [];
          for await (const c of stream) chunks.push(Buffer.from(c));
          fs.writeFileSync(path.join(destDir, "installed"), Buffer.concat(chunks));
        },
        tmpRoot: tmpDir,
      },
    );
  }

  let lockfileTag: string;

  /** Rewrite both lockfiles — a real dependency change. */
  function bumpLockfiles(tag: string): void {
    lockfileTag = tag;
    for (const pkg of ["game", "tools/debug"]) {
      fs.writeFileSync(
        path.join(workspaceDir, pkg, "package-lock.json"),
        JSON.stringify({ lockfileVersion: 3, tag }),
      );
    }
  }

  /** The specs an agent-container creation would build right now. */
  function specsNow(): DepDirOverlaySpec[] {
    return buildOverlaySpecs({
      sessionId: SESSION_ID,
      scope: { repoUrl: REPO_URL, runtimeKey },
      depDirs: DEP_DIRS,
      volumeMountpoint: "/var/lib/docker/volumes/shipit-workspace/_data",
      generationForScope: (scopeHash) => readBasePointerByHash(stateDir, scopeHash)?.generation ?? 0,
    });
  }

  /**
   * The overlay half of an agent-container creation, then the compose-side
   * decision that consumes it — `container-lifecycle.ts`'s create loop feeding
   * `SessionContainer.overlayVolumesRecreated`, which `applyOverlayDepDirs`
   * reads. Returns whether the stack was told to reconcile.
   */
  async function restartAgent(docker: Docker, specs: DepDirOverlaySpec[]): Promise<boolean> {
    let overlayVolumesRecreated = false;
    for (const spec of specs) {
      const { releasedHolders } = await createOverlayVolume(docker, spec, {}, {
        releaseHolders: true,
        sessionId: SESSION_ID,
      });
      if (releasedHolders.length > 0) overlayVolumesRecreated = true;
    }

    // The compose side. `setOverlayDepDirs` returns false (the dep-dir SET never
    // changes on a rotation — the volume name is keyed on session + dep dir), so
    // the recreated flag is the ONLY thing that can ask for a reconcile here.
    const logs: string[] = [];
    const mgr = {
      setOverlayDepDirs: () => false,
    } as unknown as ServiceManager;
    const containerManager = {
      provisionedOverlayDepDirs: () =>
        specs.map((s) => ({ depDir: s.depDir, volumeName: s.volumeName })),
      dockerClient: docker,
      prepareOverlaySpecs: async () => specs,
      consumeOverlayVolumesRecreated: () => {
        const was = overlayVolumesRecreated;
        overlayVolumesRecreated = false;
        return was;
      },
    } as unknown as SessionContainerManager;

    return applyOverlayDepDirs(makeRunner(), mgr, {
      containerManager,
      session: { ...SESSION, workspaceDir },
      workspaceDir,
      broadcastLog: (_id: string, _src: LogSource, text: string) => logs.push(text),
    });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ovl-restart-"));
    stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    env = { OVERLAY_DEP_STORE: "1", SESSION_WORKER_IMAGE_ID: "img1" } as NodeJS.ProcessEnv;
    runtimeKey = overlayRuntimeKey(env);

    // The incident repo's shape: two sub-packages, their dep dirs git-ignored,
    // and a shipit.yaml declaring both the dep dirs and the install inputs.
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "ovl-restart-ws-"));
    execFileSync("git", ["-C", workspaceDir, "init", "-q", "-b", "main"]);
    execFileSync("git", ["-C", workspaceDir, "config", "user.email", "test@ship-it.ai"]);
    execFileSync("git", ["-C", workspaceDir, "config", "user.name", "test"]);
    fs.writeFileSync(path.join(workspaceDir, ".gitignore"), `${DEP_DIRS.map((d) => `${d}/`).join("\n")}\n`);
    fs.writeFileSync(
      path.join(workspaceDir, "shipit.yaml"),
      [
        "agent:",
        "  dep-dirs:",
        ...DEP_DIRS.map((d) => `    - ${d}`),
        "  install:",
        ...INSTALL_COMMANDS.map((c) => `    - ${c}`),
        "  install-inputs:",
        ...INSTALL_INPUTS.map((f) => `    - ${f}`),
        "",
      ].join("\n"),
    );
    for (const pkg of ["game", "tools/debug"]) {
      fs.mkdirSync(path.join(workspaceDir, pkg), { recursive: true });
      fs.writeFileSync(path.join(workspaceDir, pkg, "package.json"), JSON.stringify({ name: pkg }));
    }
    for (const d of DEP_DIRS) fs.mkdirSync(path.join(workspaceDir, d), { recursive: true });
    bumpLockfiles("v1");
    commitSeq = 0;
    commit("initial");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  /** A commit that touches no dependency input — the incident's "swing animations" commit. */
  function codeOnlyCommit(msg: string): string {
    commitSeq++;
    fs.writeFileSync(path.join(workspaceDir, "game", `anim-${commitSeq}.ts`), msg);
    return commit(msg);
  }

  it("the incident repo's install really is content-keyable through the production resolvers", async () => {
    // The premise the rest of this file rests on: `npm ci --prefix …` is rejected
    // by the command allowlist, so the ONLY reason this repo has a content key is
    // its declared `install-inputs`. If that stopped being honoured, the fix
    // would silently not apply to the very session it was written for.
    const out = await publishAll();
    expect(out.map((o) => o.outcome)).toEqual(["created", "created"]);
    for (const spec of specsNow()) {
      const marker = readBasePointerByHash(stateDir, spec.scopeHash)?.marker;
      expect(marker?.installCommands).toEqual(INSTALL_COMMANDS);
      expect(typeof marker?.depsHash).toBe("string");
    }
  });

  it("a strictly-newer code-only commit leaves every live Compose holder running", async () => {
    // 1. The session was created: its deps were published, and its agent +
    //    Compose containers were built over that generation.
    await publishAll();

    const { docker, volumes, holders, removedContainers } = makeFakeDocker();
    const original = specsNow();
    await restartAgent(docker, original);

    // The session's `game` and `debug` services mount the same volumes.
    holders.set(original[0].volumeName, ["game-1"]);
    holders.set(original[1].volumeName, ["debug-1"]);
    const optsAtCreate = original.map((s) => volumes.get(s.volumeName));

    // 2. `main` advances by commits that touch no dependency input.
    codeOnlyCommit("swing animations that match the damage patterns");
    expect((await publishAll()).map((o) => o.outcome)).toEqual([
      "lineage-advanced",
      "lineage-advanced",
    ]);

    // 3. Restart agent: the replacement container re-derives its specs.
    const afterRestart = specsNow();
    expect(afterRestart.map((s) => s.generation)).toEqual(original.map((s) => s.generation));
    expect(afterRestart.map(overlayDriverOpts)).toEqual(original.map(overlayDriverOpts));

    const reconcileRequested = await restartAgent(docker, afterRestart);

    // Nothing was evicted, and the volumes still name the generation the running
    // services mounted.
    expect(removedContainers).toEqual([]);
    expect(holders.get(original[0].volumeName)).toEqual(["game-1"]);
    expect(holders.get(original[1].volumeName)).toEqual(["debug-1"]);
    expect(original.map((s) => volumes.get(s.volumeName))).toEqual(optsAtCreate);
    // …so the compose stack is never told to reconcile — the decision the
    // production path actually makes, not a stand-in for it.
    expect(reconcileRequested).toBe(false);
  });

  it("a real dependency change still evicts the holders and asks for a reconcile", async () => {
    await publishAll();

    const { docker, volumes, holders, removedContainers } = makeFakeDocker();
    const original = specsNow();
    await restartAgent(docker, original);
    holders.set(original[0].volumeName, ["game-1"]);
    holders.set(original[1].volumeName, ["debug-1"]);

    // A lockfile actually moved.
    bumpLockfiles("v2");
    commit("upgrade react");
    expect((await publishAll()).map((o) => o.outcome)).toEqual(["advanced", "advanced"]);

    const afterRestart = specsNow();
    expect(afterRestart.map((s) => s.generation)).toEqual([2, 2]);

    const reconcileRequested = await restartAgent(docker, afterRestart);

    // The siblings are holding a lowerdir that is no longer the session's, so
    // they are removed, the volumes recreated over the new generation, and the
    // stack reconciled to bring the services back.
    expect(removedContainers.sort()).toEqual(["debug-1", "game-1"]);
    expect(reconcileRequested).toBe(true);
    expect(afterRestart.map((s) => volumes.get(s.volumeName))).toEqual(
      afterRestart.map(overlayDriverOpts),
    );
  });

  it("a lifecycle script disables the no-rotation path, so those services still get evicted", async () => {
    // `npm ci` runs the repo's own `postinstall`, whose output the hashed inputs
    // do not describe — a `patch-package`-style script writes straight into the
    // dep dir the base holds. Such a repo keeps rotating, holders and all.
    fs.writeFileSync(
      path.join(workspaceDir, "package.json"),
      JSON.stringify({ name: "root", scripts: { postinstall: "node scripts/build.js" } }),
    );
    // Drop the declared inputs: an explicit `install-inputs` is the author
    // vouching for the key, and it would override the lifecycle rule.
    fs.writeFileSync(
      path.join(workspaceDir, "shipit.yaml"),
      [
        "agent:",
        "  dep-dirs:",
        ...DEP_DIRS.map((d) => `    - ${d}`),
        "  install:",
        "    - npm ci",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(workspaceDir, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3 }),
    );
    commit("add a postinstall build step");

    // The lifecycle rule must be the ONLY thing declining this publish, so pin
    // that everything else about it qualifies: a bare `npm ci` IS on the command
    // allowlist and this workspace's root manifest + lockfile DO hash. Without
    // this the test would pass on a `null` content key and could never fail on
    // the rule it is named for.
    expect(computeInstallDepsHash(workspaceDir, ["npm ci"], null)).toEqual(expect.any(String));
    expect(hasInstallLifecycleScript(workspaceDir)).toBe(true);

    await publishAll(["npm ci"]);

    const { docker, holders, removedContainers } = makeFakeDocker();
    const original = specsNow();
    await restartAgent(docker, original);
    holders.set(original[0].volumeName, ["game-1"]);
    holders.set(original[1].volumeName, ["debug-1"]);

    codeOnlyCommit("change what the postinstall builds");
    expect((await publishAll(["npm ci"])).map((o) => o.outcome)).toEqual(["advanced", "advanced"]);

    const reconcileRequested = await restartAgent(docker, specsNow());
    expect(removedContainers.sort()).toEqual(["debug-1", "game-1"]);
    expect(reconcileRequested).toBe(true);
  });
});
