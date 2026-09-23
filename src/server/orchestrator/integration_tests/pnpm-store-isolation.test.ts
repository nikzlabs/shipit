/**
 * docs/276 section 5 — the executable contract for the two surfaces a pnpm session shares with
 * other sessions: its **store** (now private) and the verified **base** (read-only lower).
 *
 * The store cells run real pnpm against a local registry, so they measure pnpm's behaviour rather
 * than a model of it. The attack is H4, the one `verify-store-integrity` cannot see: the store's
 * index decides which bytes a package resolves to, so an attacker whose content is already in the
 * store legitimately — manifest intact, every blob hashing to its own name — only has to rename
 * the row onto the integrity everyone else asks for. Measured 2026-09-21 on pnpm 12.5.1 (see
 * FINDINGS.md): it fires against a shared store, and pnpm's own `strictStorePkgContentCheck`
 * does not catch it, because nothing about the entry is inconsistent.
 *
 * The store paths come from `sessionPnpmStoreDir`, so the fix cell goes red if the store ever
 * goes back to a path two sessions share; its control runs the identical attack against one
 * shared store and shows the victim installing the attacker's code.
 *
 * The base cell covers what the ORCHESTRATOR wires: the base is every session's lowerdir and no
 * session's upper. The kernel half — that a write through the mount copies up instead of
 * reaching the base — is a property of overlayfs, measured on the services host by
 * `store-overlay-spike.sh` and `tree-overlay-spike.sh` (FINDINGS.md); it cannot run here, since
 * a session container has no Docker socket and cannot mount an overlay. That cell asserts the
 * mount SHAPE through `buildOverlaySpecs`; which sessions are selected for a base is the selection
 * gate's own test. The last describe covers planning#606's bin seed against real pnpm.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

import { buildMounts } from "../container-lifecycle.js";
import { overlayDriverOpts } from "../overlay-volume.js";
import {
  buildOverlaySpecs,
  PNPM_BASE_DEP_DIR,
  PNPM_VERIFIED_NAMESPACE,
  sessionPnpmStoreDir,
  type DepDirOverlaySpec,
} from "../overlay-session.js";
import { resolvePnpmBinSeedSet, seedBinTargetsIntoUpper } from "../overlay-bin-seed.js";
import { MIN_VERIFIED_BASE_PNPM_MAJOR } from "../../shared/pnpm-repo.js";
import type { ContainerConfig } from "../session-container.js";

const run = promisify(execFile);
const PKG = "shipit-h4-probe";
const VERSION = "1.0.0";
const LEGIT = "module.exports = 'legit';\n";
const EVIL = "module.exports = 'EVIL!';\n";
const PNPM_TIMEOUT_MS = 300_000;

/**
 * The version the builder pins is tried FIRST, so a session container (which has pnpm on PATH)
 * and the CI runner (which does not) take the same path, and the floor is the code's own
 * `MIN_VERIFIED_BASE_PNPM_MAJOR` rather than a version this contract is tied to.
 */
const PNPM_PIN = "12.4.1";
const COREPACK_CACHE = path.join(os.tmpdir(), `pnpm-iso-corepack-${process.pid}`);

function resolvePnpm(): string[] | null {
  for (const cmd of [["corepack", `pnpm@${PNPM_PIN}`], ["pnpm"]]) {
    try {
      const version = execFileSync(cmd[0], [...cmd.slice(1), "--version"], {
        encoding: "utf-8",
        env: { ...process.env, COREPACK_HOME: COREPACK_CACHE, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
      }).trim();
      if (parseInt(version, 10) >= MIN_VERIFIED_BASE_PNPM_MAJOR) return cmd;
    } catch {
      /* Try the next candidate. */
    }
  }
  return null;
}

const pnpmCmd = resolvePnpm();
if (!pnpmCmd) {
  console.warn(
    `[docs/276 section 5] no pnpm >= ${MIN_VERIFIED_BASE_PNPM_MAJOR} and no corepack — ` +
    "the store-isolation contract is NOT covered here",
  );
}

interface Artifact { tgz: Buffer; integrity: string }

let root: string;
let server: http.Server;
let registry: string;
let legit: Artifact;
let evil: Artifact;
/** The registry serves ONE of them at a time: the attacker's session installs before the flip. */
let serving: Artifact;

function tarball(body: string): Artifact {
  const dir = fs.mkdtempSync(path.join(root, "tgz-"));
  fs.mkdirSync(path.join(dir, "package"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package", "package.json"),
    JSON.stringify({ name: PKG, version: VERSION, main: "index.js" }),
  );
  fs.writeFileSync(path.join(dir, "package", "index.js"), body);
  const out = path.join(dir, "out.tgz");
  execFileSync("tar", ["-czf", out, "-C", dir, "package"], { stdio: "ignore" });
  const tgz = fs.readFileSync(out);
  return { tgz, integrity: `sha512-${crypto.createHash("sha512").update(tgz).digest("base64")}` };
}

function project(name: string): string {
  const dir = path.join(root, "projects", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: `probe-${name}`, version: "1.0.0", dependencies: { [PKG]: VERSION } }),
  );
  return dir;
}

/**
 * One session's install. `metadataCacheFor` gives each session its own `XDG_CACHE_HOME`, which
 * is what a session container has (its home is the container's own filesystem, never a bind) —
 * so a cell can never pass because one session read another's resolution metadata.
 */
async function install(dir: string, storeDir: string, sessionId: string): Promise<string> {
  const [bin, ...prefix] = pnpmCmd!;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    COREPACK_HOME: COREPACK_CACHE,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    XDG_CACHE_HOME: path.join(root, "caches", sessionId),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    npm_config_userconfig: path.join(root, "empty-npmrc"),
  };
  try {
    const { stdout, stderr } = await run(
      bin,
      [
        ...prefix, "install",
        "--store-dir", storeDir,
        "--registry", registry,
        "--no-frozen-lockfile", "--ignore-scripts",
      ],
      { cwd: dir, env, encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 },
    );
    return `${stdout}${stderr}`;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    throw new Error(`pnpm install failed in ${dir}:\n${e.stdout ?? ""}${e.stderr ?? ""}`, { cause: err });
  }
}

function installed(dir: string): string {
  return fs.readFileSync(path.join(dir, "node_modules", PKG, "index.js"), "utf-8");
}

/**
 * The H4 rewrite, done to the store's own index: the row pnpm's writer produced for the EVIL
 * tarball is renamed onto the LEGIT tarball's integrity. Every check pnpm makes still passes —
 * the manifest's name and version are right and each file hashes to its own digest — so what
 * changes is only which bytes that integrity now names.
 */
function rewriteManifestKey(storeDir: string): void {
  const indexDb = path.join(storeDir, "v11", "index.db");
  expect(fs.existsSync(indexDb), `no store index at ${indexDb}`).toBe(true);
  const db = new DatabaseSync(indexDb);
  try {
    const keys = (db.prepare("select key from package_index").all() as { key: string }[])
      .map((r) => r.key)
      .filter((k) => k.includes(`${PKG}@${VERSION}`));
    expect(keys, "the attacker's store holds no entry to rewrite").toHaveLength(1);
    expect(keys[0].startsWith(evil.integrity), "the store entry is not the EVIL tarball's").toBe(true);
    db.prepare("update package_index set key=? where key=?")
      .run(`${legit.integrity}\t${PKG}@${VERSION}`, keys[0]);
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-iso-"));
  fs.writeFileSync(path.join(root, "empty-npmrc"), "");
  legit = tarball(LEGIT);
  evil = tarball(EVIL);
  serving = evil;

  server = http.createServer((req, res) => {
    const url = (req.url ?? "").split("?")[0];
    if (url === `/${PKG}`) {
      const body = Buffer.from(JSON.stringify({
        name: PKG,
        "dist-tags": { latest: VERSION },
        // pnpm's minimum-release-age gate reads `time`; an old date keeps the probe installable.
        time: {
          created: "2020-01-01T00:00:00.000Z",
          modified: "2020-01-01T00:00:00.000Z",
          [VERSION]: "2020-01-01T00:00:00.000Z",
        },
        versions: {
          [VERSION]: {
            name: PKG,
            version: VERSION,
            main: "index.js",
            dist: {
              tarball: `${registry}${PKG}/-/${PKG}-${VERSION}.tgz`,
              integrity: serving.integrity,
            },
          },
        },
      }));
      res.writeHead(200, { "content-type": "application/json", "content-length": String(body.length) });
      res.end(body);
      return;
    }
    if (url === `/${PKG}/-/${PKG}-${VERSION}.tgz`) {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(serving.tgz.length),
      });
      res.end(serving.tgz);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (root) fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(COREPACK_CACHE, { recursive: true, force: true });
});

describe.skipIf(!pnpmCmd)("Integration: pnpm store isolation (docs/276 section 5)", () => {
  /**
   * The attack, against the shape ShipIt had before the per-session store. Without this cell the
   * fix cell could pass because the rewrite did nothing.
   */
  it("CONTROL: a manifest rewrite in a SHARED store reaches another session's install", async () => {
    const shared = path.join(root, "shared-store");
    const attacker = project("control-attacker");
    const victim = project("control-victim");

    serving = evil;
    await install(attacker, shared, "control-a");
    expect(installed(attacker)).toBe(EVIL);

    // From here the registry serves only the legitimate package: the victim asks for nothing else.
    serving = legit;
    rewriteManifestKey(shared);

    await install(victim, shared, "control-b");
    expect(installed(victim), "the attack did not fire, so the fix cell would prove nothing").toBe(EVIL);
  }, PNPM_TIMEOUT_MS);

  it("FIX: a manifest rewrite in one session's private store cannot reach another (reqs 1, 3, 6)", async () => {
    const stateDir = path.join(root, "state");
    const attackerStore = sessionPnpmStoreDir(stateDir, "sess-attacker");
    const victimStore = sessionPnpmStoreDir(stateDir, "sess-victim");
    expect(attackerStore).not.toBe(victimStore);

    const attacker = project("fix-attacker");
    const victim = project("fix-victim");

    serving = evil;
    await install(attacker, attackerStore, "fix-a");
    serving = legit;
    rewriteManifestKey(attackerStore);

    // Non-vacuity: the poisoned index is live. The control's exact flow, run against the
    // ATTACKER's store — a session asking for the legitimate integrity still gets the attacker's
    // bytes, so the victim below is clean because of the store boundary and nothing else.
    const sharesTheStore = project("fix-attacker-2");
    await install(sharesTheStore, attackerStore, "fix-a2");
    expect(installed(sharesTheStore), "the rewrite did not take effect in the attacker's store").toBe(EVIL);

    await install(victim, victimStore, "fix-b");
    expect(installed(victim)).toBe(LEGIT);
    // And nothing of the attacker's reached the victim's store either.
    expect(fs.existsSync(path.join(attackerStore, "v11", "index.db"))).toBe(true);
    expect(fs.existsSync(path.join(victimStore, "v11", "index.db"))).toBe(true);
  }, PNPM_TIMEOUT_MS);
});

describe("the verified base is shared read-only, never a session's writable dir (docs/276)", () => {
  const SCOPE = { repoUrl: "git@github.com:acme/app.git", runtimeKey: "node24-pinabc" };

  function specFor(sessionId: string, volumeMountpoint = "/var/lib/docker/volumes/shipit-ws/_data") {
    return buildOverlaySpecs({
      sessionId,
      scope: SCOPE,
      depDirs: [PNPM_BASE_DEP_DIR],
      volumeMountpoint,
      namespace: PNPM_VERIFIED_NAMESPACE,
      generationForScope: () => 4,
    })[0];
  }

  /**
   * A write to the base would reach every session that mounts it, so the base may only ever be
   * the lowerdir. Non-vacuity comes first: the two sessions must really be sharing one base, or
   * "isolated" would be true of two unrelated directories.
   */
  it("gives two sessions one shared lowerdir and their own upper and work dirs", () => {
    const idA = "11111111-1111-4111-8111-111111111111";
    const idB = "22222222-2222-4222-8222-222222222222";
    const a = specFor(idA);
    const b = specFor(idB);

    expect(a.lowerdir).toBe(b.lowerdir);
    expect(a.lowerdir).toContain(`overlay-base/${a.scopeHash}/g4`);

    for (const [id, spec] of [[idA, a], [idB, b]] as const) {
      expect(spec.upperdir.startsWith(spec.lowerdir)).toBe(false);
      expect(spec.workdir.startsWith(spec.lowerdir)).toBe(false);
      expect(spec.upperdir).toContain(`sessions/${id}/`);
    }
    expect(a.upperdir).not.toBe(b.upperdir);
    expect(a.workdir).not.toBe(b.workdir);

    // The driver options are where a mis-wiring would land: the base named as `upperdir=` would
    // make every session's install write into the tree every other session reads.
    const optsA = overlayDriverOpts(a);
    const optsB = overlayDriverOpts(b);
    expect(optsA).toContain(`lowerdir=${a.lowerdir},`);
    expect(optsB).toContain(`lowerdir=${a.lowerdir},`);
    expect(optsA).not.toContain(`upperdir=${a.lowerdir}`);
    expect(optsB).not.toContain(`upperdir=${a.lowerdir}`);
  });

  const SESSION_ID = "33333333-3333-4333-8333-333333333333";
  const WORKSPACE_VOLUME = "shipit-workspace";

  function configFor(spec: DepDirOverlaySpec): ContainerConfig {
    return {
      sessionId: SESSION_ID,
      sessionDir: "/workspace/sessions/s3",
      workspaceDir: "/workspace/sessions/s3/workspace",
      sessionStateDir: "/workspace/sessions/s3/state",
      credentialsDir: "/workspace/credentials",
      depCacheDir: "/workspace/dep-cache/abc123",
      pnpmStoreDir: "/workspace/sessions/s3/overlay/pnpm-store",
      imageName: "shipit-worker:test",
      overlaySpecs: [spec],
    } as ContainerConfig;
  }

  /**
   * Whether mounting `mounted` would give the session any part of `base`. All three shapes count,
   * and the third is the one an ancestor-only check misses: a mount of the generation directory
   * itself, or of something inside it, hands over the shared tree just as surely as a mount of the
   * directory above it.
   */
  function reaches(mounted: string, base: string): boolean {
    if (mounted === "") return true;
    return mounted === base || base.startsWith(`${mounted}/`) || mounted.startsWith(`${base}/`);
  }

  /** The three shapes that would expose the generation, all of which `reaches` must reject. */
  function exposureShapes(base: string): string[] {
    return ["", path.dirname(base), base, path.join(base, "node_modules")];
  }

  it("never binds the base generation into the container (bind layout)", () => {
    // The state root is under /workspace in this layout, so the base and the session's own
    // directories share a root and the path comparison below can actually match.
    const spec = specFor(SESSION_ID, "/workspace");
    const { binds, mounts } = buildMounts(configFor(spec), undefined, undefined, [spec]);

    // The dep dir reaches the container as the overlay VOLUME and by no other route.
    expect(mounts.filter((m) => m.Target === spec.mountPath))
      .toEqual([{ Type: "volume", Source: spec.volumeName, Target: spec.mountPath }]);
    const sources = [
      ...binds.map((b) => b.split(":")[0]),
      ...mounts.filter((m) => m.Type === "bind").map((m) => m.Source),
    ];
    expect(sources.some((s) => s.startsWith("/workspace/")), "fixture shares no root with the base").toBe(true);
    for (const source of sources) {
      expect(reaches(source, spec.lowerdir), `${source} exposes the overlay base`).toBe(false);
    }
    for (const shape of exposureShapes(spec.lowerdir)) {
      expect(reaches(shape, spec.lowerdir), `${shape} should count as exposure`).toBe(true);
    }
  });

  /**
   * The production layout, which the bind cell above does not exercise: every mount is the SAME
   * workspace volume, and the base lives inside that volume too — so a `Subpath` is the only thing
   * confining a session to its own subtree. A mount with no Subpath, one naming a directory above
   * the base, or one naming the generation itself would each hand over the shared base read-write.
   */
  it("confines every workspace-volume mount to a subpath that cannot reach the base", () => {
    const spec = specFor(SESSION_ID);
    const { binds, mounts } = buildMounts(configFor(spec), WORKSPACE_VOLUME, "shipit-credentials", [spec]);

    expect(binds, "the volume layout must not fall back to binds").toEqual([]);
    const volumeMounts = mounts.filter((m) => m.Source === WORKSPACE_VOLUME);
    expect(volumeMounts.length).toBeGreaterThan(0);

    // The generation's path relative to the volume root, which is what a Subpath is measured against.
    const volumeRoot = spec.lowerdir.slice(0, spec.lowerdir.indexOf("/overlay-base/"));
    const baseSubpath = spec.lowerdir.slice(volumeRoot.length + 1);
    expect(baseSubpath.startsWith("overlay-base/")).toBe(true);

    for (const mount of volumeMounts) {
      const subpath = mount.VolumeOptions?.Subpath;
      expect(subpath, `${mount.Target} mounts the whole workspace volume`).toBeTruthy();
      expect(reaches(subpath!, baseSubpath), `${mount.Target} reaches the base at ${subpath}`).toBe(false);
    }

    for (const shape of exposureShapes(baseSubpath)) {
      expect(reaches(shape, baseSubpath), `${shape} should count as exposure`).toBe(true);
    }
  });
});

/**
 * planning#606 — the seed set, measured against pnpm rather than against a model of it.
 *
 * Any install that relinks `.bin` chmods every executable target **unconditionally**, and over a
 * mounted base those targets are lower files the session does not own, so `pnpm add` dies with
 * `ERR_PNPM_CMD_SHIM_CHMOD` … `Operation not permitted` (docs/276 req 9). The repair pre-copies
 * each target into the session's upper; what makes it work is that the list is COMPLETE, so the
 * cell below asserts that it contains every target pnpm's own shims name.
 *
 * The EPERM itself needs a real overlay under two uids and lives in
 * `docs/276-shared-package-cache-integrity/ineligible-sharing-host-spike.sh`; a session container
 * has no Docker socket and cannot mount one.
 */
describe.skipIf(!pnpmCmd)("Integration: the pnpm bin seed (planning#606)", () => {
  /** A package as a `file:` tarball, so the cell needs no registry entry of its own. */
  function packTarball(name: string, manifest: object, files: Record<string, string>): string {
    const staging = fs.mkdtempSync(path.join(root, `pack-${name}-`));
    const pkgDir = path.join(staging, "package");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name, version: "1.0.0", ...manifest }),
    );
    for (const [rel, body] of Object.entries(files)) {
      const file = path.join(pkgDir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
      fs.chmodSync(file, 0o755);
    }
    const out = path.join(staging, `${name}.tgz`);
    execFileSync("tar", ["-czf", out, "-C", staging, "package"], { stdio: "ignore" });
    return out;
  }

  /** Every executable pnpm linked, resolved through the trailer its own shim writer leaves. */
  function shimTargets(treeRoot: string): string[] {
    const shimDirs: string[] = [];
    const walk = (dir: string, depth: number): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === ".bin") shimDirs.push(path.join(dir, entry.name));
        else if (depth < 5) walk(path.join(dir, entry.name), depth + 1);
      }
    };
    walk(treeRoot, 0);
    const targets = new Set<string>();
    for (const shimDir of shimDirs) {
      for (const entry of fs.readdirSync(shimDir, { withFileTypes: true })) {
        if (entry.name.endsWith(".cmd") || entry.name.endsWith(".ps1")) continue;
        const shim = path.join(shimDir, entry.name);
        if (entry.isSymbolicLink()) {
          targets.add(path.relative(treeRoot, fs.realpathSync(shim)));
          continue;
        }
        const trailer = /# cmd-shim-target=(.*)/.exec(fs.readFileSync(shim, "utf8"));
        expect(trailer, `${shim} names no target, so this cell can no longer read pnpm's set`).toBeTruthy();
        targets.add(path.relative(treeRoot, fs.realpathSync(trailer![1].trim())));
      }
    }
    return [...targets].sort();
  }

  it("covers every file pnpm links, and copies them into the upper unchanged", async () => {
    // The shapes that decide the rule, each measured against pnpm's own shims: `directories.bin`
    // is enumerated RECURSIVELY (a file four levels down gets a shim), an empty-string `bin` falls
    // through to it, and a non-empty `bin` takes precedence over it.
    const binMap = packTarball(
      "probe-binmap",
      { bin: { "probe-a": "bin/a.js", "probe-b": "bin/b.js" } },
      { "bin/a.js": "#!/usr/bin/env node\na\n", "bin/b.js": "#!/usr/bin/env node\nb\n" },
    );
    const dirBin = packTarball(
      "probe-dirbin",
      { directories: { bin: "tools" } },
      { "tools/t.js": "#!/usr/bin/env node\nt\n", "tools/a/b/c/deep.js": "#!/usr/bin/env node\nd\n" },
    );
    const emptyBin = packTarball(
      "probe-emptybin",
      { bin: "", directories: { bin: "tools" } },
      { "tools/e.js": "#!/usr/bin/env node\ne\n" },
    );
    const both = packTarball(
      "probe-both",
      { bin: "cli.js", directories: { bin: "tools" } },
      { "cli.js": "#!/usr/bin/env node\nc\n", "tools/x.js": "#!/usr/bin/env node\nx\n" },
    );
    const noBin = packTarball("probe-nobin", { main: "index.js" }, { "index.js": "module.exports = 1;\n" });

    const dir = path.join(root, "projects", "bin-seed");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
      name: "probe-bin-seed",
      version: "1.0.0",
      dependencies: {
        "probe-binmap": `file:${binMap}`,
        "probe-dirbin": `file:${dirBin}`,
        "probe-emptybin": `file:${emptyBin}`,
        "probe-both": `file:${both}`,
        "probe-nobin": `file:${noBin}`,
      },
    }));
    await install(dir, sessionPnpmStoreDir(path.join(root, "state"), "sess-bin-seed"), "bin-seed");

    const tree = path.join(dir, "node_modules");
    const seedSet = resolvePnpmBinSeedSet(tree);
    const linked = shimTargets(tree);

    // Non-vacuity first: an empty shim set would make the containment below pass for free.
    expect(linked.length).toBeGreaterThan(0);
    // The property that matters is CONTAINMENT, not equality. A target pnpm links and the seed
    // misses stays in the foreign-owned lower and `pnpm add` EPERMs on it; a file the seed copies
    // and pnpm never touches costs one byte-identical copy. `probe-both/tools/x.js` is the second
    // case on this very tree — pnpm ignores `directories.bin` when `bin` is set, and the seed takes
    // it anyway rather than encoding that precedence.
    expect(seedSet, "the seed misses something pnpm linked").toEqual(expect.arrayContaining(linked));
    // The recursive `directories.bin` file is the one a non-recursive walk loses; assert pnpm links
    // it, so this stays a real check rather than a tautology about our own resolver.
    const deep = linked.find((f) => f.endsWith(path.join("a", "b", "c", "deep.js")));
    expect(deep, "pnpm no longer shims a nested directories.bin file").toBeTruthy();
    expect(linked.some((f) => f.includes("probe-emptybin"))).toBe(true);
    expect(seedSet.some((f) => f.includes("probe-nobin"))).toBe(false);

    // The upper the session would get, with one entry already in it: the agent's own edit to a
    // dependency (req 11), which the seed must leave exactly as it is.
    const upper = path.join(root, "bin-seed-upper");
    const edited = seedSet.find((f) => f.includes("probe-binmap"))!;
    fs.mkdirSync(path.join(upper, path.dirname(edited)), { recursive: true });
    fs.writeFileSync(path.join(upper, edited), "the agent's own edit\n");

    const result = seedBinTargetsIntoUpper({ lowerdir: tree, upperdir: upper, owner: null });

    expect(result).toMatchObject({ files: seedSet.length - 1, present: 1, failed: 0 });
    expect(fs.readFileSync(path.join(upper, edited), "utf8")).toBe("the agent's own edit\n");
    for (const rel of seedSet.filter((f) => f !== edited)) {
      expect(fs.readFileSync(path.join(upper, rel))).toEqual(fs.readFileSync(path.join(tree, rel)));
      expect(fs.lstatSync(path.join(upper, rel)).mode & 0o7777)
        .toBe(fs.lstatSync(path.join(tree, rel)).mode & 0o7777);
    }
  }, PNPM_TIMEOUT_MS);
});
