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
 *   builder by three routes, and each needs its own switch.
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
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

import { BUILD_REGISTRY_SERVER, builderEnv, builderScript } from "../pnpm-base-builder.js";
import { sha512Integrity, stageVerifiedRegistry, type FetchLike } from "../pnpm-base-registry.js";

const run = promisify(execFile);
const PNPM_TIMEOUT_MS = 300_000;
const LEAF = "shipit-base-leaf";
const ROOT = "shipit-base-root";
const VERSION = "1.0.0";

/** The builder bakes a pnpm 12; any pnpm 12 shows the behaviour this pins. */
const PNPM_PIN = "12.4.1";
function resolvePnpm(): string[] | null {
  for (const cmd of [["pnpm"], ["corepack", `pnpm@${PNPM_PIN}`]]) {
    try {
      const version = execFileSync(cmd[0], [...cmd.slice(1), "--version"], {
        encoding: "utf-8",
        env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
      }).trim();
      if (parseInt(version, 10) >= 12) return cmd;
    } catch {
      /* Try the next candidate. */
    }
  }
  return null;
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

function envFor(homeDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...Object.fromEntries(builderEnv(homeDir).map((e) => e.split(/=(.*)/s).slice(0, 2))),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  };
}

const pnpmCmd = resolvePnpm();

describe.skipIf(pnpmCmd === null)("docs/276 section 5 — verified-base builder", () => {
  let tmp: string;
  let registryDir: string;
  let projectDir: string;
  let storeDir: string;
  let homeDir: string;
  const port = 14873 + (process.pid % 1000);
  const tarballs = new Map<string, Buffer>();

  beforeAll(async () => {
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
    tarballs.set(
      `${ROOT}@${VERSION}`,
      makeTarball(
        tmp,
        ROOT,
        {
          name: ROOT,
          version: VERSION,
          main: "index.js",
          bin: { [ROOT]: "./cli.js" },
          dependencies: { [LEAF]: VERSION },
        },
        { "index.js": "module.exports = 'root';\n", "cli.js": "#!/usr/bin/env node\n" },
      ),
    );

    // The orchestrator's side: resolve and verify against a registry it controls. The fixture
    // stands in for that registry; everything downstream of it is what is under test.
    const fixtureFetch: FetchLike = (url) => {
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

    const staged = await stageVerifiedRegistry({
      packages: [ROOT, LEAF].map((name) => ({
        key: `${name}@${VERSION}`,
        name,
        version: VERSION,
        integrity: sha512Integrity(tarballs.get(`${name}@${VERSION}`)!),
      })),
      destDir: registryDir,
      registryUrl: "https://fixture.test/",
      builderRegistryUrl: `http://127.0.0.1:${port}/`,
      fetchImpl: fixtureFetch,
    });
    expect(staged.ok).toBe(true);
    fs.writeFileSync(path.join(registryDir, "server.mjs"), BUILD_REGISTRY_SERVER);

    writeProject(projectDir);
  }, PNPM_TIMEOUT_MS);

  /** The committed inputs: a repo pin the builder must ignore, and the graph it must follow. */
  function writeProject(dir: string): void {
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

  afterAll(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("builds the whole tree offline from the store the sandbox fetch phase populated", async () => {
    const result = await run(
      "/bin/sh",
      [
        "-c",
        builderScript({
          pnpmBin: pnpmCmd!.join(" "),
          projectDir,
          registryDir,
          storeDir,
          registryUrl: `http://127.0.0.1:${port}/`,
          readyFile: path.join(tmp, "registry.ready"),
        }),
      ],
      { timeout: PNPM_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: envFor(homeDir) },
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

    await expect(
      run(
        "/bin/sh",
        [
          "-c",
          builderScript({
            pnpmBin: pnpmCmd!.join(" "),
            projectDir: thinProject,
            registryDir: thinRegistry,
            storeDir: path.join(scratch, "store"),
            registryUrl: `http://127.0.0.1:${port + 1}/`,
            readyFile: path.join(scratch, "registry.ready"),
          }),
        ],
        {
          timeout: PNPM_TIMEOUT_MS,
          maxBuffer: 16 * 1024 * 1024,
          env: envFor(path.join(scratch, "home")),
        },
      ),
    ).rejects.toThrow();
    expect(fs.existsSync(path.join(thinProject, "node_modules", ROOT))).toBe(false);
  }, PNPM_TIMEOUT_MS);
});
