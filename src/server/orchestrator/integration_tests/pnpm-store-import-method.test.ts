/**
 * docs/276 H3 — the executable contract for `package-import-method=copy`.
 *
 * Runs real pnpm against a local registry, so it measures pnpm's behaviour rather than a
 * model of it. The hole is that pnpm hardlinks store files into `node_modules`, so a write
 * to the shared store changes files another session has *already installed* (req 4), with
 * no install event to verify. Copies give each session its own inode.
 *
 * Every fix cell has a control that runs pnpm's default import method and shows the write
 * does propagate, so a cell cannot pass because the attack was a no-op.
 *
 * The store is shared here by env, because that is the one part of the wiring this test
 * cannot take from the orchestrator: `buildEnv` relocates the store with
 * `npm_config_store_dir`, a spelling pnpm >= 11 ignores (measured 2026-09-20 — pnpm 10.28.2
 * reads `npm_config_*`, 11.22.0 and 12.5.1 read only `PNPM_CONFIG_*`). The import method is
 * taken from `buildEnv` verbatim, so the cells fail if that setting is dropped or misspelled.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { buildEnv } from "../container-lifecycle.js";
import type { ContainerConfig } from "../session-container.js";

const run = promisify(execFile);
const PKG = "shipit-h3-probe";
const VERSION = "1.0.0";
const LEGIT = "module.exports = 'legit';\n";
// Same length as LEGIT: an attacker keeps size and mtime so pnpm's fast path stays quiet.
const EVIL = "module.exports = 'EVIL!';\n";
const PNPM_TIMEOUT_MS = 180_000;

/** The container has pnpm on PATH; the CI runner image does not, so fall back to corepack. */
function resolvePnpm(): string[] | null {
  for (const cmd of [["pnpm"], ["corepack", "pnpm@12.5.1"]]) {
    try {
      execFileSync(cmd[0], [...cmd.slice(1), "--version"], {
        stdio: "ignore",
        env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
      });
      return cmd;
    } catch {
      /* Try the next candidate. */
    }
  }
  return null;
}

const pnpmCmd = resolvePnpm();
if (!pnpmCmd) {
  console.warn("[docs/276 H3] no pnpm and no corepack — the import-method contract is NOT covered here");
}

function containerConfig(): ContainerConfig {
  return {
    sessionId: "sess-h3",
    sessionDir: "/state/sessions/sess-h3",
    workspaceDir: "/workspace",
    pnpmStoreDir: "/state/pnpm-store/deadbeefcafe0001",
  } as ContainerConfig;
}

/** The orchestrator's own import-method setting, whichever spelling(s) it ships. */
function importMethodEnv(): Record<string, string> {
  const entries = buildEnv(containerConfig(), "/workspace", 9100, undefined, undefined)
    .filter((e) => /^[A-Za-z_]*package.import.method=/i.test(e))
    .map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)] as const);
  expect(entries.length, "buildEnv sets no pnpm import method").toBeGreaterThan(0);
  return Object.fromEntries(entries);
}

let root: string;
let server: http.Server;
let registry: string;
let tgz: Buffer;
let integrity: string;
let storeSeq = 0;

function tarball(dir: string): void {
  fs.mkdirSync(path.join(dir, "package"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package", "package.json"),
    JSON.stringify({ name: PKG, version: VERSION, main: "index.js" }),
  );
  fs.writeFileSync(path.join(dir, "package", "index.js"), LEGIT);
  const out = `${dir}.tgz`;
  execFileSync("tar", ["-czf", out, "-C", dir, "package"], { stdio: "ignore" });
  tgz = fs.readFileSync(out);
  integrity = `sha512-${crypto.createHash("sha512").update(tgz).digest("base64")}`;
}

function project(name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: `probe-${name}`, version: "1.0.0", dependencies: { [PKG]: VERSION } }),
  );
  return dir;
}

/** A store per cell: a warm store from an earlier cell would hide a cold-install difference. */
function freshStore(): string {
  const dir = path.join(root, `store-${++storeSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Pinned rather than left to pnpm's default: `auto` clones on a reflink filesystem, which
 *  would make the attack controls measure the host's storage instead of the hardlink they
 *  exist to demonstrate. ext4's default is hardlink (plan.md section 2). */
const HARDLINK_IMPORT = {
  npm_config_package_import_method: "hardlink",
  PNPM_CONFIG_PACKAGE_IMPORT_METHOD: "hardlink",
};

async function pnpmInstall(dir: string, storeDir: string, extra: Record<string, string>): Promise<string> {
  const [bin, ...prefix] = pnpmCmd!;
  // Drop an inherited import method: `extra` sets its own spelling, and leaving the other one
  // in place would let the host decide which method a cell actually measured.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/package.import.method/i.test(k)),
  );
  const env: NodeJS.ProcessEnv = {
    ...inherited,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    // Both spellings, so the store is shared whatever pnpm the host resolves.
    npm_config_store_dir: storeDir,
    PNPM_CONFIG_STORE_DIR: storeDir,
    // No host config may decide the import method for us.
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    npm_config_userconfig: path.join(root, "empty-npmrc"),
    ...extra,
  };
  try {
    const { stdout, stderr } = await run(
      bin,
      [...prefix, "install", "--registry", registry, "--no-frozen-lockfile", "--ignore-scripts"],
      { cwd: dir, env, encoding: "utf-8" },
    );
    return `${stdout}${stderr}`;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    throw new Error(`pnpm install failed in ${dir}:\n${e.stdout ?? ""}${e.stderr ?? ""}`, { cause: err });
  }
}

function installedFile(dir: string): string {
  const virtual = path.join(dir, "node_modules", ".pnpm");
  const entry = fs.readdirSync(virtual).find((e) => e.startsWith(`${PKG}@`));
  expect(entry, `no ${PKG} under ${virtual}`).toBeTruthy();
  return path.join(virtual, entry!, "node_modules", PKG, "index.js");
}

/** Content-addressed identification: the store keys files by their own digest, so match on it. */
function storeBlob(storeDir: string, content: string): string {
  const want = crypto.createHash("sha512").update(content).digest("hex");
  const walk = (dir: string): string | null => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        const hit = walk(p);
        if (hit) return hit;
      } else if (e.isFile() && crypto.createHash("sha512").update(fs.readFileSync(p)).digest("hex") === want) {
        return p;
      }
    }
    return null;
  };
  const hit = walk(storeDir);
  expect(hit, `no store entry holds the probe's content under ${storeDir}`).toBeTruthy();
  return hit!;
}

/** Overwrite in place, keeping size and mtime — the poison pnpm's fast path does not re-hash. */
function poisonInPlace(file: string): void {
  const stat = fs.statSync(file);
  fs.writeFileSync(file, EVIL);
  fs.utimesSync(file, stat.atime, stat.mtime);
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-h3-"));
  fs.writeFileSync(path.join(root, "empty-npmrc"), "");
  tarball(path.join(root, "probe"));

  server = http.createServer((req, res) => {
    if (req.url === `/${PKG}`) {
      const body = Buffer.from(JSON.stringify({
        name: PKG,
        "dist-tags": { latest: VERSION },
        // pnpm's minimum-release-age gate reads `time`; an old date keeps the probe installable.
        time: { created: "2020-01-01T00:00:00.000Z", modified: "2020-01-01T00:00:00.000Z", [VERSION]: "2020-01-01T00:00:00.000Z" },
        versions: {
          [VERSION]: {
            name: PKG,
            version: VERSION,
            main: "index.js",
            dist: { tarball: `${registry}${PKG}/-/${PKG}-${VERSION}.tgz`, integrity },
          },
        },
      }));
      res.writeHead(200, { "content-type": "application/json", "content-length": String(body.length) });
      res.end(body);
      return;
    }
    if (req.url === `/${PKG}/-/${PKG}-${VERSION}.tgz`) {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(tgz.length) });
      res.end(tgz);
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
});

describe.skipIf(!pnpmCmd)("Integration: pnpm store import method (docs/276 H3)", () => {
  it("CONTROL: a hardlink import lets a store write change an installed file", async () => {
    const store = freshStore();
    const victim = project("control-victim");
    await pnpmInstall(victim, store, HARDLINK_IMPORT);
    const file = installedFile(victim);
    expect(fs.readFileSync(file, "utf-8")).toBe(LEGIT);

    poisonInPlace(storeBlob(store, LEGIT));

    // The hole, measured: no install ran in the victim, and its code changed anyway.
    expect(fs.readFileSync(file, "utf-8")).toBe(EVIL);
    expect(fs.statSync(file).nlink).toBeGreaterThan(1);
  }, PNPM_TIMEOUT_MS);

  it("FIX: a store write cannot reach a file another session already installed (reqs 1, 4)", async () => {
    const store = freshStore();
    const attacker = project("fix-attacker");
    const victim = project("fix-victim");
    const method = importMethodEnv();
    await pnpmInstall(victim, store, method);
    await pnpmInstall(attacker, store, method);
    const file = installedFile(victim);
    expect(fs.readFileSync(file, "utf-8")).toBe(LEGIT);

    const blob = storeBlob(store, LEGIT);
    poisonInPlace(blob);

    // Non-vacuity: the attacker's write landed, it just has nowhere to go.
    expect(fs.readFileSync(blob, "utf-8")).toBe(EVIL);
    expect(fs.readFileSync(file, "utf-8")).toBe(LEGIT);
    expect(fs.statSync(file).nlink).toBe(1);
  }, PNPM_TIMEOUT_MS);

  it("CONTROL: a hardlink import leaks an edit inside installed packages between sessions", async () => {
    const store = freshStore();
    const a = project("control-edit-a");
    const b = project("control-edit-b");
    await pnpmInstall(a, store, HARDLINK_IMPORT);
    await pnpmInstall(b, store, HARDLINK_IMPORT);

    poisonInPlace(installedFile(a));

    expect(fs.readFileSync(installedFile(b), "utf-8")).toBe(EVIL);
  }, PNPM_TIMEOUT_MS);

  it("req 11: an edit inside one session's installed packages stays invisible to another", async () => {
    const store = freshStore();
    const a = project("edit-a");
    const b = project("edit-b");
    const method = importMethodEnv();
    await pnpmInstall(a, store, method);
    await pnpmInstall(b, store, method);

    // A patch-package-style fix: rewrite the file in the session's own node_modules.
    poisonInPlace(installedFile(a));

    expect(fs.readFileSync(installedFile(a), "utf-8")).toBe(EVIL);
    expect(fs.readFileSync(installedFile(b), "utf-8")).toBe(LEGIT);
    // The edit did not reach the shared store either, so a later session installs it clean.
    expect(fs.readFileSync(storeBlob(store, LEGIT), "utf-8")).toBe(LEGIT);
  }, PNPM_TIMEOUT_MS);

  /**
   * The upgrade gap, measured rather than assumed: the setting governs an *import*, and a
   * tree pnpm considers up to date is not re-imported. So a session that installed before
   * this change keeps its hardlinks — reqs 4 and 11 are met for it only after the tree is
   * removed and rebuilt. The cell fails if pnpm ever starts repairing the tree in place,
   * which is when the caveat in shipit-docs and plan.md section 2 can go.
   */
  it("GAP: a tree installed under hardlink stays hardlinked until node_modules is removed", async () => {
    const store = freshStore();
    const dir = project("upgrade");
    await pnpmInstall(dir, store, HARDLINK_IMPORT);
    expect(fs.statSync(installedFile(dir)).nlink).toBeGreaterThan(1);
    const method = importMethodEnv();

    await pnpmInstall(dir, store, method);
    expect(fs.statSync(installedFile(dir)).nlink, "a reinstall re-imported the tree").toBeGreaterThan(1);

    fs.rmSync(path.join(dir, "node_modules"), { recursive: true, force: true });
    await pnpmInstall(dir, store, method);

    expect(fs.statSync(installedFile(dir)).nlink).toBe(1);
  }, PNPM_TIMEOUT_MS);
});
