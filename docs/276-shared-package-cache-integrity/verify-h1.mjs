#!/usr/bin/env node
// Reproduces the H1 measurement cells in plan.md section 1: warm-install cost
// (req 7), the per-session disk the private index costs (req 10), and which npm
// commands a split cache changes. Needs the npm registry.
//
// The *attack* is not here — it is a CI test,
// src/server/orchestrator/integration_tests/npm-cache-poisoning.test.ts, which
// runs the poisoned packument against a local registry with its own control.
//
//   node docs/276-shared-package-cache-integrity/verify-h1.mjs
//
// Every timing is best-of-5 with node_modules removed between runs. Absolute
// numbers depend on the host; the ratio between the A and B cells is the result.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const LAB = fs.mkdtempSync(path.join(os.tmpdir(), "verify-h1-"));
const SHARED = path.join(LAB, "shared");
const SHARED_CONTENT = path.join(SHARED, "_cacache", "content-v2");

// Enough files that the tree build, not the process start, dominates the timing.
const DEPS = {
  express: "4.21.2",
  lodash: "4.17.21",
  chalk: "5.3.0",
  commander: "12.1.0",
  axios: "1.7.9",
  yaml: "2.6.1",
  zod: "3.24.1",
  "date-fns": "4.1.0",
};

let pass = 0;
let fail = 0;
const check = (ok, label, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

function project(name, { lockfileFrom } = {}) {
  const dir = path.join(LAB, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name, version: "1.0.0", private: true, dependencies: DEPS }, null, 2),
  );
  if (lockfileFrom) {
    fs.copyFileSync(path.join(lockfileFrom, "package-lock.json"), path.join(dir, "package-lock.json"));
  }
  return dir;
}

function privateCache(name) {
  const root = path.join(LAB, name);
  fs.mkdirSync(path.join(root, "_cacache"), { recursive: true });
  fs.symlinkSync(SHARED_CONTENT, path.join(root, "_cacache", "content-v2"));
  return root;
}

async function npm(dir, cache, args) {
  try {
    const { stdout, stderr } = await run("npm", [...args, "--no-audit", "--no-fund"], {
      cwd: dir, env: { ...process.env, npm_config_cache: cache }, encoding: "utf-8", maxBuffer: 64e6,
    });
    return { ok: true, out: `${stdout}${stderr}` };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

async function bestOf5(dir, cache, args, { coldIndex = false } = {}) {
  let best = Infinity;
  for (let i = 0; i < 5; i++) {
    fs.rmSync(path.join(dir, "node_modules"), { recursive: true, force: true });
    if (coldIndex) fs.rmSync(path.join(cache, "_cacache", "index-v5"), { recursive: true, force: true });
    const started = process.hrtime.bigint();
    const res = await npm(dir, cache, args);
    if (!res.ok) return { ms: null, out: res.out };
    best = Math.min(best, Number(process.hrtime.bigint() - started) / 1e6);
  }
  return { ms: Math.round(best), out: "" };
}

// Allocated blocks, not apparent size: these trees are thousands of small files,
// so `size` understates the disk by several times (plan.md's measurement notes).
const du = (p) => {
  let bytes = 0;
  const walk = (q) => {
    for (const e of fs.readdirSync(q, { withFileTypes: true })) {
      const child = path.join(q, e.name);
      if (e.isSymbolicLink()) continue;
      const stat = fs.lstatSync(child);
      bytes += stat.blocks * 512;
      if (e.isDirectory()) walk(child);
    }
  };
  try { walk(p); } catch { return 0; }
  return bytes;
};
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const blobs = (p) => {
  let n = 0;
  const walk = (q) => {
    for (const e of fs.readdirSync(q, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(q, e.name));
      else n++;
    }
  };
  try { walk(p); } catch { return 0; }
  return n;
};

try {
  // Seed the shared cache the way a repo's first session does.
  const seed = project("seed");
  const seeded = await npm(seed, SHARED, ["install"]);
  check(seeded.ok, "seed install populated the shared cache", seeded.ok ? "" : seeded.out.slice(0, 200));
  if (!seeded.ok) process.exit(1);
  const files = (() => {
    let n = 0;
    const walk = (p) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        if (e.isDirectory() && !e.isSymbolicLink()) walk(path.join(p, e.name));
        else n++;
      }
    };
    walk(path.join(seed, "node_modules"));
    return n;
  })();
  console.log(`\nworkload: ${Object.keys(DEPS).length} deps, ${files} files, ` +
    `${mb(du(path.join(seed, "node_modules")))} node_modules, ${mb(du(SHARED))} shared cache\n`);

  // req 7 — the real ShipIt install line is `npm install --prefer-offline` (install-runtime.ts).
  const a = await bestOf5(project("a", { lockfileFrom: seed }), SHARED, ["install", "--prefer-offline"]);
  const bDir = project("b", { lockfileFrom: seed });
  const bCache = privateCache("b-cache");
  const b = await bestOf5(bDir, bCache, ["install", "--prefer-offline"]);
  const bCold = await bestOf5(bDir, bCache, ["install", "--prefer-offline"], { coldIndex: true });
  console.log(`A  shared index (today), warm            ${a.ms} ms`);
  console.log(`B  private index + shared content, warm  ${b.ms} ms  (${(b.ms / a.ms).toFixed(2)}×)`);
  console.log(`B' private index COLD + shared content   ${bCold.ms} ms  (${(bCold.ms / a.ms).toFixed(2)}×)`);
  check(b.ms !== null && b.ms < a.ms * 1.2, "req 7: warm install is not materially slower");

  // A lockfile carries the resolution, so an in-sync install never touches index-v5.
  check(
    !fs.existsSync(path.join(bCache, "_cacache", "index-v5")),
    "an in-sync lockfile install writes no resolution index at all",
  );

  // req 10 — what the private half costs when resolution does run (no lockfile).
  const nolockCache = privateCache("nolock-cache");
  const nolock = await npm(project("nolock"), nolockCache, ["install", "--prefer-offline"]);
  check(nolock.ok, "no-lockfile install over the shared content store", nolock.ok ? "" : nolock.out.slice(0, 200));
  const indexBytes = du(path.join(nolockCache, "_cacache", "index-v5"));
  console.log(`\nprivate resolution index, no lockfile:   ${mb(indexBytes)}`);
  console.log(`shared content store:                    ${mb(du(SHARED_CONTENT))}`);
  check(indexBytes < du(SHARED_CONTENT) / 5, "req 10: the private half is a fraction of the shared store");

  // req 2 — a package no session has downloaded lands in the SHARED store.
  const addDir = project("add", { lockfileFrom: seed });
  const addCache = privateCache("add-cache");
  await npm(addDir, addCache, ["install", "--prefer-offline"]);
  const before = blobs(SHARED_CONTENT);
  const added = await npm(addDir, addCache, ["install", "is-odd@3.0.1"]);
  const grew = blobs(SHARED_CONTENT) - before;
  check(added.ok && grew > 0, "req 2: a newly downloaded package is written to the shared store", `+${grew} blobs`);
  check(
    fs.lstatSync(path.join(addCache, "_cacache", "content-v2")).isSymbolicLink(),
    "the content-v2 link survives an install that writes content",
  );

  // Which npm commands a split cache changes.
  const verify = await npm(addDir, addCache, ["cache", "verify"]);
  console.log(`\nnpm cache verify: ok=${verify.ok} — ${verify.out.split("\n").find((l) => l.trim())?.trim().slice(0, 90)}`);
  const doctor = await npm(addDir, addCache, ["doctor"]);
  console.log(`npm doctor:       ok=${doctor.ok}`);
  check(!verify.ok, "npm cache verify FAILS on a split cache (documented in shipit-docs/environment.md)");
  check(
    blobs(SHARED_CONTENT) >= before && fs.lstatSync(path.join(addCache, "_cacache", "content-v2")).isSymbolicLink(),
    "a failed cache verify damages neither the shared store nor the link",
  );
  void doctor;

  const beforeClean = blobs(SHARED_CONTENT);
  const clean = await npm(addDir, addCache, ["cache", "clean", "--force"]);
  check(clean.ok, "npm cache clean --force succeeds");
  check(
    blobs(SHARED_CONTENT) === beforeClean,
    "npm cache clean --force leaves the repo's shared store intact (it unlinks a symlink)",
    `${beforeClean} blobs`,
  );
} finally {
  console.log(`\nPASS=${pass} FAIL=${fail}`);
  fs.rmSync(LAB, { recursive: true, force: true });
  if (fail > 0) process.exitCode = 1;
}
