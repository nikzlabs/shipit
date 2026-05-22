/**
 * Unit tests for the docs/148 fast-install helpers.
 *
 * The materialize ladder + populateStore tests shell out to tar/cp on the
 * host, so they only run where those binaries are available (Linux/macOS,
 * which is true for both ShipIt's container CI and a dev laptop). Pure
 * helpers (isCacheableInstall, computeStoreKey, etc.) have no such
 * dependency.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  computeStoreKey,
  fastInstallDisabled,
  findLockfile,
  isCacheableInstall,
  materialize,
  nmStoreRoot,
  populateStore,
  runtimeKey,
  tuneNpmInstall,
} from "./nm-store.js";

describe("isCacheableInstall", () => {
  it("accepts the canonical bare installer invocations", () => {
    expect(isCacheableInstall("npm install")).toBe(true);
    expect(isCacheableInstall("npm i")).toBe(true);
    expect(isCacheableInstall("npm ci")).toBe(true);
    expect(isCacheableInstall("yarn")).toBe(true);
    expect(isCacheableInstall("yarn install")).toBe(true);
    expect(isCacheableInstall("pnpm install")).toBe(true);
    expect(isCacheableInstall("pnpm i")).toBe(true);
  });

  it("tolerates surrounding whitespace", () => {
    expect(isCacheableInstall("  npm install  ")).toBe(true);
  });

  it("rejects shell metacharacters (chaining, redirection, pipes, env)", () => {
    // Each of these could mutate state outside `node_modules`, so the
    // snapshot-and-skip optimization would silently drop side effects.
    expect(isCacheableInstall("npm install && tsc")).toBe(false);
    expect(isCacheableInstall("npm install || true")).toBe(false);
    expect(isCacheableInstall("npm install; echo done")).toBe(false);
    expect(isCacheableInstall("npm install | tee install.log")).toBe(false);
    expect(isCacheableInstall("npm install > install.log")).toBe(false);
    expect(isCacheableInstall("npm install < /dev/null")).toBe(false);
    expect(isCacheableInstall("$(npm install)")).toBe(false);
    expect(isCacheableInstall("`npm install`")).toBe(false);
    expect(isCacheableInstall("NODE_ENV=production npm install")).toBe(false);
  });

  it("rejects extra args that could change the dep set", () => {
    expect(isCacheableInstall("npm install --omit=dev")).toBe(false);
    expect(isCacheableInstall("npm install lodash")).toBe(false);
    expect(isCacheableInstall("npm install --production")).toBe(false);
    expect(isCacheableInstall("yarn install --production")).toBe(false);
    expect(isCacheableInstall("pnpm install --prod")).toBe(false);
  });

  it("rejects empty and unknown tools", () => {
    expect(isCacheableInstall("")).toBe(false);
    expect(isCacheableInstall("   ")).toBe(false);
    expect(isCacheableInstall("bun install")).toBe(false);
    expect(isCacheableInstall("rush install")).toBe(false);
    expect(isCacheableInstall("npm run install")).toBe(false);
  });
});

describe("tuneNpmInstall", () => {
  it("injects --prefer-offline --no-audit --no-fund into bare npm invocations", () => {
    // Option E: pure overhead in our setting (no network audit needed, fund
    // messages are noise). Composes with the store key — the tuned command
    // is part of the key so tuned/untuned can't share a store.
    expect(tuneNpmInstall("npm install")).toBe("npm install --prefer-offline --no-audit --no-fund");
    expect(tuneNpmInstall("npm i")).toBe("npm i --prefer-offline --no-audit --no-fund");
    expect(tuneNpmInstall("npm ci")).toBe("npm ci --prefer-offline --no-audit --no-fund");
  });

  it("leaves non-npm and non-bare commands alone", () => {
    // yarn/pnpm have their own conventions; do not paste npm flags onto them.
    expect(tuneNpmInstall("yarn")).toBe("yarn");
    expect(tuneNpmInstall("yarn install")).toBe("yarn install");
    expect(tuneNpmInstall("pnpm install")).toBe("pnpm install");
    // Anything with explicit flags is the user being deliberate — don't override.
    expect(tuneNpmInstall("npm install --omit=dev")).toBe("npm install --omit=dev");
  });
});

describe("findLockfile", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nm-store-lock-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the single lockfile with a content hash", () => {
    fs.writeFileSync(path.join(tmp, "package-lock.json"), '{"name":"x"}');
    const info = findLockfile(tmp);
    expect(info?.name).toBe("package-lock.json");
    expect(info?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns null when no lockfile is present (workspace install would generate one)", () => {
    expect(findLockfile(tmp)).toBeNull();
  });

  it("returns null when multiple lockfiles are present (monorepo / migration in progress)", () => {
    // The plan's v1 explicitly falls through to a plain install in this
    // case rather than guess which lockfile owns the workspace.
    fs.writeFileSync(path.join(tmp, "package-lock.json"), "{}");
    fs.writeFileSync(path.join(tmp, "yarn.lock"), "");
    expect(findLockfile(tmp)).toBeNull();
  });

  it("re-hashes when lockfile content changes", () => {
    fs.writeFileSync(path.join(tmp, "package-lock.json"), "v1");
    const a = findLockfile(tmp);
    fs.writeFileSync(path.join(tmp, "package-lock.json"), "v2");
    const b = findLockfile(tmp);
    expect(a?.contentHash).not.toEqual(b?.contentHash);
  });
});

describe("computeStoreKey", () => {
  const baseLockfile = {
    name: "package-lock.json" as const,
    path: "/workspace/package-lock.json",
    contentHash: "a".repeat(64),
  };

  it("is stable for identical inputs", () => {
    const a = computeStoreKey({ lockfile: baseLockfile, runtimeKey: "k1", installCommand: "npm install" });
    const b = computeStoreKey({ lockfile: baseLockfile, runtimeKey: "k1", installCommand: "npm install" });
    expect(a).toBe(b);
  });

  it("changes when the lockfile content changes", () => {
    const a = computeStoreKey({ lockfile: baseLockfile, runtimeKey: "k1", installCommand: "npm install" });
    const b = computeStoreKey({
      lockfile: { ...baseLockfile, contentHash: "b".repeat(64) },
      runtimeKey: "k1",
      installCommand: "npm install",
    });
    expect(a).not.toBe(b);
  });

  it("changes when the runtime key changes (image rebuild → fresh store)", () => {
    // Native addons compiled against the old runtime would load-fail after
    // a deploy that rebuilt the worker image. Storing a per-runtime key
    // forces a miss and a fresh real install on the new image.
    const a = computeStoreKey({ lockfile: baseLockfile, runtimeKey: "k1", installCommand: "npm install" });
    const b = computeStoreKey({ lockfile: baseLockfile, runtimeKey: "k2", installCommand: "npm install" });
    expect(a).not.toBe(b);
  });

  it("changes when the install command changes (tuned vs untuned can't share)", () => {
    const a = computeStoreKey({ lockfile: baseLockfile, runtimeKey: "k1", installCommand: "npm install" });
    const b = computeStoreKey({
      lockfile: baseLockfile,
      runtimeKey: "k1",
      installCommand: "npm install --prefer-offline --no-audit --no-fund",
    });
    expect(a).not.toBe(b);
  });

  it("changes when the lockfile name changes (different package manager)", () => {
    const npmKey = computeStoreKey({ lockfile: baseLockfile, runtimeKey: "k1", installCommand: "npm install" });
    const yarnKey = computeStoreKey({
      lockfile: { ...baseLockfile, name: "yarn.lock" },
      runtimeKey: "k1",
      installCommand: "yarn install",
    });
    expect(npmKey).not.toBe(yarnKey);
  });
});

describe("runtimeKey", () => {
  it("includes arch and a node-major segment", () => {
    const key = runtimeKey({ SESSION_WORKER_IMAGE_ID: "img-abc" });
    expect(key).toContain("img-abc");
    expect(key).toContain(process.arch);
    expect(key).toMatch(/node\d+$/);
  });

  it("falls back to 'unknown' image id when no env var is set", () => {
    const key = runtimeKey({});
    expect(key.startsWith("unknown|")).toBe(true);
  });
});

describe("kill switch", () => {
  it("fastInstallDisabled honors SHIPIT_FAST_INSTALL=disabled", () => {
    expect(fastInstallDisabled({ SHIPIT_FAST_INSTALL: "disabled" })).toBe(true);
    expect(fastInstallDisabled({ SHIPIT_FAST_INSTALL: "true" })).toBe(false);
    expect(fastInstallDisabled({})).toBe(false);
  });

  it("nmStoreRoot prefers SHIPIT_NM_STORE_DIR when set", () => {
    expect(nmStoreRoot({ SHIPIT_NM_STORE_DIR: "/tmp/x" })).toBe("/tmp/x");
    expect(nmStoreRoot({})).toBe("/dep-cache/nm-store");
  });
});

describe("materialize ladder", () => {
  let tmp: string;
  let storeDir: string;
  let destDir: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nm-store-mat-"));
    storeDir = path.join(tmp, "store");
    destDir = path.join(tmp, "dest");
    fs.mkdirSync(storeDir, { recursive: true });
    // A miniature `node_modules`-shaped tree.
    fs.mkdirSync(path.join(storeDir, "left-pad"), { recursive: true });
    fs.writeFileSync(path.join(storeDir, "left-pad", "package.json"), '{"name":"left-pad"}');
    fs.writeFileSync(path.join(storeDir, "left-pad", "index.js"), "module.exports = () => {};\n");
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("materializes the store contents into destDir (tar fast path)", async () => {
    const res = await materialize(storeDir, destDir);
    expect(res.ok).toBe(true);
    expect(res.strategy).toBe("tar");
    expect(fs.existsSync(path.join(destDir, "left-pad", "package.json"))).toBe(true);
    expect(fs.readFileSync(path.join(destDir, "left-pad", "index.js"), "utf8")).toContain("module.exports");
  });

  it("produces an independent copy (mutating destDir does not affect the store)", async () => {
    // The agent may `npm rebuild` / patch-package mid-session. The store
    // must stay byte-for-byte intact — hardlinks are deliberately rejected
    // in the ladder for this reason.
    await materialize(storeDir, destDir);
    fs.writeFileSync(path.join(destDir, "left-pad", "index.js"), "// mutated\n");
    expect(fs.readFileSync(path.join(storeDir, "left-pad", "index.js"), "utf8")).toContain("module.exports");
  });

  it("clears a pre-existing partial node_modules before extracting", async () => {
    fs.mkdirSync(path.join(destDir, "leftover"), { recursive: true });
    fs.writeFileSync(path.join(destDir, "leftover", "old.txt"), "stale");
    const res = await materialize(storeDir, destDir);
    expect(res.ok).toBe(true);
    expect(fs.existsSync(path.join(destDir, "leftover"))).toBe(false);
    expect(fs.existsSync(path.join(destDir, "left-pad"))).toBe(true);
  });

  it("returns ok=false when the store directory is missing (caller falls through to real install)", async () => {
    const res = await materialize(path.join(tmp, "no-such-store"), destDir);
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });
});

describe("populateStore", () => {
  let tmp: string;
  let src: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nm-store-pop-"));
    src = path.join(tmp, "src", "node_modules");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, "marker"), "hello\n");
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("publishes the source tree at storeDir via atomic rename", async () => {
    const storeDir = path.join(tmp, "store", "abc123");
    const result = await populateStore(src, storeDir);
    expect(result.published).toBe(true);
    expect(fs.readFileSync(path.join(storeDir, "marker"), "utf8")).toBe("hello\n");
    // No leftover temp dirs.
    const parent = path.dirname(storeDir);
    const entries = fs.readdirSync(parent).filter((e) => e.startsWith(".tmp-"));
    expect(entries).toEqual([]);
  });

  it("is a no-op when the store dir already exists (single-flight skip)", async () => {
    // Mirrors the warm-pool race: pre-install and on-activation install both
    // populate the same storeKey; the loser should silently drop its temp.
    const storeDir = path.join(tmp, "store", "abc123");
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(storeDir, "existing"), "original");
    const result = await populateStore(src, storeDir);
    expect(result.published).toBe(false);
    // Existing store untouched.
    expect(fs.readFileSync(path.join(storeDir, "existing"), "utf8")).toBe("original");
    expect(fs.existsSync(path.join(storeDir, "marker"))).toBe(false);
  });

  it("never publishes a half-written store (concurrent populates serialize via rename)", async () => {
    // Two populates for the same storeKey race. Exactly one wins; the
    // loser's temp dir is discarded. The published store is byte-identical
    // to one of the two inputs — never a merge.
    const storeDir = path.join(tmp, "store", "racey");

    // Two independent source trees that would be distinguishable if they
    // got merged. Each gets its own `marker` content + unique file.
    const srcA = path.join(tmp, "srcA", "node_modules");
    const srcB = path.join(tmp, "srcB", "node_modules");
    fs.mkdirSync(srcA, { recursive: true });
    fs.mkdirSync(srcB, { recursive: true });
    fs.writeFileSync(path.join(srcA, "marker"), "A\n");
    fs.writeFileSync(path.join(srcA, "only-in-a"), "");
    fs.writeFileSync(path.join(srcB, "marker"), "B\n");
    fs.writeFileSync(path.join(srcB, "only-in-b"), "");

    const [resA, resB] = await Promise.all([
      populateStore(srcA, storeDir),
      populateStore(srcB, storeDir),
    ]);

    // Exactly one published.
    expect([resA.published, resB.published].filter(Boolean).length).toBe(1);

    const marker = fs.readFileSync(path.join(storeDir, "marker"), "utf8");
    // Marker must be exactly one source's content (no torn read).
    expect(["A\n", "B\n"]).toContain(marker);
    // And the published store contains exactly one of the unique markers,
    // never both (would indicate a partial merge).
    const onlyA = fs.existsSync(path.join(storeDir, "only-in-a"));
    const onlyB = fs.existsSync(path.join(storeDir, "only-in-b"));
    expect(onlyA !== onlyB).toBe(true);

    // No temp leftovers.
    const parent = path.dirname(storeDir);
    const stragglers = fs.readdirSync(parent).filter((e) => e.startsWith(".tmp-"));
    expect(stragglers).toEqual([]);
  });
});
