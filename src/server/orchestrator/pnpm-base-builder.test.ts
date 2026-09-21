import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Docker from "dockerode";

import {
  BUILD_PROJECT_DIR,
  BUILD_REGISTRY_DIR,
  BUILD_REGISTRY_URL,
  BUILD_STORE_DIR,
  BUILDER_PNPM_BIN,
  buildVerifiedPnpmBase,
  builderEnv,
  builderScript,
  MAX_CONCURRENT_PNPM_BASE_BUILDS,
  PNPM_BUILDER_LABEL,
  PNPM_BUILDER_RUN_LABEL,
  pnpmBuildRootDir,
  reapOrphanPnpmBaseBuilds,
  type PnpmBaseBuilderDeps,
} from "./pnpm-base-builder.js";
import { CONTAINER_WORKSPACE_PATH, PNPM_VERIFIED_NAMESPACE } from "./overlay-session.js";
import { PNPM_STORE_CONTAINER_PATH } from "./container-lifecycle.js";
import { sha512Integrity, type FetchLike } from "./pnpm-base-registry.js";
import { makeNpmTarball } from "./pnpm-tarball-test-helpers.js";
import type { OverlayScope, PublishBaseArgs, PublishResult } from "./overlay-base.js";

const SCOPE: OverlayScope = {
  repoUrl: "https://github.com/acme/widgets.git",
  runtimeKey: "sha256:img|x64",
  depDir: "node_modules",
  namespace: PNPM_VERIFIED_NAMESPACE,
};

const LOCK = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      left-pad:
        specifier: 1.3.0
        version: 1.3.0

packages:

  left-pad@1.3.0:
    resolution: {integrity: INTEGRITY}
`;

/** A real published tarball: staging reads each one for an install-time build (planning#604). */
const TARBALL = makeNpmTarball({ manifest: { name: "left-pad", version: "1.3.0" } });
const BUILD_BEARING_TARBALL = makeNpmTarball({
  manifest: { name: "left-pad", version: "1.3.0", scripts: { postinstall: "node-gyp rebuild" } },
});

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

function makeRepo(files: Record<string, string>): { dir: string; commit: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-bld-repo-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@ship-it.ai");
  git(dir, "config", "user.name", "test");
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  git(dir, "add", "-A", "-f");
  git(dir, "commit", "-q", "-m", "seed");
  return { dir, commit: git(dir, "rev-parse", "HEAD") };
}

function repoFor(tarball: Buffer = TARBALL): { dir: string; commit: string } {
  return makeRepo({
    "package.json": JSON.stringify({ name: "app", dependencies: { "left-pad": "1.3.0" } }),
    "pnpm-lock.yaml": LOCK.replace("INTEGRITY", sha512Integrity(tarball)),
  });
}

function eligibleRepo(): { dir: string; commit: string } {
  return repoFor();
}

function fetchFor(tarball: Buffer): FetchLike {
  return (url) => {
    if (url.endsWith(".tgz")) {
      return Promise.resolve(new Response(new Uint8Array(tarball), { status: 200 }));
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          name: "left-pad",
          versions: {
            "1.3.0": {
              dist: {
                integrity: sha512Integrity(tarball),
                tarball: "https://registry.example.test/left-pad/-/left-pad-1.3.0.tgz",
              },
            },
          },
        }),
        { status: 200 },
      ),
    );
  };
}

const okFetch: FetchLike = fetchFor(TARBALL);

/**
 * What the real container leaves behind: pnpm's tree and the `.modules.yaml` it writes beside
 * it. `pendingBuilds` is pnpm's own record of packages that still have to build, which the
 * builder now reads before publishing.
 */
function writeBuiltTree(cfg: Docker.ContainerCreateOptions, pendingBuilds: string[] = []): void {
  const mount = (cfg.HostConfig?.Mounts ?? []).find(
    (m) => (m as { Target?: string }).Target === BUILD_PROJECT_DIR,
  ) as { Source?: string } | undefined;
  const modules = path.join(mount?.Source ?? "", "node_modules");
  fs.mkdirSync(path.join(modules, "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(modules, ".modules.yaml"), JSON.stringify({ pendingBuilds }));
}

/** A Docker stub that records what it was asked to run and pretends the build succeeded. */
function fakeDocker(opts: { exitCode?: number; onRun?: (cfg: Docker.ContainerCreateOptions) => void } = {}): {
  docker: Docker;
  created: Docker.ContainerCreateOptions[];
  removed: number;
} {
  const created: Docker.ContainerCreateOptions[] = [];
  let removed = 0;
  const docker = {
    createContainer: (cfg: Docker.ContainerCreateOptions) => {
      created.push(cfg);
      opts.onRun?.(cfg);
      return Promise.resolve({
        id: "builder-1",
        start: () => Promise.resolve(),
        wait: () => Promise.resolve({ StatusCode: opts.exitCode ?? 0 }),
        logs: () => Promise.resolve(Buffer.from("build log")),
        remove: () => {
          removed++;
          return Promise.resolve();
        },
      });
    },
  } as unknown as Docker;
  return {
    docker,
    created,
    get removed() {
      return removed;
    },
  };
}

describe("builderScript", () => {
  it("fetches through the loopback registry and then builds with none reachable", () => {
    const script = builderScript();
    expect(script).toContain(
      `fetch --ignore-scripts --ignore-pnpmfile --registry ${BUILD_REGISTRY_URL}`,
    );
    expect(script).toContain(
      "install --offline --frozen-lockfile --ignore-scripts --ignore-pnpmfile --registry http://127.0.0.1:1/",
    );
    // The published tree must be the offline install's output, not the fetch phase's.
    const wipe = script.indexOf("rm -rf node_modules");
    expect(wipe).toBeGreaterThan(script.indexOf("fetch --ignore-scripts"));
    expect(wipe).toBeLessThan(script.indexOf("install --offline"));
  });

  it("suppresses hooks on BOTH phases, not only the one that publishes", () => {
    // A hook is not a script, so `--ignore-scripts` does not stop it, and a hook that runs in
    // the fetch phase can rewrite what the offline phase then builds from — or the binary it
    // builds with.
    const phases = builderScript().split("\n").filter((l) => l.includes(BUILDER_PNPM_BIN));
    expect(phases).toHaveLength(2);
    expect(phases.every((l) => l.includes("--ignore-pnpmfile"))).toBe(true);
    expect(phases.every((l) => l.includes("--ignore-scripts"))).toBe(true);
  });

  it("runs the pinned pnpm by path, never a corepack shim a repo could redirect", () => {
    expect(builderScript()).toContain(`"${BUILDER_PNPM_BIN}"`);
  });

  it("builds at the paths the consuming SESSION uses, not paths of its own", () => {
    // pnpm records `storeDir` in `.modules.yaml` and the publish preserves it, so a base built
    // anywhere else reads to the consumer as a store mismatch (FINDINGS.md).
    expect(BUILD_PROJECT_DIR).toBe(CONTAINER_WORKSPACE_PATH);
    expect(BUILD_STORE_DIR).toBe(PNPM_STORE_CONTAINER_PATH);
    expect(builderScript()).toContain(`--store-dir "${PNPM_STORE_CONTAINER_PATH}"`);
  });
});

describe("builderEnv", () => {
  it("states the whole configuration rather than inheriting one", () => {
    const env = builderEnv();
    // Both halves are needed: bypassing corepack's shim still leaves pnpm's own
    // `packageManager` switching, measured 2026-09-21 to downgrade the pinned binary.
    expect(env).toContain("PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS=false");
    expect(env).toContain("COREPACK_ENABLE_PROJECT_SPEC=0");
    expect(env).toContain("npm_config_userconfig=/dev/null");
    expect(env).toContain("npm_config_globalconfig=/dev/null");
    expect(env.some((e) => e.startsWith("HOME=/build/"))).toBe(true);
  });
});

describe("buildVerifiedPnpmBase", () => {
  let stateDir: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-bld-state-"));
    cleanup.push(stateDir);
  });
  afterEach(() => {
    for (const d of cleanup.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function deps(
    docker: Docker,
    overrides: Partial<PnpmBaseBuilderDeps> = {},
  ): PnpmBaseBuilderDeps {
    return {
      docker,
      image: "shipit-session-worker:test",
      stateDir,
      registryUrl: "https://registry.example.test/",
      fetchImpl: okFetch,
      ...overrides,
    };
  }

  const request = (repo: { dir: string; commit: string }): Parameters<typeof buildVerifiedPnpmBase>[1] => ({
    repoDir: repo.dir,
    defaultBranchCommit: repo.commit,
    scope: SCOPE,
    isAncestor: () => Promise.resolve(false),
  });

  it("publishes the built tree into the verified scope", async () => {
    const repo = eligibleRepo();
    cleanup.push(repo.dir);
    const seen: PublishBaseArgs[] = [];
    const publish = (args: PublishBaseArgs): Promise<PublishResult> => {
      seen.push(args);
      // The real publisher copies the tree; here only its inputs are under test.
      return Promise.resolve({
        outcome: "created",
        pointer: {
          scopeHash: "h",
          commit: args.candidate.commit,
          depth: 1,
          generation: 1,
          baseDir: "/base",
          updatedAt: "now",
        },
      });
    };
    const fake = fakeDocker({
      onRun: writeBuiltTree,
    });

    const result = await buildVerifiedPnpmBase(deps(fake.docker, { publish }), request(repo));

    expect(result).toEqual({ status: "published", outcome: "created", generation: 1 });
    expect(seen).toHaveLength(1);
    expect(seen[0].scope).toEqual(SCOPE);
    // Both flags are true BY CONSTRUCTION: the orchestrator built this tree from committed
    // inputs, unlike the snapshot publisher which asserts them about a session's tree.
    expect(seen[0].candidate.preUserInstall).toBe(true);
    expect(seen[0].candidate.sourceIsDefaultBranch).toBe(true);
  });

  it("gives an ineligible repo no base and never reaches the registry", async () => {
    const repo = makeRepo({ "package.json": "{}" });
    cleanup.push(repo.dir);
    let fetched = 0;
    const fake = fakeDocker();
    const result = await buildVerifiedPnpmBase(
      deps(fake.docker, {
        fetchImpl: ((url: string) => {
          fetched++;
          return okFetch(url);
        }) as FetchLike,
      }),
      request(repo),
    );
    expect(result).toMatchObject({ status: "ineligible" });
    expect(fetched).toBe(0);
    expect(fake.created).toHaveLength(0);
  });

  it("gives a repo whose dependency builds at install time no base, and no builder run", async () => {
    // planning#604: the builder runs `--ignore-scripts`, and the session's own install over the
    // resulting base reports nothing pending, so the approved build runs nowhere.
    const repo = repoFor(BUILD_BEARING_TARBALL);
    cleanup.push(repo.dir);
    let published = 0;
    const fake = fakeDocker();
    const result = await buildVerifiedPnpmBase(
      deps(fake.docker, {
        fetchImpl: fetchFor(BUILD_BEARING_TARBALL),
        publish: () => {
          published++;
          return Promise.resolve({ outcome: "created", pointer: null });
        },
      }),
      request(repo),
    );
    expect(result).toMatchObject({
      status: "ineligible",
      reason: { code: "install-script" },
    });
    expect(result.status === "ineligible" ? result.detail : "").toContain("left-pad@1.3.0");
    expect(published).toBe(0);
    expect(fake.created).toHaveLength(0);
  });

  it("skips the publish naming the first failing package when verification fails", async () => {
    const repo = eligibleRepo();
    cleanup.push(repo.dir);
    let published = 0;
    const swapped: FetchLike = (url) =>
      url.endsWith(".tgz")
        ? Promise.resolve(new Response(new Uint8Array(Buffer.from("other bytes")), { status: 200 }))
        : okFetch(url);
    const fake = fakeDocker();
    const result = await buildVerifiedPnpmBase(
      deps(fake.docker, {
        fetchImpl: swapped,
        publish: () => {
          published++;
          return Promise.resolve({ outcome: "created", pointer: null });
        },
      }),
      request(repo),
    );
    expect(result).toMatchObject({ status: "verification-failed", failedPackage: "left-pad@1.3.0" });
    expect(published).toBe(0);
    expect(fake.created).toHaveLength(0);
  });

  it.each([
    [
      "a package pnpm still has to build",
      ["left-pad@1.3.0(patch_hash=abc)"],
      "left-pad@1.3.0(patch_hash=abc)",
    ],
    ["a tree that cannot say whether anything is pending", null, "nothing left to build"],
  ])("publishes no base for %s", async (_name, pendingBuilds, expected) => {
    // The install-time-build refusal is taken over the staged TARBALLS, and a committed patch is
    // content those do not carry: measured 2026-09-21, a patch adding a `postinstall` leaves the
    // offline `--ignore-scripts` install at rc=0 with the package unbuilt and named here. A base
    // carrying one hands the consuming session a build it cannot run (planning#604).
    const repo = eligibleRepo();
    cleanup.push(repo.dir);
    let published = 0;
    const fake = fakeDocker({
      onRun: (cfg) => {
        if (pendingBuilds === null) {
          const mount = (cfg.HostConfig?.Mounts ?? []).find(
            (m) => (m as { Target?: string }).Target === BUILD_PROJECT_DIR,
          ) as { Source?: string } | undefined;
          fs.mkdirSync(path.join(mount?.Source ?? "", "node_modules", "left-pad"), {
            recursive: true,
          });
        } else writeBuiltTree(cfg, pendingBuilds);
      },
    });
    const result = await buildVerifiedPnpmBase(
      deps(fake.docker, {
        publish: () => {
          published++;
          return Promise.resolve({ outcome: "created", pointer: null });
        },
      }),
      request(repo),
    );
    expect(result).toMatchObject({ status: "build-failed" });
    expect((result as { detail: string }).detail).toContain(expected);
    expect(published).toBe(0);
  });

  it("publishes a base for a repo whose OWN lifecycle script is deferred", async () => {
    // pnpm defers the PROJECT's scripts into `pendingBuilds` too, as bare importer ids —
    // measured 2026-09-21, a repo with scriptless dependencies and a root `postinstall`
    // records `["."]`. Those are the session's to run (plan.md section 5), so counting them
    // would take a base off a repo that is eligible today.
    const repo = eligibleRepo();
    cleanup.push(repo.dir);
    const fake = fakeDocker({ onRun: (cfg) => writeBuiltTree(cfg, ["."]) });
    const result = await buildVerifiedPnpmBase(
      deps(fake.docker, {
        publish: () => Promise.resolve({ outcome: "created", pointer: null }),
      }),
      request(repo),
    );
    expect(result).toMatchObject({ status: "published" });
  });

  it("reports a failed build and publishes nothing", async () => {
    const repo = eligibleRepo();
    cleanup.push(repo.dir);
    let published = 0;
    const fake = fakeDocker({ exitCode: 1 });
    const result = await buildVerifiedPnpmBase(
      deps(fake.docker, {
        publish: () => {
          published++;
          return Promise.resolve({ outcome: "created", pointer: null });
        },
      }),
      request(repo),
    );
    expect(result).toMatchObject({ status: "build-failed" });
    expect(published).toBe(0);
  });

  it("runs the builder with no network and drops the build root afterwards", async () => {
    const repo = eligibleRepo();
    cleanup.push(repo.dir);
    const fake = fakeDocker({
      onRun: writeBuiltTree,
    });
    await buildVerifiedPnpmBase(
      deps(fake.docker, {
        publish: () => Promise.resolve({ outcome: "created", pointer: null }),
      }),
      request(repo),
    );
    expect(fake.created[0].HostConfig?.NetworkMode).toBe("none");
    expect(fake.created[0].HostConfig?.CapDrop).toEqual(["ALL"]);
    expect(fake.created[0].HostConfig?.Memory).toBeGreaterThan(0);
    // The verified tarballs are the one input nothing in the container may edit.
    const registryMount = (fake.created[0].HostConfig?.Mounts ?? []).find(
      (m) => (m as { Target?: string }).Target === BUILD_REGISTRY_DIR,
    ) as { ReadOnly?: boolean } | undefined;
    expect(registryMount?.ReadOnly).toBe(true);
    expect(
      (fake.created[0].HostConfig?.Mounts ?? []).map((m) => (m as { Target?: string }).Target),
    ).toContain(BUILD_STORE_DIR);
    // Each run gets its own directory under the scope, and takes it with it when it ends.
    const runDir = path.dirname(pnpmBuildRootDir(stateDir, "any"));
    const scopeDirs = fs.readdirSync(runDir);
    expect(scopeDirs).toHaveLength(1);
    expect(fs.readdirSync(path.join(runDir, scopeDirs[0]))).toEqual([]);
  });

  /** Holds a build open at the publish so a rival trigger can be measured against it. */
  function heldBuild(): {
    publish: NonNullable<PnpmBaseBuilderDeps["publish"]>;
    entered: () => number;
    release: () => void;
  } {
    let entered = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    return {
      publish: async (): Promise<PublishResult> => {
        entered++;
        await gate;
        return { outcome: "created", pointer: null };
      },
      entered: () => entered,
      release,
    };
  }

  function treeWritingDocker() {
    return fakeDocker({
      onRun: writeBuiltTree,
    });
  }

  it("turns a second trigger for the same scope away instead of building in parallel", async () => {
    const repo = eligibleRepo();
    cleanup.push(repo.dir);
    const held = heldBuild();
    const fake = treeWritingDocker();

    const first = buildVerifiedPnpmBase(deps(fake.docker, { publish: held.publish }), request(repo));
    await vi.waitFor(() => expect(held.entered()).toBe(1));

    const second = await buildVerifiedPnpmBase(
      deps(fake.docker, { publish: held.publish }),
      request(repo),
    );
    expect(second).toEqual({
      status: "skipped-building",
      detail: "a build of this base is already running",
    });
    // The point is the container, not the outcome string: a second build of the same scope would
    // materialize a rival tree into the same generation.
    expect(fake.created).toHaveLength(1);

    held.release();
    expect(await first).toMatchObject({ status: "published" });

    // The scope is free again once the build ends, so the next commit is not locked out.
    const third = await buildVerifiedPnpmBase(
      deps(fake.docker, { publish: () => Promise.resolve({ outcome: "created", pointer: null }) }),
      request(repo),
    );
    expect(third).toMatchObject({ status: "published" });
  });

  it("releases the scope's build slot when STAGING fails, not only when the build does", async () => {
    const repo = eligibleRepo();
    cleanup.push(repo.dir);
    const fake = treeWritingDocker();
    // A work dir that cannot be created — the ENOSPC / permission shape. It happens before the
    // build's own try/finally used to open, so the slot leaked for the process's whole life.
    const blocked = path.join(stateDir, "blocked");
    fs.writeFileSync(blocked, "not a directory");

    await expect(
      buildVerifiedPnpmBase(
        deps(fake.docker, { stateDir: blocked, publish: () => Promise.resolve({ outcome: "created", pointer: null }) }),
        request(repo),
      ),
    ).rejects.toThrow();

    const after = await buildVerifiedPnpmBase(
      deps(fake.docker, { publish: () => Promise.resolve({ outcome: "created", pointer: null }) }),
      request(repo),
    );
    expect(after).toMatchObject({ status: "published" });
  });

  it("caps how many scopes build at once, because each builder container is memory-capped", async () => {
    const repos = [eligibleRepo(), eligibleRepo(), eligibleRepo()];
    for (const r of repos) cleanup.push(r.dir);
    const held = heldBuild();
    const fake = treeWritingDocker();
    const forRepo = (i: number) => ({
      ...request(repos[i]),
      scope: { ...SCOPE, repoUrl: `https://github.com/acme/repo-${i}.git` },
    });

    const running = repos.slice(0, MAX_CONCURRENT_PNPM_BASE_BUILDS).map((_, i) =>
      buildVerifiedPnpmBase(deps(fake.docker, { publish: held.publish }), forRepo(i)),
    );
    await vi.waitFor(() => expect(held.entered()).toBe(MAX_CONCURRENT_PNPM_BASE_BUILDS));

    const overflow = await buildVerifiedPnpmBase(
      deps(fake.docker, { publish: held.publish }),
      forRepo(MAX_CONCURRENT_PNPM_BASE_BUILDS),
    );
    expect(overflow.status).toBe("skipped-building");
    expect(fake.created).toHaveLength(MAX_CONCURRENT_PNPM_BASE_BUILDS);

    held.release();
    for (const p of running) expect(await p).toMatchObject({ status: "published" });
  });
});

describe("reapOrphanPnpmBaseBuilds", () => {
  it("removes a previous process's builder containers and their work dirs", async () => {
    // The builder's timeout and its `finally` both live in the orchestrator, so a crash
    // between creating the container and finishing the build leaves nothing else to reclaim.
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-reap-"));
    const stranded = path.join(stateDir, "pnpm-base-build", "run-of-a-dead-process", "scope-1");
    fs.mkdirSync(path.join(stranded, "registry", "tarballs"), { recursive: true });
    // This process's own run dir, created the way a live build creates it.
    const mine = pnpmBuildRootDir(stateDir, "scope-2");
    fs.mkdirSync(mine, { recursive: true });

    const listed: unknown[] = [];
    const removed: string[] = [];
    const docker = {
      listContainers: (opts: { filters: { label: string[] } }) => {
        listed.push(opts.filters.label);
        return Promise.resolve([{ Id: "left-over" }]);
      },
      getContainer: (id: string) => ({
        remove: () => {
          removed.push(id);
          return Promise.resolve();
        },
      }),
    } as unknown as Docker;

    expect(await reapOrphanPnpmBaseBuilds(docker, stateDir)).toBe(1);
    expect(listed[0]).toContain(PNPM_BUILDER_LABEL);
    expect(removed).toEqual(["left-over"]);
    expect(fs.existsSync(stranded)).toBe(false);
    expect(fs.existsSync(mine)).toBe(true);
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  /**
   * The reaper is launched un-awaited (`startup-monitors.ts`) and does its pnpm sweep after paced
   * plugin cleanup, so a restored session can finish its install and be building by the time it
   * runs. Without the per-process scoping it killed that live build's container and deleted the
   * staged inputs out from under it.
   */
  it("leaves a build THIS process already started alone", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-reap-live-"));
    const removed: string[] = [];
    const docker = {
      listContainers: () =>
        Promise.resolve([
          { Id: "mine", Labels: { [PNPM_BUILDER_RUN_LABEL]: currentBuilderRunId(stateDir) } },
          { Id: "theirs", Labels: { [PNPM_BUILDER_RUN_LABEL]: "a-dead-process" } },
        ]),
      getContainer: (id: string) => ({
        remove: () => {
          removed.push(id);
          return Promise.resolve();
        },
      }),
    } as unknown as Docker;

    expect(await reapOrphanPnpmBaseBuilds(docker, stateDir)).toBe(1);
    expect(removed).toEqual(["theirs"]);
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
});

/** The run id is private; read it back off the path the builder actually stages under. */
function currentBuilderRunId(stateDir: string): string {
  return path.basename(path.dirname(pnpmBuildRootDir(stateDir, "any-scope")));
}
