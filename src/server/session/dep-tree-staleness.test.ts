/**
 * nikzlabs#2496 — the STALE half of the post-install dep-dir gate.
 *
 * Two halves are tested here and they pull in opposite directions, which is the
 * whole point: a stale tree must be caught, and a *legitimately partial* one
 * must not be. The second half is the regression guard for the warning in the
 * `dep-dirs` contract — `dep-dirs` may name a directory a given install does not
 * fully produce, and a check that started failing those would be worse than the
 * hole it closes.
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { npmLockfileMismatches, staleDepDirs } from "./dep-tree-staleness.js";

interface Entry {
  version?: string;
  dev?: boolean;
  optional?: boolean;
  devOptional?: boolean;
  peer?: boolean;
  link?: boolean;
  extraneous?: boolean;
  inBundle?: boolean;
  os?: string[];
  cpu?: string[];
  libc?: string[];
}

function lock(packages: Record<string, Entry>): string {
  return JSON.stringify({ name: "fixture", lockfileVersion: 3, packages: { "": { version: "1.0.0" }, ...packages } });
}

describe("npmLockfileMismatches — the tree must hold what the lockfile asks for", () => {
  it("reports nothing when the tree matches the lockfile", () => {
    const l = lock({ "node_modules/a": { version: "1.0.0" }, "node_modules/b": { version: "2.1.0" } });
    expect(npmLockfileMismatches(l, l)).toEqual([]);
  });

  it("reports a package the lockfile requires at a version the tree does not hold", () => {
    // The field shape: the lockfile moved with the commit, the tree did not.
    const required = lock({ "node_modules/vite": { version: "5.4.0" } });
    const installed = lock({ "node_modules/vite": { version: "4.0.0" } });

    expect(npmLockfileMismatches(required, installed)).toEqual([
      { packagePath: "node_modules/vite", expected: "5.4.0", found: "4.0.0" },
    ]);
  });

  it("reports a required package the tree does not hold at all", () => {
    const required = lock({ "node_modules/a": { version: "1.0.0" }, "node_modules/new": { version: "3.0.0" } });
    const installed = lock({ "node_modules/a": { version: "1.0.0" } });

    expect(npmLockfileMismatches(required, installed)).toEqual([
      { packagePath: "node_modules/new", expected: "3.0.0", found: null },
    ]);
  });

  it("never reports a tree that holds MORE than the lockfile asks for", () => {
    // One-directional by design: extra packages are what every partial cleanup
    // looks like, and they are not a failed install.
    const required = lock({ "node_modules/a": { version: "1.0.0" } });
    const installed = lock({ "node_modules/a": { version: "1.0.0" }, "node_modules/leftover": { version: "9.9.9" } });

    expect(npmLockfileMismatches(required, installed)).toEqual([]);
  });

  it("requires dev dependencies when the tree recorded dev packages", () => {
    const required = lock({
      "node_modules/a": { version: "1.0.0" },
      "node_modules/vitest": { version: "2.0.0", dev: true },
    });
    const installed = lock({
      "node_modules/a": { version: "1.0.0" },
      "node_modules/vitest": { version: "1.0.0", dev: true },
    });

    expect(npmLockfileMismatches(required, installed)).toEqual([
      { packagePath: "node_modules/vitest", expected: "2.0.0", found: "1.0.0" },
    ]);
  });

  it("does NOT require dev dependencies when the tree recorded none (--omit=dev)", () => {
    // Verified against npm 10: `npm install --omit=dev` writes a hidden lockfile
    // with no `dev` entries at all. Requiring the lockfile's dev packages there
    // would fail every production-mode install. Calibrating on what the tree
    // itself recorded needs no parsing of the user's command line.
    const required = lock({
      "node_modules/a": { version: "1.0.0" },
      "node_modules/vitest": { version: "2.0.0", dev: true },
    });
    const installed = lock({ "node_modules/a": { version: "1.0.0" } });

    expect(npmLockfileMismatches(required, installed)).toEqual([]);
  });

  it("never requires optional, peer, bundled, linked or platform-restricted entries", () => {
    const required = lock({
      "node_modules/opt": { version: "1.0.0", optional: true },
      "node_modules/devopt": { version: "1.0.0", devOptional: true },
      "node_modules/peer": { version: "1.0.0", peer: true },
      "node_modules/bundled": { version: "1.0.0", inBundle: true },
      "node_modules/web": { version: "1.0.0", link: true },
      "node_modules/fsevents": { version: "2.3.3", os: ["darwin"] },
      "node_modules/swc-linux": { version: "1.0.0", cpu: ["x64"] },
      "node_modules/musl-only": { version: "1.0.0", libc: ["musl"] },
      "node_modules/gone": { version: "1.0.0", extraneous: true },
    });
    const installed = lock({});

    expect(npmLockfileMismatches(required, installed)).toEqual([]);
  });

  it("ignores the root project and workspace paths — only node_modules/ keys", () => {
    const required = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { version: "1.0.0" },
        "packages/web": { version: "0.1.0" },
        "node_modules/a": { version: "1.0.0" },
      },
    });
    const installed = lock({ "node_modules/a": { version: "1.0.0" } });

    expect(npmLockfileMismatches(required, installed)).toEqual([]);
  });

  it("is not comparable — never stale — for unparseable or v1 lockfiles", () => {
    const v3 = lock({ "node_modules/a": { version: "1.0.0" } });
    const v1 = JSON.stringify({ lockfileVersion: 1, dependencies: { a: { version: "1.0.0" } } });

    expect(npmLockfileMismatches("not json", v3)).toBeNull();
    expect(npmLockfileMismatches(v3, "not json")).toBeNull();
    expect(npmLockfileMismatches(v1, v3)).toBeNull();
    expect(npmLockfileMismatches(v3, v1)).toBeNull();
  });
});

describe("staleDepDirs — which declared dirs get checked at all", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
    roots.length = 0;
  });

  function makeWorkspace(depDirsBlock: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dep-stale-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "shipit.yaml"), `agent:\n${depDirsBlock}`);
    return root;
  }

  function writeTree(root: string, depDir: string, required: Record<string, Entry>, installed: Record<string, Entry> | null): void {
    fs.mkdirSync(path.join(root, depDir), { recursive: true });
    fs.writeFileSync(path.join(root, path.dirname(depDir), "package-lock.json"), lock(required));
    if (installed !== null) {
      fs.writeFileSync(path.join(root, depDir, ".package-lock.json"), lock(installed));
    }
  }

  it("flags a dep dir whose npm-reified tree is behind its lockfile", () => {
    const root = makeWorkspace("  dep-dirs:\n    - node_modules\n");
    writeTree(root, "node_modules", { "node_modules/vite": { version: "5.4.0" } }, { "node_modules/vite": { version: "4.0.0" } });

    expect(staleDepDirs(root)).toEqual([
      {
        depDir: "node_modules",
        mismatches: [{ packagePath: "node_modules/vite", expected: "5.4.0", found: "4.0.0" }],
      },
    ]);
  });

  it("leaves a dir with no hidden lockfile alone — it is not an npm-reified tree", () => {
    // The load-bearing narrowing. A monorepo's `packages/web/node_modules` is
    // near-empty because everything hoisted to the root, and a `dist/` declared
    // per the doc's build-output advice holds no npm record either. Neither has
    // a `.package-lock.json`, so neither is compared against anything.
    const root = makeWorkspace("  dep-dirs:\n    - node_modules\n    - dist\n");
    writeTree(root, "node_modules", { "node_modules/a": { version: "1.0.0" } }, { "node_modules/a": { version: "1.0.0" } });
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "dist", "bundle.js"), "// built once, never rebuilt");

    expect(staleDepDirs(root)).toEqual([]);
  });

  it("leaves a nested dep dir alone when its parent has no lockfile of its own", () => {
    const root = makeWorkspace("  dep-dirs:\n    - packages/web/node_modules\n");
    fs.mkdirSync(path.join(root, "packages/web/node_modules"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "packages/web/node_modules", ".package-lock.json"),
      lock({ "node_modules/a": { version: "0.0.1" } }),
    );

    expect(staleDepDirs(root)).toEqual([]);
  });

  it("returns nothing when the repo opts out with an empty dep-dirs list", () => {
    const root = makeWorkspace("  dep-dirs: []\n");
    writeTree(root, "node_modules", { "node_modules/vite": { version: "5.4.0" } }, { "node_modules/vite": { version: "4.0.0" } });

    expect(staleDepDirs(root)).toEqual([]);
  });

  it("returns nothing when the workspace has no shipit.yaml at all", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dep-stale-"));
    roots.push(root);
    // Default dep-dirs is [node_modules], and there is no tree to compare.
    expect(staleDepDirs(root)).toEqual([]);
  });
});
