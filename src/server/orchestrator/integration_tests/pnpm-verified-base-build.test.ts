/**
 * docs/276 section 5 — the executable contract for the verified-base builder.
 *
 * Runs the real `builderScript()` with a real pnpm over tarballs `stageVerifiedRegistry`
 * staged, so it measures what the container will do rather than a model of it. Three things
 * it holds that nothing else does:
 *
 * - **The build phase reaches no registry at all.** The script points `--offline` at a dead
 *   port, so a tree appears only if the private store the fetch phase built inside the sandbox
 *   really covers the whole lockfile. Its control drops the transitive from the staged set and
 *   shows the build then fails rather than quietly downloading it.
 * - **The repo does not choose the builder's pnpm.** The fixture pins
 *   `packageManager: pnpm@10.28.2`; `builderEnv()` is taken verbatim, so dropping its
 *   version-switch settings turns this red. Measured 2026-09-21: a repo pin reaches the
 *   builder by three routes, and each needs its own switch. (`MIN_VERIFIED_BASE_PNPM_MAJOR`
 *   now also refuses that exact pin at eligibility — a separate gate, for the consumer's store
 *   version. Any pin, including a newer 12.x, still self-switches the builder, so the switches
 *   this cell measures stay load-bearing.)
 * - **The output is pnpm's own**, virtual store and `.bin` shims included, so nothing
 *   downstream re-implements pnpm's layout.
 *
 * It runs outside Docker, so it does not cover mount confinement or the container's limits;
 * those are asserted against the create call in `pnpm-base-builder.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import net from "node:net";
import { promisify } from "node:util";

import {
  BUILD_REGISTRY_SERVER,
  builderEnv,
  builderScript,
  readPendingBuilds,
} from "../pnpm-base-builder.js";
import { prunePnpmBase } from "../pnpm-base-prune.js";
import {
  sha512Integrity,
  stageVerifiedRegistry,
  type FetchLike,
} from "../pnpm-base-registry.js";

const run = promisify(execFile);

/** Regular files under a directory tree — the store's own empty bucket skeleton is not content. */
function filesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const next = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(path.join(dir, entry.name), next);
      else out.push(next);
    }
  };
  try { walk(root, ""); } catch { /* absent */ }
  return out;
}
const PNPM_TIMEOUT_MS = 300_000;
const LEAF = "shipit-base-leaf";
const ROOT = "shipit-base-root";
const VERSION = "1.0.0";
const SCRIPT_MARKER = "POSTINSTALL_RAN";

/**
 * The version the image bakes is tried FIRST, so this measures the pnpm the builder will
 * actually run rather than whatever pnpm 12 the host happens to have — and so a session
 * container (which has pnpm on PATH) and the CI runner (which does not) take the same path.
 *
 * `builderScript` runs its pnpm as ONE executable path, so a multi-word invocation has to
 * become an executable too: a shim, written once and named by path.
 */
const PNPM_PIN = "12.4.1";
function resolvePnpm(shimDir: string): string | null {
  for (const cmd of [["corepack", `pnpm@${PNPM_PIN}`], ["pnpm"]]) {
    try {
      const version = execFileSync(cmd[0], [...cmd.slice(1), "--version"], {
        encoding: "utf-8",
        env: { ...process.env, ...corepackEnv(), COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
      }).trim();
      if (parseInt(version, 10) < 12) continue;
      if (cmd.length === 1) return cmd[0];
      const shim = path.join(shimDir, "pnpm-shim");
      fs.mkdirSync(shimDir, { recursive: true });
      fs.writeFileSync(shim, `#!/bin/sh\nexec ${cmd.join(" ")} "$@"\n`, { mode: 0o755 });
      return shim;
    } catch {
      /* Try the next candidate. */
    }
  }
  return null;
}

/**
 * One corepack cache for the whole file. `builderEnv` gives every run its own HOME — correct
 * for the builder, whose image bakes pnpm at a fixed path — but here it would make corepack
 * re-download the pinned pnpm on each of the five invocations, which is five chances for a
 * network hiccup to fail a cell for a reason it is not testing.
 */
const COREPACK_CACHE = path.join(os.tmpdir(), `pnpm-vb-corepack-${process.pid}`);
function corepackEnv(): NodeJS.ProcessEnv {
  return { COREPACK_HOME: COREPACK_CACHE };
}

/** A minimal npm tarball: `package/` at the root, which is what pnpm unpacks. */
function makeTarball(
  tmp: string,
  name: string,
  manifest: object,
  files: Record<string, string>,
): Buffer {
  const dir = fs.mkdtempSync(path.join(tmp, `tgz-${name}-`));
  const pkg = path.join(dir, "package");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify(manifest));
  for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(pkg, rel), text);
  const out = path.join(dir, "out.tgz");
  execFileSync("tar", ["-czf", out, "-C", dir, "package"]);
  return fs.readFileSync(out);
}

/**
 * The orchestrator's side: resolve and verify against a registry it controls. The fixture
 * stands in for that registry; everything downstream of it is what is under test.
 */
function fetchFrom(tarballs: Map<string, Buffer>): FetchLike {
  return (url) => {
    const tgz = /\/([^/]+)\/-\/[^/]+-([\d.]+)\.tgz$/.exec(url);
    if (tgz) {
      const bytes = tarballs.get(`${tgz[1]}@${tgz[2]}`);
      return Promise.resolve(
        bytes
          ? new Response(new Uint8Array(bytes), { status: 200 })
          : new Response("", { status: 404 }),
      );
    }
    const name = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
    const bytes = tarballs.get(`${name}@${VERSION}`);
    if (!bytes) return Promise.resolve(new Response("{}", { status: 404 }));
    return Promise.resolve(
      new Response(
        JSON.stringify({
          name,
          versions: {
            [VERSION]: {
              name,
              version: VERSION,
              dist: {
                integrity: sha512Integrity(bytes),
                tarball: `https://fixture.test/${name}/-/${name}-${VERSION}.tgz`,
              },
            },
          },
        }),
        { status: 200 },
      ),
    );
  };
}

function envFor(homeDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...Object.fromEntries(builderEnv(homeDir).map((e) => e.split(/=(.*)/s).slice(0, 2))),
    ...corepackEnv(),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  };
}

/**
 * Report what the build actually said. `execFile` rejects with the whole shell script as its
 * message and the output in fields the reporter truncates away, which is how a CI failure here
 * read as "Command failed" and nothing else.
 */
async function runBuild(script: string, homeDir: string): Promise<{ stdout: string; stderr: string }> {
  try {
    return await run("/bin/sh", ["-c", script], {
      timeout: PNPM_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      env: envFor(homeDir),
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    throw new Error(
      `builder exited ${String(e.code)}\n--- stdout ---\n${e.stdout ?? ""}\n--- stderr ---\n${e.stderr ?? ""}`,
      { cause: err },
    );
  }
}

/**
 * A port the OS says is free, rather than one derived from the pid. CI runs this file beside
 * a thousand others in a worker pool, and a port picked by arithmetic is a port something else
 * may already hold — which fails the build for a reason the cell is not testing.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

const SHIM_DIR = path.join(os.tmpdir(), `pnpm-vb-shim-${process.pid}`);
const pnpmCmd = resolvePnpm(SHIM_DIR);

describe.skipIf(pnpmCmd === null)("docs/276 section 5 — verified-base builder", () => {
  let tmp: string;
  let registryDir: string;
  let projectDir: string;
  let storeDir: string;
  let homeDir: string;
  /** Allocated in beforeAll; indexes are per cell, so two cells never share one. */
  const ports: number[] = [];
  const tarballs = new Map<string, Buffer>();
  /** The same package with the build script back on; only the two script cells use it. */
  let scriptedRoot: Buffer;
  /** The patched cells diff against this, so their patch matches the tarball's own manifest. */
  let rootManifest: Record<string, unknown>;

  beforeAll(async () => {
    for (let i = 0; i < 10; i++) ports.push(await freePort());
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-vb-"));
    registryDir = path.join(tmp, "registry");
    projectDir = path.join(tmp, "project");
    storeDir = path.join(tmp, "store");
    homeDir = path.join(tmp, "home");
    for (const d of [registryDir, projectDir, storeDir, homeDir]) {
      fs.mkdirSync(d, { recursive: true });
    }

    tarballs.set(
      `${LEAF}@${VERSION}`,
      makeTarball(tmp, LEAF, { name: LEAF, version: VERSION, main: "index.js" }, {
        "index.js": "module.exports = 'leaf';\n",
      }),
    );
    rootManifest = {
      name: ROOT,
      version: VERSION,
      main: "index.js",
      bin: { [ROOT]: "./cli.js" },
      dependencies: { [LEAF]: VERSION },
    };
    const rootFiles = { "index.js": "module.exports = 'root';\n", "cli.js": "#!/usr/bin/env node\n" };
    tarballs.set(`${ROOT}@${VERSION}`, makeTarball(tmp, ROOT, rootManifest, rootFiles));
    scriptedRoot = makeTarball(
      tmp,
      ROOT,
      {
        ...rootManifest,
        // The build script: a candidate carrying one is now ineligible (planning#604), and the
        // builder still has to suppress it if one ever reaches the container.
        scripts: { postinstall: `node -e "require('fs').writeFileSync('${SCRIPT_MARKER}','')"` },
      },
      rootFiles,
    );

    const fixtureFetch = fetchFrom(tarballs);

    const staged = await stageVerifiedRegistry({
      packages: [ROOT, LEAF].map((name) => ({
        key: `${name}@${VERSION}`,
        name,
        version: VERSION,
        integrity: sha512Integrity(tarballs.get(`${name}@${VERSION}`)!),
      })),
      destDir: registryDir,
      registryUrl: "https://fixture.test/",
      builderRegistryUrl: `http://127.0.0.1:${ports[0]}/`,
      fetchImpl: fixtureFetch,
    });
    expect(staged.ok).toBe(true);
    fs.writeFileSync(path.join(registryDir, "server.mjs"), BUILD_REGISTRY_SERVER);

    writeProject(projectDir);
  }, PNPM_TIMEOUT_MS);

  /**
   * The staged registry for the build-bearing variant of the fixture, through the production
   * staging path. That path stages such a package again since the prune (planning#604), so the
   * two cells that need one no longer assemble a registry by hand.
   */
  async function stageScriptedRegistry(
    destDir: string,
    builderRegistryUrl: string,
  ): ReturnType<typeof stageVerifiedRegistry> {
    const scriptedSet = new Map(tarballs);
    scriptedSet.set(`${ROOT}@${VERSION}`, scriptedRoot);
    const staged = await stageVerifiedRegistry({
      packages: [ROOT, LEAF].map((name) => ({
        key: `${name}@${VERSION}`,
        name,
        version: VERSION,
        integrity: sha512Integrity(scriptedSet.get(`${name}@${VERSION}`)!),
      })),
      destDir,
      registryUrl: "https://fixture.test/",
      builderRegistryUrl,
      fetchImpl: fetchFrom(scriptedSet),
    });
    fs.writeFileSync(path.join(destDir, "server.mjs"), BUILD_REGISTRY_SERVER);
    return staged;
  }

  /** The committed inputs: a repo pin the builder must ignore, and the graph it must follow. */
  function writeProject(dir: string, rootTarball?: Buffer): void {
    const rootBytes = rootTarball ?? tarballs.get(`${ROOT}@${VERSION}`)!;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "app",
        version: "1.0.0",
        packageManager: "pnpm@10.28.2",
        dependencies: { [ROOT]: VERSION },
      }),
    );
    // The repo APPROVES the build, in pnpm 12's own form: `allowBuilds` keyed by package id.
    // Measured 2026-09-21 that `onlyBuiltDependencies` does NOT approve on 12.4.1 — the
    // install still fails `ERR_PNPM_IGNORED_BUILDS` — so the control below would measure
    // nothing without this exact spelling.
    fs.writeFileSync(
      path.join(dir, "pnpm-workspace.yaml"),
      `allowBuilds:\n  "${ROOT}@${VERSION}": true\n`,
    );
    fs.writeFileSync(
      path.join(dir, "pnpm-lock.yaml"),
      `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      ${ROOT}:
        specifier: ${VERSION}
        version: ${VERSION}

packages:

  ${ROOT}@${VERSION}:
    resolution: {integrity: ${sha512Integrity(rootBytes)}}
    hasBin: true

  ${LEAF}@${VERSION}:
    resolution: {integrity: ${sha512Integrity(tarballs.get(`${LEAF}@${VERSION}`)!)}}

snapshots:

  ${ROOT}@${VERSION}:
    dependencies:
      ${LEAF}: ${VERSION}

  ${LEAF}@${VERSION}: {}
`,
    );
  }

  /**
   * The committed inputs of a repo that patches its one dependency, in the key shape pnpm
   * writes: the `packages:` entry stays the plain published version, and the patch hash rides
   * on the importer and snapshot keys as `(patch_hash=…)`.
   */
  function writePatchedProject(dir: string, patchHash: string): void {
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "app", version: "1.0.0", dependencies: { [ROOT]: VERSION } }),
    );
    fs.writeFileSync(
      path.join(dir, "pnpm-workspace.yaml"),
      `patchedDependencies:\n  "${ROOT}@${VERSION}": patches/${ROOT}.patch\n`,
    );
    fs.writeFileSync(
      path.join(dir, "pnpm-lock.yaml"),
      `lockfileVersion: '9.0'

patchedDependencies:
  ${ROOT}@${VERSION}: ${patchHash}

importers:

  .:
    dependencies:
      ${ROOT}:
        specifier: ${VERSION}
        version: ${VERSION}(patch_hash=${patchHash})

packages:

  ${ROOT}@${VERSION}:
    resolution: {integrity: ${sha512Integrity(tarballs.get(`${ROOT}@${VERSION}`)!)}}
    hasBin: true

  ${LEAF}@${VERSION}:
    resolution: {integrity: ${sha512Integrity(tarballs.get(`${LEAF}@${VERSION}`)!)}}

snapshots:

  ${ROOT}@${VERSION}(patch_hash=${patchHash}):
    dependencies:
      ${LEAF}: ${VERSION}

  ${LEAF}@${VERSION}: {}
`,
    );
  }

  afterAll(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("builds the whole tree offline from the store the sandbox fetch phase populated", async () => {
    const result = await runBuild(
      builderScript({
        pnpmBin: pnpmCmd!,
        projectDir,
        registryDir,
        storeDir,
        registryUrl: `http://127.0.0.1:${ports[0]}/`,
        readyFile: path.join(tmp, "registry.ready"),
      }),
      homeDir,
    );

    // The repo's `packageManager` pin did not choose the builder's pnpm.
    expect(result.stdout + result.stderr).not.toContain("pnpm v10.");

    const modules = path.join(projectDir, "node_modules");
    expect(fs.readFileSync(path.join(modules, ROOT, "index.js"), "utf-8")).toContain("root");
    // The transitive is real too, so the private store covered the whole lockfile offline.
    expect(fs.existsSync(path.join(modules, ".pnpm", `${LEAF}@${VERSION}`))).toBe(true);
    // pnpm generated the shim; nothing downstream re-implements its layout.
    expect(fs.existsSync(path.join(modules, ".bin", ROOT))).toBe(true);
    expect(fs.readdirSync(storeDir).length).toBeGreaterThan(0);
  }, PNPM_TIMEOUT_MS);

  it("hands a consumer a tree it accepts as up to date against an EMPTY private store", async () => {
    // The whole point of the base, and the one thing the store path decides: pnpm records
    // `storeDir` in `node_modules/.modules.yaml`, so a tree built anywhere else is a store
    // mismatch the consumer reinstalls or refuses. `BUILD_STORE_DIR` is the session's own
    // container path for exactly this reason; here both sides use one path so the cell
    // measures the mechanism rather than the constant.
    const scratch = fs.mkdtempSync(path.join(tmp, "consume-"));
    const built = path.join(scratch, "built");
    const sharedStorePath = path.join(scratch, "store");
    writeProject(built);
    await runBuild(
      builderScript({
        pnpmBin: pnpmCmd!,
        projectDir: built,
        registryDir,
        storeDir: sharedStorePath,
        registryUrl: `http://127.0.0.1:${ports[3]}/`,
        readyFile: path.join(scratch, "registry.ready"),
      }),
      path.join(scratch, "home"),
    );

    // A second session: the base tree, its own committed inputs, and an EMPTY store at the
    // path the base records. Emptying it is what makes this a base hit rather than a reinstall.
    const consumer = path.join(scratch, "consumer");
    writeProject(consumer);
    fs.cpSync(path.join(built, "node_modules"), path.join(consumer, "node_modules"), {
      recursive: true,
      verbatimSymlinks: true,
    });
    expect(
      fs.readFileSync(path.join(consumer, "node_modules", ".modules.yaml"), "utf-8"),
    ).toContain(sharedStorePath);
    fs.rmSync(sharedStorePath, { recursive: true, force: true });
    fs.mkdirSync(sharedStorePath, { recursive: true });

    // A session's registry is reachable, so this one's is too — and it has to be: pnpm 12
    // verifies the lockfile against supply-chain policies before anything else, which needs
    // registry metadata the consumer's cold cache does not have. `--offline` here would fail
    // on that, not on the tree (FINDINGS.md).
    const consumerPort = ports[4];
    const server = spawn(
      "node",
      [path.join(registryDir, "server.mjs"), registryDir, String(consumerPort),
        path.join(scratch, "consumer-registry.ready")],
      { stdio: "ignore" },
    );
    try {
      for (let i = 0; i < 300 && !fs.existsSync(path.join(scratch, "consumer-registry.ready")); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const result = await run(
        pnpmCmd!,
        [
          "install", "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile",
          "--store-dir", sharedStorePath, "--registry", `http://127.0.0.1:${consumerPort}/`,
        ],
        {
          cwd: consumer,
          timeout: PNPM_TIMEOUT_MS,
          maxBuffer: 16 * 1024 * 1024,
          env: envFor(path.join(scratch, "consumer-home")),
        },
      );
      expect(result.stdout).toContain("resolution step is skipped");
    } finally {
      server.kill();
    }
    // Nothing was imported: the consumer read the tree, not a store.
    expect(fs.readdirSync(sharedStorePath)).toEqual([]);
    expect(fs.readFileSync(path.join(consumer, "node_modules", ROOT, "index.js"), "utf-8"))
      .toContain("root");
  }, PNPM_TIMEOUT_MS);

  it("fails rather than reaching the network when a package is missing from the staged set", async () => {
    const scratch = fs.mkdtempSync(path.join(tmp, "missing-"));
    const thinRegistry = path.join(scratch, "registry");
    fs.cpSync(registryDir, thinRegistry, { recursive: true });
    const routes = JSON.parse(
      fs.readFileSync(path.join(thinRegistry, "tarballs.json"), "utf-8"),
    ) as Record<string, string>;
    const index = JSON.parse(fs.readFileSync(path.join(thinRegistry, "index.json"), "utf-8")) as
      Record<string, unknown>;
    // Drop the transitive: a build that still succeeds downloaded it from somewhere else.
    const without = (obj: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(Object.entries(obj).filter(([key]) => !key.includes(LEAF)));
    fs.writeFileSync(path.join(thinRegistry, "index.json"), JSON.stringify(without(index)));
    fs.writeFileSync(path.join(thinRegistry, "tarballs.json"), JSON.stringify(without(routes)));

    const thinProject = path.join(scratch, "project");
    writeProject(thinProject);

    let failure: { stdout?: string; stderr?: string; code?: number } | null = null;
    try {
      await run(
        "/bin/sh",
        [
          "-c",
          builderScript({
            pnpmBin: pnpmCmd!,
            projectDir: thinProject,
            registryDir: thinRegistry,
            storeDir: path.join(scratch, "store"),
            registryUrl: `http://127.0.0.1:${ports[1]}/`,
            readyFile: path.join(scratch, "registry.ready"),
          }),
        ],
        {
          timeout: PNPM_TIMEOUT_MS,
          maxBuffer: 16 * 1024 * 1024,
          env: envFor(path.join(scratch, "home")),
        },
      );
    } catch (err) {
      failure = err as { stdout?: string; stderr?: string; code?: number };
    }

    // Name the failure rather than accepting any rejection: a timeout, or a pnpm that could
    // not launch at all, would otherwise read as this control passing.
    expect(failure).not.toBeNull();
    const output = `${failure?.stdout ?? ""}${failure?.stderr ?? ""}`;
    expect(failure?.code).toBeGreaterThan(0);
    expect(output).toContain(LEAF);
    expect(fs.existsSync(path.join(thinProject, "node_modules", ROOT))).toBe(false);
  }, PNPM_TIMEOUT_MS);

  it("prunes the build-bearing package out of the base, and a bare install restores and BUILDS it", async () => {
    // planning#604's class, end to end against real pnpm: such a repo used to get no base at
    // all. The whole lockfile is built, the building package is pruned from the tree AND from
    // the carried lockfile, and the consuming session's own install — a BARE `pnpm install`,
    // because `agent.install` is repo-authored and ShipIt cannot assume `--frozen-lockfile` —
    // re-imports it into a private store and runs its script. That last half is the reviewer's
    // question: a pruned base must not leave a session at rc=0 with something missing or unbuilt.
    //
    // The tarball is GNU tar's own output, so this also holds the scan against a real archive
    // rather than against the fixture writer the unit tests use.
    const scratch = fs.mkdtempSync(path.join(tmp, "pruned-"));
    const scriptedRegistry = path.join(scratch, "registry");
    const staged = await stageScriptedRegistry(scriptedRegistry, `http://127.0.0.1:${ports[8]}/`);
    expect(staged).toMatchObject({ ok: true, buildTriggers: [{ key: `${ROOT}@${VERSION}` }] });

    const built = path.join(scratch, "built");
    writeProject(built, scriptedRoot);
    const sharedStorePath = path.join(scratch, "store");
    await runBuild(
      builderScript({
        pnpmBin: pnpmCmd!,
        projectDir: built,
        registryDir: scriptedRegistry,
        storeDir: sharedStorePath,
        registryUrl: `http://127.0.0.1:${ports[8]}/`,
        readyFile: path.join(scratch, "registry.ready"),
      }),
      path.join(scratch, "home"),
    );

    const modules = path.join(built, "node_modules");
    // The builder's own output, before the prune: pnpm built the WHOLE lockfile, so the
    // retained package's links were generated against a complete graph.
    expect(fs.existsSync(path.join(modules, ".pnpm", `${ROOT}@${VERSION}`))).toBe(true);
    // And it is unbuilt and pending, which is exactly why it cannot stay.
    expect(readPendingBuilds(modules, ["."]).kind).toBe("pending");

    const stateFile = fs
      .readdirSync(modules)
      .find((n) => n.startsWith(".pnpm-workspace-state"));
    expect(stateFile).toBeDefined();
    const stateBytes = fs.readFileSync(path.join(modules, stateFile!));

    const pruned = prunePnpmBase(modules, [
      { key: `${ROOT}@${VERSION}`, name: ROOT, version: VERSION },
    ]);
    expect(pruned).toMatchObject({ ok: true, remainingPackages: 1, removedState: [stateFile] });
    expect(fs.existsSync(path.join(modules, ".pnpm", `${ROOT}@${VERSION}`))).toBe(false);
    expect(fs.existsSync(path.join(modules, ".pnpm", `${LEAF}@${VERSION}`))).toBe(true);
    expect(fs.readFileSync(path.join(modules, ".pnpm", "lock.yaml"), "utf-8")).not.toContain(ROOT);
    // The prune does not rewrite `.modules.yaml`, so the removed package is still named there;
    // what is left for the PUBLISH to refuse is everything the prune did not remove.
    expect(readPendingBuilds(modules, ["."], new Set([`${ROOT}@${VERSION}`]))).toEqual({
      kind: "none",
    });

    // A second session: the pruned base, its own committed inputs, and an EMPTY private store.
    // Its checkout is backdated, which is the shape that hides the prune: pnpm's carried install
    // state short-circuits on `lastValidatedTimestamp` versus these mtimes, BEFORE it reads the
    // carried lockfile. A session whose workspace predates the build is in exactly this shape.
    const consumer = path.join(scratch, "consumer");
    writeProject(consumer, scriptedRoot);
    const stale = new Date(Date.now() - 3_600_000);
    for (const f of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
      fs.utimesSync(path.join(consumer, f), stale, stale);
    }
    fs.cpSync(modules, path.join(consumer, "node_modules"), {
      recursive: true,
      verbatimSymlinks: true,
    });
    // The SAME store path the base was built with, emptied — which is what production has:
    // `BUILD_STORE_DIR === PNPM_STORE_CONTAINER_PATH`, so the consuming session's own private
    // store sits where `.modules.yaml` says. A different path is a store mismatch pnpm recovers
    // from by recreating the whole tree, and every assertion below would then pass on a full
    // reinstall rather than on selective repair (independent review, 2026-09-21).
    const consumerStore = sharedStorePath;
    fs.rmSync(consumerStore, { recursive: true, force: true });
    fs.mkdirSync(consumerStore, { recursive: true });
    expect(
      fs.readFileSync(path.join(consumer, "node_modules", ".modules.yaml"), "utf-8"),
    ).toContain(consumerStore);
    // What "shared" has to mean: these exact bytes, not a package of the same name.
    const retained = path.join(
      consumer, "node_modules", ".pnpm", `${LEAF}@${VERSION}`, "node_modules", LEAF, "index.js",
    );
    const retainedBefore = fs.statSync(retained);

    const consumerPort = ports[9];
    const server = spawn(
      "node",
      [path.join(scriptedRegistry, "server.mjs"), scriptedRegistry, String(consumerPort),
        path.join(scratch, "consumer-registry.ready")],
      { stdio: "ignore" },
    );
    try {
      for (let i = 0; i < 300 && !fs.existsSync(path.join(scratch, "consumer-registry.ready")); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      // No `--frozen-lockfile`: the pruned carried lockfile is what makes the hole visible to
      // the weaker command. With the tree pruned and the lockfile left alone, pnpm reports
      // "Already up to date" and leaves the hole (measured, `ineligible-sharing-spike.sh` E).
      const install = (cwd: string): ReturnType<typeof run> =>
        run(
          pnpmCmd!,
          ["install", "--store-dir", consumerStore, "--registry", `http://127.0.0.1:${consumerPort}/`],
          {
            cwd,
            timeout: PNPM_TIMEOUT_MS,
            maxBuffer: 16 * 1024 * 1024,
            env: envFor(path.join(scratch, "consumer-home")),
          },
        );

      // The control FIRST, on a copy: with the state file put back and nothing else changed,
      // pnpm short-circuits and the hole survives. Without it this cell would pass on a tree
      // where the state file simply never mattered.
      //
      // Its `projects` key is rewritten to the consumer's own directory, which is what makes the
      // control faithful rather than generous: in production the builder's project dir IS the
      // session's (`BUILD_PROJECT_DIR === CONTAINER_WORKSPACE_PATH`, chosen so `.modules.yaml`'s
      // `storeDir` matches), while this file builds in a temp dir. Leave it and the state file
      // names a foreign project, pnpm ignores it, and the control passes for the wrong reason —
      // measured here before it was corrected.
      const control = path.join(scratch, "control");
      fs.cpSync(consumer, control, { recursive: true, verbatimSymlinks: true });
      for (const f of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
        fs.utimesSync(path.join(control, f), stale, stale);
      }
      const state = JSON.parse(stateBytes.toString("utf-8")) as {
        projects: Record<string, unknown>;
      };
      state.projects = { [control]: Object.values(state.projects)[0] };
      fs.writeFileSync(path.join(control, "node_modules", stateFile!), JSON.stringify(state));
      const controlRun = await install(control);
      expect(String(controlRun.stdout) + String(controlRun.stderr)).toContain("Already up to date");
      expect(
        fs.existsSync(path.join(control, "node_modules", ".pnpm", `${ROOT}@${VERSION}`)),
      ).toBe(false);

      const result = await install(consumer);
      expect(String(result.stdout) + String(result.stderr)).not.toContain("Already up to date");
    } finally {
      server.kill();
    }

    const restored = path.join(consumer, "node_modules", ".pnpm", `${ROOT}@${VERSION}`, "node_modules", ROOT);
    expect(fs.existsSync(restored)).toBe(true);
    // Not just restored: BUILT, as the session's own uid, which is the whole point of pruning
    // it rather than shipping it unbuilt.
    expect(fs.existsSync(path.join(restored, SCRIPT_MARKER))).toBe(true);
    // The retained remainder is still the base's, not a reinstall of everything: the same inode,
    // untouched, against an emptied store at the path the base records.
    const retainedAfter = fs.statSync(retained);
    expect(retainedAfter.ino).toBe(retainedBefore.ino);
    expect(retainedAfter.mtimeMs).toBe(retainedBefore.mtimeMs);
    // And the store the install filled holds the pruned package alone.
    expect(fs.readdirSync(consumerStore).length).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(consumer, "node_modules", ROOT, "index.js"), "utf-8"))
      .toContain("root");
  }, PNPM_TIMEOUT_MS);

  it("leaves an APPROVED build script unrun, with a control that shows it would otherwise run", async () => {
    // Section 5: "packages with build scripts land unbuilt". Such a package reaches the builder
    // again since the prune (planning#604), and this measures the layer behind that: the
    // builder's `--ignore-scripts` is what makes "no repo code runs in the builder" a fact,
    // rather than a consequence of whichever eligibility rule sits above it. The fixture
    // approves the build in `pnpm-workspace.yaml`, so the control is a genuine positive —
    // pnpm 12 refuses an unapproved build either way, and this cell would then measure nothing.
    const scratch = fs.mkdtempSync(path.join(tmp, "scripts-"));
    const scriptedRegistry = path.join(scratch, "registry");
    await stageScriptedRegistry(scriptedRegistry, `http://127.0.0.1:${ports[2]}/`);
    const scripted = path.join(scratch, "project");
    writeProject(scripted, scriptedRoot);

    const paths = {
      pnpmBin: pnpmCmd!,
      projectDir: scripted,
      registryDir: scriptedRegistry,
      storeDir: path.join(scratch, "store"),
      registryUrl: `http://127.0.0.1:${ports[2]}/`,
      readyFile: path.join(scratch, "registry.ready"),
    };
    const marker = path.join(
      scripted, "node_modules", ".pnpm", `${ROOT}@${VERSION}`, "node_modules", ROOT, SCRIPT_MARKER,
    );

    await runBuild(builderScript(paths), path.join(scratch, "home"));
    expect(fs.existsSync(marker)).toBe(false);

    // Control: the same build with the suppression removed from the phase that PUBLISHES.
    // The fetch phase keeps it — without it pnpm refuses to fetch at all, which would make
    // this control fail for the wrong reason.
    fs.rmSync(path.join(scripted, "node_modules"), { recursive: true, force: true });
    const withScripts = builderScript(paths).replace(
      "install --offline --frozen-lockfile --ignore-scripts",
      "install --offline --frozen-lockfile",
    );
    await runBuild(withScripts, path.join(scratch, "home"));
    expect(fs.existsSync(marker)).toBe(true);
  }, PNPM_TIMEOUT_MS);
  it("applies a committed patch under the builder's own flags", async () => {
    // The whole admission, on the real pipeline rather than on a model of it: verified tarballs,
    // the loopback fetch phase, then a FROZEN OFFLINE install under `--ignore-scripts
    // --ignore-pnpmfile`. The unit tests decide eligibility; only this shows pnpm actually
    // applying the patch under the builder's own flags.
    const scratch = fs.mkdtempSync(path.join(tmp, "patched-"));
    const project = path.join(scratch, "project");
    fs.mkdirSync(path.join(project, "patches"), { recursive: true });
    const patch = `diff --git a/index.js b/index.js
--- a/index.js
+++ b/index.js
@@ -1 +1 @@
-module.exports = 'root';
+module.exports = 'root-patched';
`;
    fs.writeFileSync(path.join(project, "patches", `${ROOT}.patch`), patch);
    writePatchedProject(project, crypto.createHash("sha256").update(patch).digest("hex"));

    await runBuild(
      builderScript({
        pnpmBin: pnpmCmd!,
        projectDir: project,
        registryDir,
        storeDir: path.join(scratch, "store"),
        registryUrl: `http://127.0.0.1:${ports[5]}/`,
        readyFile: path.join(scratch, "registry.ready"),
      }),
      path.join(scratch, "home"),
    );

    const installed = path.join(project, "node_modules", ROOT, "index.js");
    expect(fs.readFileSync(installed, "utf-8")).toContain("root-patched");
    // Nothing is left for the consuming session to do.
    expect(readPendingBuilds(path.join(project, "node_modules"), ["."])).toEqual({ kind: "none" });
  }, PNPM_TIMEOUT_MS);

  it("records a patch-added build script as pending, which the tarball scan cannot see", async () => {
    // The premise of the publication gate, measured against pnpm rather than asserted: the
    // install-time-build refusal reads the staged TARBALLS, so a `postinstall` a patch ADDS is
    // invisible to it. Here the builder's own offline `--ignore-scripts` install exits 0 and
    // leaves the package unbuilt — and `readPendingBuilds` is what notices, so this cell turns
    // red if pnpm ever stops recording it, which an invented `.modules.yaml` never could.
    const scratch = fs.mkdtempSync(path.join(tmp, "patch-build-"));
    const project = path.join(scratch, "project");
    fs.mkdirSync(path.join(project, "patches"), { recursive: true });
    const patch = `diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -1 +1 @@
-${JSON.stringify(rootManifest)}
+${JSON.stringify({ ...rootManifest, scripts: { postinstall: "node -e \"1\"" } })}
`;
    fs.writeFileSync(path.join(project, "patches", `${ROOT}.patch`), patch);
    writePatchedProject(project, crypto.createHash("sha256").update(patch).digest("hex"));

    await runBuild(
      builderScript({
        pnpmBin: pnpmCmd!,
        projectDir: project,
        registryDir,
        storeDir: path.join(scratch, "store"),
        registryUrl: `http://127.0.0.1:${ports[6]}/`,
        readyFile: path.join(scratch, "registry.ready"),
      }),
      path.join(scratch, "home"),
    );

    const pending = readPendingBuilds(path.join(project, "node_modules"), ["."]);
    expect(pending.kind).toBe("pending");
    expect((pending as { packages: string[] }).packages.join(" ")).toContain(ROOT);
  }, PNPM_TIMEOUT_MS);

  it("does not count the repo's OWN deferred lifecycle script as a pending build", async () => {
    // Measured 2026-09-21: pnpm records deferred PROJECT scripts in `pendingBuilds` as bare
    // importer ids. The builder never runs them and the session does (plan.md section 5), so
    // counting them would take a base off a repo eligible today.
    const scratch = fs.mkdtempSync(path.join(tmp, "root-script-"));
    const project = path.join(scratch, "project");
    writeProject(project);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(project, "package.json"), "utf-8"),
    ) as Record<string, unknown>;
    fs.writeFileSync(
      path.join(project, "package.json"),
      JSON.stringify({ ...manifest, scripts: { postinstall: 'node -e "1"' } }),
    );

    await runBuild(
      builderScript({
        pnpmBin: pnpmCmd!,
        projectDir: project,
        registryDir,
        storeDir: path.join(scratch, "store"),
        registryUrl: `http://127.0.0.1:${ports[7]}/`,
        readyFile: path.join(scratch, "registry.ready"),
      }),
      path.join(scratch, "home"),
    );

    const modules = path.join(project, "node_modules");
    // The positive control: pnpm really did defer it, so the filter is doing work.
    const raw = JSON.parse(fs.readFileSync(path.join(modules, ".modules.yaml"), "utf-8")) as
      { pendingBuilds: string[] };
    expect(raw.pendingBuilds).toContain(".");
    expect(readPendingBuilds(modules, ["."])).toEqual({ kind: "none" });
  }, PNPM_TIMEOUT_MS);

  /**
   * A `workspace:` dependency, end to end on the real pipeline (planning#414).
   *
   * Two facts the admission rests on, neither of them assertable off the eligibility decision:
   * the builder stages MANIFESTS, so a workspace member's source never reaches it, and the
   * builder publishes `projectDir/node_modules` ALONE, so a member's own `node_modules` is not
   * in the base. This builds a workspace base from manifests only and then consumes it from a
   * full checkout with the member trees absent — the shape a real session starts in.
   */
  function writeWorkspaceProject(dir: string, opts: { memberSource: boolean }): void {
    const member = path.join(dir, "packages", "member");
    fs.mkdirSync(member, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "app",
        version: "1.0.0",
        private: true,
        dependencies: { [ROOT]: VERSION, member: "workspace:*" },
      }),
    );
    fs.writeFileSync(path.join(dir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    fs.writeFileSync(
      path.join(member, "package.json"),
      JSON.stringify({
        name: "member",
        version: "1.0.0",
        main: "index.js",
        dependencies: { [LEAF]: VERSION },
      }),
    );
    // Only the consumer has it. Its absence from the builder's input is the point: if the base
    // ever carried member CONTENT, this file would be how the cell noticed.
    if (opts.memberSource) {
      fs.writeFileSync(path.join(member, "index.js"), "module.exports = 'member-source';\n");
    }
    fs.writeFileSync(
      path.join(dir, "pnpm-lock.yaml"),
      `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      ${ROOT}:
        specifier: ${VERSION}
        version: ${VERSION}
      member:
        specifier: workspace:*
        version: link:packages/member

  packages/member:
    dependencies:
      ${LEAF}:
        specifier: ${VERSION}
        version: ${VERSION}

packages:

  ${ROOT}@${VERSION}:
    resolution: {integrity: ${sha512Integrity(tarballs.get(`${ROOT}@${VERSION}`)!)}}
    hasBin: true

  ${LEAF}@${VERSION}:
    resolution: {integrity: ${sha512Integrity(tarballs.get(`${LEAF}@${VERSION}`)!)}}

snapshots:

  ${ROOT}@${VERSION}:
    dependencies:
      ${LEAF}: ${VERSION}

  ${LEAF}@${VERSION}: {}
`,
    );
  }

  it("publishes a workspace member as a relative symlink and no content, and a consumer rebuilds its member trees", async () => {
    const scratch = fs.mkdtempSync(path.join(tmp, "workspace-"));
    const built = path.join(scratch, "built");
    const sharedStorePath = path.join(scratch, "store");
    writeWorkspaceProject(built, { memberSource: false });
    await runBuild(
      builderScript({
        pnpmBin: pnpmCmd!,
        projectDir: built,
        registryDir,
        storeDir: sharedStorePath,
        registryUrl: `http://127.0.0.1:${ports[8]}/`,
        readyFile: path.join(scratch, "registry.ready"),
      }),
      path.join(scratch, "home"),
    );

    // What the base carries for the member: one RELATIVE link out of `node_modules`, nothing else.
    const builtModules = path.join(built, "node_modules");
    expect(fs.readlinkSync(path.join(builtModules, "member"))).toBe("../packages/member");
    expect(fs.existsSync(path.join(builtModules, ".pnpm", "member@file+packages+member"))).toBe(false);

    // The member's own tree is NOT part of the published base.
    expect(fs.existsSync(path.join(built, "packages", "member", "node_modules"))).toBe(true);

    const consumer = path.join(scratch, "consumer");
    writeWorkspaceProject(consumer, { memberSource: true });
    fs.cpSync(builtModules, path.join(consumer, "node_modules"), {
      recursive: true,
      verbatimSymlinks: true,
    });
    fs.rmSync(sharedStorePath, { recursive: true, force: true });
    fs.mkdirSync(sharedStorePath, { recursive: true });

    const consumerPort = ports[9];
    const server = spawn(
      "node",
      [path.join(registryDir, "server.mjs"), registryDir, String(consumerPort),
        path.join(scratch, "consumer-registry.ready")],
      { stdio: "ignore" },
    );
    try {
      for (let i = 0; i < 300 && !fs.existsSync(path.join(scratch, "consumer-registry.ready")); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      await run(
        pnpmCmd!,
        [
          "install", "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile",
          "--store-dir", sharedStorePath, "--registry", `http://127.0.0.1:${consumerPort}/`,
        ],
        {
          cwd: consumer,
          timeout: PNPM_TIMEOUT_MS,
          maxBuffer: 16 * 1024 * 1024,
          env: envFor(path.join(scratch, "consumer-home")),
        },
      );
    } finally {
      server.kill();
    }

    // The member link resolves to the CONSUMER's own source, which the base never saw.
    expect(
      fs.readFileSync(path.join(consumer, "node_modules", "member", "index.js"), "utf-8"),
    ).toContain("member-source");
    // The member's tree is recreated from the base, in the session's own writable checkout.
    expect(
      fs.readlinkSync(path.join(consumer, "packages", "member", "node_modules", LEAF)),
    ).toContain(path.join("node_modules", ".pnpm", `${LEAF}@${VERSION}`));
    // No package content was imported. A workspace consumer does touch its store — it creates
    // the bucket skeleton and an empty `index.db`, which the non-workspace cell above does not —
    // but the content buckets stay empty, so the member trees were linked out of the base.
    expect(filesUnder(sharedStorePath).filter((f) => f.includes("files/"))).toEqual([]);
  }, PNPM_TIMEOUT_MS);
});
