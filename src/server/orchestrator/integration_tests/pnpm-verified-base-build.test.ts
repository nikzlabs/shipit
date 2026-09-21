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
import {
  conventionalTarballPath,
  sha512Integrity,
  stageVerifiedRegistry,
  tarballFileName,
  type FetchLike,
} from "../pnpm-base-registry.js";

const run = promisify(execFile);
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

/**
 * The registry layout `stageVerifiedRegistry` produces, written by hand for the ONE input
 * production can no longer stage: since planning#604 a dependency with an install-time script
 * makes the candidate ineligible, so the cell that measures the builder's `--ignore-scripts` —
 * the layer BEHIND that rule, and the reason a script never runs even if one reaches here —
 * has to assemble its own.
 */
function stageRegistryByHand(
  destDir: string,
  entries: { name: string; bytes: Buffer }[],
  builderRegistryUrl: string,
): void {
  fs.mkdirSync(path.join(destDir, "tarballs"), { recursive: true });
  const index: Record<string, unknown> = {};
  const routes: Record<string, string> = {};
  for (const { name, bytes } of entries) {
    const integrity = sha512Integrity(bytes);
    const file = tarballFileName(integrity);
    fs.writeFileSync(path.join(destDir, "tarballs", file), bytes);
    const route = conventionalTarballPath(name, VERSION);
    routes[route] = file;
    index[name] = {
      name,
      "dist-tags": { latest: VERSION },
      versions: {
        [VERSION]: {
          name,
          version: VERSION,
          dist: { tarball: `${builderRegistryUrl.replace(/\/+$/, "")}${route}`, integrity },
        },
      },
    };
  }
  fs.writeFileSync(path.join(destDir, "index.json"), JSON.stringify(index));
  fs.writeFileSync(path.join(destDir, "tarballs.json"), JSON.stringify(routes));
  fs.writeFileSync(path.join(destDir, "server.mjs"), BUILD_REGISTRY_SERVER);
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
    for (let i = 0; i < 8; i++) ports.push(await freePort());
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

  it("gives a dependency with an install-time script no base at all", async () => {
    // planning#604: the builder installs `--ignore-scripts`, so the base carries the package
    // unbuilt — and the session's own install over it reports nothing pending and exits 0, while
    // both repairs fail to chmod as the session's uid. No base is the fail-safe.
    // The tarball here is GNU tar's own output, so this also holds the scan against a real
    // archive rather than against the fixture writer the unit tests use.
    const scriptedSet = new Map(tarballs);
    scriptedSet.set(`${ROOT}@${VERSION}`, scriptedRoot);
    const result = await stageVerifiedRegistry({
      packages: [ROOT, LEAF].map((name) => ({
        key: `${name}@${VERSION}`,
        name,
        version: VERSION,
        integrity: sha512Integrity(scriptedSet.get(`${name}@${VERSION}`)!),
      })),
      destDir: fs.mkdtempSync(path.join(tmp, "scripted-stage-")),
      registryUrl: "https://fixture.test/",
      builderRegistryUrl: `http://127.0.0.1:${ports[0]}/`,
      fetchImpl: fetchFrom(scriptedSet),
    });

    expect(result).toMatchObject({ ok: false, ineligible: { code: "install-script" } });
    expect("ineligible" in result ? result.ineligible.detail : "").toContain(
      `${ROOT}@${VERSION}`,
    );
  }, PNPM_TIMEOUT_MS);

  it("leaves an APPROVED build script unrun, with a control that shows it would otherwise run", async () => {
    // Section 5: "packages with build scripts land unbuilt". Since planning#604 such a package
    // never reaches the builder — the cell above refuses it — so this measures the layer
    // behind that rule: `--ignore-scripts` is what makes "no repo code runs in the builder" a
    // fact rather than a consequence of the eligibility decision above it. The fixture
    // approves the build in `pnpm-workspace.yaml`, so the control is a genuine positive —
    // pnpm 12 refuses an unapproved build either way, and this cell would then measure nothing.
    const scratch = fs.mkdtempSync(path.join(tmp, "scripts-"));
    const scriptedRegistry = path.join(scratch, "registry");
    stageRegistryByHand(
      scriptedRegistry,
      [
        { name: ROOT, bytes: scriptedRoot },
        { name: LEAF, bytes: tarballs.get(`${LEAF}@${VERSION}`)! },
      ],
      `http://127.0.0.1:${ports[2]}/`,
    );
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
});
