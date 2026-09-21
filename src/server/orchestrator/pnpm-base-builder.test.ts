import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
  PNPM_BUILDER_LABEL,
  reapOrphanPnpmBaseBuilds,
  type PnpmBaseBuilderDeps,
} from "./pnpm-base-builder.js";
import { CONTAINER_WORKSPACE_PATH, PNPM_VERIFIED_NAMESPACE } from "./overlay-session.js";
import { PNPM_STORE_CONTAINER_PATH } from "./container-lifecycle.js";
import { sha512Integrity, type FetchLike } from "./pnpm-base-registry.js";
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

const TARBALL = Buffer.from("left-pad tarball bytes");

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

function eligibleRepo(): { dir: string; commit: string } {
  return makeRepo({
    "package.json": JSON.stringify({ name: "app", dependencies: { "left-pad": "1.3.0" } }),
    "pnpm-lock.yaml": LOCK.replace("INTEGRITY", sha512Integrity(TARBALL)),
  });
}

const okFetch: FetchLike = (url) => {
  if (url.endsWith(".tgz")) {
    return Promise.resolve(new Response(new Uint8Array(TARBALL), { status: 200 }));
  }
  return Promise.resolve(
    new Response(
      JSON.stringify({
        name: "left-pad",
        versions: {
          "1.3.0": {
            dist: {
              integrity: sha512Integrity(TARBALL),
              tarball: "https://registry.example.test/left-pad/-/left-pad-1.3.0.tgz",
            },
          },
        },
      }),
      { status: 200 },
    ),
  );
};

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
      onRun: (cfg) => {
        // Stand in for the container: create the tree the real build would leave behind.
        const mount = (cfg.HostConfig?.Mounts ?? []).find(
          (m) => (m as { Target?: string }).Target === BUILD_PROJECT_DIR,
        ) as { Source?: string } | undefined;
        fs.mkdirSync(path.join(mount?.Source ?? "", "node_modules", "left-pad"), {
          recursive: true,
        });
      },
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
      onRun: (cfg) => {
        const mount = (cfg.HostConfig?.Mounts ?? []).find(
          (m) => (m as { Target?: string }).Target === BUILD_PROJECT_DIR,
        ) as { Source?: string } | undefined;
        fs.mkdirSync(path.join(mount?.Source ?? "", "node_modules", "left-pad"), {
          recursive: true,
        });
      },
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
    const scopeDirs = fs.readdirSync(path.join(stateDir, "pnpm-base-build"));
    expect(scopeDirs).toHaveLength(1);
    expect(fs.readdirSync(path.join(stateDir, "pnpm-base-build", scopeDirs[0]))).toEqual([]);
  });
});

describe("reapOrphanPnpmBaseBuilds", () => {
  it("removes a previous process's builder containers and their work dirs", async () => {
    // The builder's timeout and its `finally` both live in the orchestrator, so a crash
    // between creating the container and finishing the build leaves nothing else to reclaim.
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-reap-"));
    const stranded = path.join(stateDir, "pnpm-base-build", "scope-1", "run-abc");
    fs.mkdirSync(path.join(stranded, "registry", "tarballs"), { recursive: true });

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
    expect(fs.existsSync(path.join(stateDir, "pnpm-base-build"))).toBe(false);
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
});
