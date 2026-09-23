/**
 * docs/276 H1 — the executable contract for the npm resolution-cache split.
 *
 * Runs real npm against a local registry, so it measures npm's behaviour rather
 * than a model of it. The attack is the one measured in plan.md: place a tarball
 * carrying a `postinstall` at its own valid hash in the shared `content-v2` (which
 * is self-verifying, so the attacker just computes the hash), then rewrite the
 * cached packument's `dist.integrity` to point at it and set `hasInstallScript`.
 *
 * The control matters as much as the fix: it asserts the attack really works on a
 * shared index, with the registry reachable, so the fix cells cannot pass by accident.
 *
 * The cache is written here by hand rather than through npm's bundled `cacache`,
 * which is exactly the access an attacking session has — group write on the tree.
 *
 * What this cannot cover: every npm here runs as one uid, so it does not exercise
 * req 2's cross-session ownership. That rests on machinery this change does not
 * touch — the entrypoint's `share_cache_with_all_sessions` handoff and its
 * `umask 002` (docs/270). The one part of it the split *could* have broken is the
 * mode of content written across the new mount boundary, where cacache falls back
 * from `rename` to `copyFile`: verified 2026-09-20 that `copyFile` preserves the
 * source's mode (0664 under that umask) exactly as `rename` does.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import {
  linkSessionNpmCache,
  prepareSessionNpmCache,
  sessionNpmCacheDir,
  sharedNpmContentDir,
} from "../../shared/npm-cache.js";

const run = promisify(execFile);
const PKG = "shipit-h1-probe";
const VERSION = "1.0.0";
const NPM_TIMEOUT_MS = 120_000;

interface Blob { data: Buffer; integrity: string }
interface CacheEntry { key: string; integrity: string; time: number; size: number; metadata?: unknown }

// cacache's layout, reimplemented for the attacker side only (lib/content/path.js,
// lib/entry-index.js): content-v2/<algo>/<2>/<2>/<rest> keyed by the bytes' own hash,
// index-v5 buckets keyed by sha256 of the request key, one `<sha1>\t<json>` line each.
const segments = (hex: string): string[] => [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4)];
const hexOf = (integrity: string): string =>
  Buffer.from(integrity.slice(integrity.indexOf("-") + 1), "base64").toString("hex");

function contentPath(cacache: string, integrity: string): string {
  return path.join(cacache, "content-v2", "sha512", ...segments(hexOf(integrity)));
}

function bucketPath(cacache: string, key: string): string {
  const hashed = crypto.createHash("sha256").update(key).digest("hex");
  return path.join(cacache, "index-v5", ...segments(hashed));
}

function readEntry(cacache: string, key: string): CacheEntry {
  const lines = fs.readFileSync(bucketPath(cacache, key), "utf-8").split("\n").filter(Boolean);
  const last = lines[lines.length - 1];
  return JSON.parse(last.slice(last.indexOf("\t") + 1)) as CacheEntry;
}

function appendEntry(cacache: string, entry: CacheEntry): void {
  const json = JSON.stringify(entry);
  const bucket = bucketPath(cacache, entry.key);
  fs.mkdirSync(path.dirname(bucket), { recursive: true });
  fs.appendFileSync(bucket, `\n${crypto.createHash("sha1").update(json).digest("hex")}\t${json}`);
}

function writeContent(cacache: string, blob: Blob): void {
  const target = contentPath(cacache, blob.integrity);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, blob.data);
}

function tarball(dir: string, pkgJson: unknown, body: string): Blob {
  fs.mkdirSync(path.join(dir, "package"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package", "package.json"), JSON.stringify(pkgJson));
  fs.writeFileSync(path.join(dir, "package", "index.js"), body);
  const tgz = `${dir}.tgz`;
  execFileSync("tar", ["-czf", tgz, "-C", dir, "package"], { stdio: "ignore" });
  const data = fs.readFileSync(tgz);
  return { data, integrity: `sha512-${crypto.createHash("sha512").update(data).digest("base64")}` };
}

let root: string;
let depCacheDir: string;
let sharedCacheRoot: string;
let sharedCacache: string;
let server: http.Server;
let registry: string;
let legit: Blob;
let evil: Blob;
let cleanEntry: CacheEntry;
const hits = { packument: 0, tarball: 0 };

function project(name: string, withLockfile: boolean): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { name: `probe-${name}`, version: "1.0.0", private: true };
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest));
  if (withLockfile) {
    fs.writeFileSync(
      path.join(dir, "package-lock.json"),
      JSON.stringify({
        ...manifest,
        lockfileVersion: 3,
        requires: true,
        packages: { "": manifest },
      }),
    );
  }
  return dir;
}

async function npmRun(dir: string, cacheRoot: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await run(
      "npm",
      [...args, "--registry", registry, "--no-audit", "--no-fund", "--foreground-scripts"],
      {
        cwd: dir,
        env: { ...process.env, npm_config_cache: cacheRoot, H1_MARKER: marker() },
        encoding: "utf-8",
      },
    );
    return { ok: true, out: `${stdout}${stderr}` };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const marker = (): string => path.join(root, "PWNED");
const pwned = (): boolean => fs.existsSync(marker());
const packumentKey = (): string => `make-fetch-happen:request-cache:${registry}${PKG}`;

/**
 * The attacker's two writes, both of which the shared tree's group write permits: the
 * evil tarball at its own valid hash, and a packument pointing `dist.integrity` at it.
 * Re-applied per test, because the fix retires the shared index — without this, a later
 * cell could pass simply because no poison was left to resist.
 */
function poisonSharedIndex(): void {
  writeContent(sharedCacache, evil);
  const doc = JSON.parse(
    fs.readFileSync(contentPath(sharedCacache, cleanEntry.integrity), "utf-8"),
  ) as { versions: Record<string, { dist: { integrity: string }; hasInstallScript?: boolean }> };
  doc.versions[VERSION].dist.integrity = evil.integrity;
  doc.versions[VERSION].hasInstallScript = true;
  const body = Buffer.from(JSON.stringify(doc));
  const poisoned: Blob = {
    data: body,
    integrity: `sha512-${crypto.createHash("sha512").update(body).digest("base64")}`,
  };
  writeContent(sharedCacache, poisoned);
  appendEntry(sharedCacache, {
    ...cleanEntry,
    integrity: poisoned.integrity,
    size: body.length,
    time: Date.now(),
  });
}

function sharedIndexIsPoisoned(): boolean {
  try {
    const entry = readEntry(sharedCacache, packumentKey());
    const doc = JSON.parse(fs.readFileSync(contentPath(sharedCacache, entry.integrity), "utf-8")) as {
      versions: Record<string, { dist: { integrity: string } }>;
    };
    return doc.versions[VERSION].dist.integrity === evil.integrity;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "npm-h1-"));
  depCacheDir = path.join(root, "dep-cache", "repohash");
  sharedCacheRoot = path.join(depCacheDir, "npm");
  sharedCacache = path.join(sharedCacheRoot, "_cacache");

  legit = tarball(
    path.join(root, "legit"),
    { name: PKG, version: VERSION, main: "index.js" },
    "module.exports = 'legit';\n",
  );
  evil = tarball(
    path.join(root, "evil"),
    {
      name: PKG,
      version: VERSION,
      main: "index.js",
      scripts: { postinstall: "node -e \"require('fs').writeFileSync(process.env.H1_MARKER,'1')\"" },
    },
    "module.exports = 'evil';\n",
  );

  server = http.createServer((req, res) => {
    if (req.url === `/${PKG}`) {
      hits.packument += 1;
      const body = Buffer.from(JSON.stringify({
        name: PKG,
        "dist-tags": { latest: VERSION },
        versions: {
          [VERSION]: {
            name: PKG,
            version: VERSION,
            main: "index.js",
            dist: { tarball: `${registry}${PKG}/-/${PKG}-${VERSION}.tgz`, integrity: legit.integrity },
          },
        },
      }));
      // A cache entry that is still fresh is what makes H1 work with the network up:
      // npm serves it without revalidating against the registry.
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(body.length),
        "cache-control": "public, max-age=300",
      });
      res.end(body);
      return;
    }
    if (req.url === `/${PKG}/-/${PKG}-${VERSION}.tgz`) {
      hits.tarball += 1;
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(legit.data.length),
      });
      res.end(legit.data);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

  // Seed the shared cache the way this repo's first session would, and keep the clean
  // entry so every cell can be re-poisoned from a known state.
  const seeded = await npmRun(project("seed", true), sharedCacheRoot, ["install", PKG]);
  expect(seeded.ok, seeded.out).toBe(true);
  cleanEntry = readEntry(sharedCacache, packumentKey());
}, NPM_TIMEOUT_MS);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(marker(), { force: true });
  poisonSharedIndex();
  expect(sharedIndexIsPoisoned()).toBe(true);
});

describe("Integration: shared npm cache poisoning (docs/276 H1)", () => {
  it("CONTROL: a shared resolution index runs the attacker's postinstall, registry reachable", async () => {
    const before = hits.packument;
    const res = await npmRun(project("victim-shared-index", true), sharedCacheRoot, ["install", PKG]);

    expect(res.ok, res.out).toBe(true);
    expect(pwned()).toBe(true);
    // The whole hole: npm never asked the registry, so a reachable network is no defence.
    expect(hits.packument).toBe(before);
  }, NPM_TIMEOUT_MS);

  for (const withLockfile of [true, false]) {
    const suffix = withLockfile ? "lock" : "nolock";
    const label = withLockfile ? "with a lockfile present" : "with no lockfile (req 5)";

    it(`FIX: a private resolution index installs the real package ${label}`, async () => {
      // Through the worker's own entry point, with the env the orchestrator sets, so the
      // cell covers the wiring and not just the layout helper.
      const stateDir = path.join(root, `state-${suffix}`);
      const cacheRoot = sessionNpmCacheDir(stateDir);
      const outcome = linkSessionNpmCache(stateDir, depCacheDir, { npm_config_cache: cacheRoot });
      expect(outcome?.shared).toBe(true);
      // Retiring the shared index is hygiene, not the protection. Put the poison back so
      // the private index is what has to resist it, or this cell would pass on an empty
      // shared cache and prove nothing.
      poisonSharedIndex();
      expect(sharedIndexIsPoisoned()).toBe(true);
      const dir = project(`victim-private-${suffix}`, withLockfile);
      const beforePackument = hits.packument;
      const beforeTarball = hits.tarball;

      const res = await npmRun(dir, cacheRoot, ["install", PKG]);

      expect(res.ok, res.out).toBe(true);
      expect(pwned()).toBe(false);
      expect(fs.readFileSync(path.join(dir, "node_modules", PKG, "index.js"), "utf-8"))
        .toContain("legit");
      // Resolution came from the registry, not from the poisoned cache.
      expect(hits.packument).toBeGreaterThan(beforePackument);
      // req 2 / req 7: the tarball still came out of the shared content store.
      expect(hits.tarball).toBe(beforeTarball);
    }, NPM_TIMEOUT_MS);
  }

  it("req 3: shared content poisoned in place fails closed rather than installing it", async () => {
    const cacheRoot = path.join(root, "private-content-poison");
    expect(prepareSessionNpmCache(cacheRoot, sharedNpmContentDir(depCacheDir)).shared).toBe(true);
    const dir = project("victim-content-poison", true);
    expect((await npmRun(dir, cacheRoot, ["install", PKG])).ok).toBe(true);

    const blob = contentPath(sharedCacache, legit.integrity);
    const original = fs.readFileSync(blob);
    const stat = fs.statSync(blob);
    fs.writeFileSync(blob, evil.data);
    // pnpm's H2 fast path trusts a matching mtime; npm re-hashes on every read.
    fs.utimesSync(blob, stat.atime, stat.mtime);
    fs.rmSync(path.join(dir, "node_modules"), { recursive: true, force: true });

    try {
      const offline = await npmRun(dir, cacheRoot, ["install", "--offline"]);

      expect(offline.ok, offline.out).toBe(false);
      expect(pwned()).toBe(false);
    } finally {
      fs.writeFileSync(blob, original);
      fs.utimesSync(blob, stat.atime, stat.mtime);
    }
  }, NPM_TIMEOUT_MS);
});
