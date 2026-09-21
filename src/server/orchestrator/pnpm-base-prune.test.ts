import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import { findPruneRemnants, prunePnpmBase, resolveLockEdge } from "./pnpm-base-prune.js";

/**
 * docs/276 section 5 — the prune that makes a build-bearing repo shareable again (planning#604).
 *
 * The trees here are written by hand rather than by pnpm, which is what lets a cell state a
 * shape pnpm produces rarely and the prune must still get right: a peer-qualified duplicate, an
 * `npm:` alias, a package the lockfile pins and the platform skipped. The real-pnpm half is
 * `integration_tests/pnpm-verified-base-build.test.ts`.
 */

interface PackageSpec {
  /** Virtual-store directory name, which pnpm derives from the lockfile key. */
  dir: string;
  name: string;
  version: string;
  /** The manifest's own name/version, when a patch has made them differ from the key. */
  manifest?: { name: string; version: string };
  /** Links from `node_modules/<link>` to this package. */
  links?: string[];
  /** Command shims in `node_modules/.bin` pointing into this package. */
  bins?: string[];
  /** Packages this one links to from inside its own `node_modules`. */
  edges?: { name: string; dir: string }[];
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-prune-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeTree(
  specs: PackageSpec[],
  lock: Record<string, unknown>,
  opts: { hoisted?: string[] } = {},
): string {
  const depDir = path.join(tmp, "node_modules");
  fs.mkdirSync(path.join(depDir, ".pnpm"), { recursive: true });
  for (const spec of specs) {
    const inner = path.join(depDir, ".pnpm", spec.dir, "node_modules", spec.name);
    fs.mkdirSync(inner, { recursive: true });
    fs.writeFileSync(
      path.join(inner, "package.json"),
      JSON.stringify(spec.manifest ?? { name: spec.name, version: spec.version }),
    );
    for (const edge of spec.edges ?? []) {
      const at = path.join(depDir, ".pnpm", spec.dir, "node_modules", edge.name);
      fs.mkdirSync(path.dirname(at), { recursive: true });
      fs.symlinkSync(path.join("..", "..", edge.dir, "node_modules", edge.name), at);
    }
    for (const link of spec.links ?? []) {
      const at = path.join(depDir, link);
      fs.mkdirSync(path.dirname(at), { recursive: true });
      // Relative to the LINK's own directory: a scoped link sits one level deeper, and a target
      // written as if it were at the top level is a dangling link that every absence assertion
      // below would pass on for the wrong reason.
      fs.symlinkSync(path.relative(path.dirname(at), inner), at);
    }
    for (const bin of spec.bins ?? []) {
      fs.mkdirSync(path.join(depDir, ".bin"), { recursive: true });
      fs.symlinkSync(
        path.join("..", ".pnpm", spec.dir, "node_modules", spec.name, "cli.js"),
        path.join(depDir, ".bin", bin),
      );
    }
    for (const name of opts.hoisted ?? []) {
      if (name !== spec.name) continue;
      fs.mkdirSync(path.join(depDir, ".pnpm", "node_modules"), { recursive: true });
      fs.symlinkSync(
        path.join("..", spec.dir, "node_modules", spec.name),
        path.join(depDir, ".pnpm", "node_modules", spec.name),
      );
    }
  }
  fs.writeFileSync(path.join(depDir, ".pnpm", "lock.yaml"), JSON.stringify(lock));
  fs.writeFileSync(path.join(depDir, ".modules.yaml"), "pendingBuilds: []\n");
  // What a real install leaves beside the tree, and what a session's own install consults first.
  fs.writeFileSync(
    path.join(depDir, ".pnpm-workspace-state-v1.json"),
    JSON.stringify({ lastValidatedTimestamp: Date.now(), projects: {} }),
  );
  return depDir;
}

/**
 * A path is gone, rather than merely unresolvable. `existsSync` follows the link, so it answers
 * false for a symlink that is still there and points at something the prune removed — which is
 * the exact state these assertions exist to rule out.
 */
function expectGone(p: string): void {
  expect(() => fs.lstatSync(p)).toThrow();
}

function readLock(depDir: string): Record<string, unknown> {
  return parseYaml(fs.readFileSync(path.join(depDir, ".pnpm", "lock.yaml"), "utf-8")) as Record<
    string,
    unknown
  >;
}

const SIMPLE_LOCK = {
  lockfileVersion: "9.0",
  importers: {
    ".": {
      dependencies: {
        "better-sqlite3": { specifier: "11.0.0", version: "11.0.0" },
        semver: { specifier: "7.6.3", version: "7.6.3" },
      },
    },
  },
  packages: { "better-sqlite3@11.0.0": {}, "semver@7.6.3": {} },
  snapshots: { "better-sqlite3@11.0.0": {}, "semver@7.6.3": {} },
};

const SQLITE = { key: "better-sqlite3@11.0.0", name: "better-sqlite3", version: "11.0.0" };

describe("prunePnpmBase", () => {
  it("removes the package from the tree, its links and the carried lockfile", () => {
    const depDir = writeTree(
      [
        {
          dir: "better-sqlite3@11.0.0",
          name: "better-sqlite3",
          version: "11.0.0",
          links: ["better-sqlite3"],
          bins: ["sqlite-cli"],
        },
        { dir: "semver@7.6.3", name: "semver", version: "7.6.3", links: ["semver"], bins: ["semver"] },
      ],
      SIMPLE_LOCK,
      { hoisted: ["better-sqlite3"] },
    );

    const result = prunePnpmBase(depDir, [SQLITE]);

    expect(result).toMatchObject({ ok: true, remainingPackages: 1 });
    expectGone(path.join(depDir, ".pnpm", "better-sqlite3@11.0.0"));
    expect(fs.existsSync(path.join(depDir, ".pnpm", "semver@7.6.3"))).toBe(true);
    // Every place a session reads before its own install repairs anything.
    expectGone(path.join(depDir, "better-sqlite3"));
    expectGone(path.join(depDir, ".bin", "sqlite-cli"));
    expectGone(path.join(depDir, ".pnpm", "node_modules", "better-sqlite3"));
    // The retained package keeps its own.
    expect(fs.lstatSync(path.join(depDir, "semver")).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(depDir, ".bin", "semver")).isSymbolicLink()).toBe(true);

    const lock = readLock(depDir);
    expect(Object.keys(lock.packages as object)).toEqual(["semver@7.6.3"]);
    expect(Object.keys(lock.snapshots as object)).toEqual(["semver@7.6.3"]);
    expect(
      Object.keys((lock.importers as Record<string, { dependencies: object }>)["."].dependencies),
    ).toEqual(["semver"]);
  });

  it("drops the carried install state, which short-circuits an install past the prune", () => {
    // Measured on pnpm 12.5.1 (`pruned-base-spike.sh` cell G): with this file present and the
    // consumer's checkout older than the build, a bare `pnpm install` over a pruned tree says
    // "Already up to date" in 1 ms and repairs nothing — it never reads the carried lockfile.
    // Removing it, with the same tree and the same mtimes, re-imports.
    const depDir = writeTree(
      [
        { dir: "better-sqlite3@11.0.0", name: "better-sqlite3", version: "11.0.0" },
        { dir: "semver@7.6.3", name: "semver", version: "7.6.3" },
      ],
      SIMPLE_LOCK,
    );
    expect(fs.existsSync(path.join(depDir, ".pnpm-workspace-state-v1.json"))).toBe(true);

    const result = prunePnpmBase(depDir, [SQLITE]);

    expect(result).toMatchObject({ ok: true, removedState: [".pnpm-workspace-state-v1.json"] });
    expect(fs.existsSync(path.join(depDir, ".pnpm-workspace-state-v1.json"))).toBe(false);
    // Still a tree: only the state file went, not the install output beside it.
    expect(fs.existsSync(path.join(depDir, ".modules.yaml"))).toBe(true);
  });

  it("leaves a RETAINED package's edge to a pruned one dangling, for pnpm to relink", () => {
    // Measured with `vite` retained and `esbuild` pruned: 47 incoming edges left, the bare
    // install relinked them and `require("vite")` loaded. Cutting them would mean pruning
    // transitively, which is a different and far larger removal set.
    const depDir = writeTree(
      [
        { dir: "better-sqlite3@11.0.0", name: "better-sqlite3", version: "11.0.0" },
        {
          dir: "semver@7.6.3",
          name: "semver",
          version: "7.6.3",
          edges: [{ name: "better-sqlite3", dir: "better-sqlite3@11.0.0" }],
        },
      ],
      SIMPLE_LOCK,
    );

    expect(prunePnpmBase(depDir, [SQLITE])).toMatchObject({ ok: true });
    const edge = path.join(depDir, ".pnpm", "semver@7.6.3", "node_modules", "better-sqlite3");
    expect(fs.lstatSync(edge).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(edge)).toBe(false);
  });

  it("removes every peer-qualified instance of one package", () => {
    // pnpm gives a peer-qualified duplicate its own virtual-store directory under a name it
    // mangles, so a prune keyed on the directory name would leave one of these behind.
    const depDir = writeTree(
      [
        { dir: "sharp@0.33.0_react@18.2.0", name: "sharp", version: "0.33.0" },
        { dir: "sharp@0.33.0_react@17.0.2", name: "sharp", version: "0.33.0" },
        { dir: "semver@7.6.3", name: "semver", version: "7.6.3", links: ["semver"] },
      ],
      {
        lockfileVersion: "9.0",
        importers: { ".": { dependencies: { semver: { specifier: "7.6.3", version: "7.6.3" } } } },
        packages: { "sharp@0.33.0": {}, "semver@7.6.3": {} },
        snapshots: {
          "sharp@0.33.0(react@18.2.0)": {},
          "sharp@0.33.0(react@17.0.2)": {},
          "semver@7.6.3": {},
        },
      },
    );

    const result = prunePnpmBase(depDir, [
      { key: "sharp@0.33.0", name: "sharp", version: "0.33.0" },
    ]);

    expect(result).toMatchObject({ ok: true, remainingPackages: 1 });
    expect(fs.readdirSync(path.join(depDir, ".pnpm")).sort()).toEqual(["lock.yaml", "semver@7.6.3"]);
    const lock = readLock(depDir);
    expect(Object.keys(lock.snapshots as object)).toEqual(["semver@7.6.3"]);
    expect(Object.keys(lock.packages as object)).toEqual(["semver@7.6.3"]);
  });

  it("removes an npm: alias of a pruned package, which its own name never names", () => {
    const depDir = writeTree(
      [
        {
          dir: "better-sqlite3@11.0.0",
          name: "better-sqlite3",
          version: "11.0.0",
          links: ["sqlite"],
        },
        { dir: "semver@7.6.3", name: "semver", version: "7.6.3", links: ["semver"] },
      ],
      {
        lockfileVersion: "9.0",
        importers: {
          ".": {
            dependencies: {
              sqlite: { specifier: "npm:better-sqlite3@11.0.0", version: "better-sqlite3@11.0.0" },
              semver: { specifier: "7.6.3", version: "7.6.3" },
            },
          },
        },
        packages: { "better-sqlite3@11.0.0": {}, "semver@7.6.3": {} },
        snapshots: { "better-sqlite3@11.0.0": {}, "semver@7.6.3": {} },
      },
    );

    expect(prunePnpmBase(depDir, [SQLITE])).toMatchObject({ ok: true });
    expectGone(path.join(depDir, "sqlite"));
    const deps = (readLock(depDir).importers as Record<string, { dependencies: object }>)["."]
      .dependencies;
    expect(Object.keys(deps)).toEqual(["semver"]);
  });

  it("prunes a scoped package by its manifest, not by its mangled directory name", () => {
    const depDir = writeTree(
      [
        { dir: "@scope+native@2.0.0", name: "@scope/native", version: "2.0.0", links: ["@scope/native"] },
        { dir: "semver@7.6.3", name: "semver", version: "7.6.3" },
      ],
      {
        lockfileVersion: "9.0",
        importers: {
          ".": { dependencies: { "@scope/native": { specifier: "2.0.0", version: "2.0.0" } } },
        },
        packages: { "@scope/native@2.0.0": {}, "semver@7.6.3": {} },
        snapshots: { "@scope/native@2.0.0": {}, "semver@7.6.3": {} },
      },
    );

    expect(
      prunePnpmBase(depDir, [
        { key: "@scope/native@2.0.0", name: "@scope/native", version: "2.0.0" },
      ]),
    ).toMatchObject({ ok: true, remainingPackages: 1 });
    expectGone(path.join(depDir, "@scope", "native"));
    expect(Object.keys(readLock(depDir).packages as object)).toEqual(["semver@7.6.3"]);
  });

  it("removes an edge from an importer whose directory contains a slash", () => {
    // Found by `pruned-base-spike.sh` cell B against real pnpm: a workspace member's importer
    // directory is `packages/x`, and a first draft that carried the reference as one joined
    // string took it apart at the wrong slash and rewrote nothing. The prune then failed its own
    // verification, which is the fail-safe working — but the base it refused was one it should
    // have produced. Production-reachable since planning#414 admitted in-repo `workspace:`/`link:`,
    // so a workspace repo now gets a base whose importers are exactly this shape.
    const depDir = writeTree(
      [
        { dir: "better-sqlite3@11.0.0", name: "better-sqlite3", version: "11.0.0" },
        { dir: "semver@7.6.3", name: "semver", version: "7.6.3" },
      ],
      {
        lockfileVersion: "9.0",
        importers: {
          ".": {},
          "packages/x": {
            dependencies: {
              "better-sqlite3": { specifier: "11.0.0", version: "11.0.0" },
              semver: { specifier: "7.6.3", version: "7.6.3" },
            },
          },
        },
        packages: { "better-sqlite3@11.0.0": {}, "semver@7.6.3": {} },
        snapshots: { "better-sqlite3@11.0.0": {}, "semver@7.6.3": {} },
      },
    );

    expect(prunePnpmBase(depDir, [SQLITE])).toMatchObject({ ok: true });
    const importers = readLock(depDir).importers as Record<string, { dependencies: object }>;
    expect(Object.keys(importers["packages/x"].dependencies)).toEqual(["semver"]);
  });

  it("prunes a package the lockfile pins and the platform skipped, with no tree entry", () => {
    // An optional dependency for another platform is in the lockfile and not in the tree. It
    // must still leave the carried lockfile, and its absence from the tree is not a failure.
    const depDir = writeTree(
      [{ dir: "semver@7.6.3", name: "semver", version: "7.6.3", links: ["semver"] }],
      {
        lockfileVersion: "9.0",
        importers: { ".": { dependencies: { semver: { specifier: "7.6.3", version: "7.6.3" } } } },
        packages: { "@esbuild/darwin-arm64@0.21.5": {}, "semver@7.6.3": {} },
        snapshots: { "@esbuild/darwin-arm64@0.21.5": {}, "semver@7.6.3": {} },
      },
    );

    const result = prunePnpmBase(depDir, [
      { key: "@esbuild/darwin-arm64@0.21.5", name: "@esbuild/darwin-arm64", version: "0.21.5" },
    ]);

    expect(result).toMatchObject({ ok: true, removedDirs: [], remainingPackages: 1 });
    expect(Object.keys(readLock(depDir).packages as object)).toEqual(["semver@7.6.3"]);
  });

  it("removes nothing when a build-bearing package's version is not the one installed", () => {
    const depDir = writeTree(
      [{ dir: "semver@7.6.3", name: "semver", version: "7.6.3", links: ["semver"] }],
      {
        lockfileVersion: "9.0",
        importers: { ".": { dependencies: { semver: { specifier: "7.6.3", version: "7.6.3" } } } },
        packages: { "semver@7.6.3": {} },
        snapshots: { "semver@7.6.3": {} },
      },
    );

    expect(
      prunePnpmBase(depDir, [{ key: "semver@7.5.0", name: "semver", version: "7.5.0" }]),
    ).toMatchObject({ ok: true, removedDirs: [], removedLockKeys: [], remainingPackages: 1 });
  });

  it("removes a package whose PATCHED manifest disagrees with the lockfile key", () => {
    // Found by independent review 2026-09-21. `patchedDependencies` is admitted, and a patch can
    // rewrite the installed manifest's name or version — while pnpm still names the directory
    // from the lockfile key. Reading the manifest alone dropped the lock entries and KEPT the
    // directory, unbuilt, and the verification agreed because it used the same parser. Red on the
    // manifest-only implementation: `removedDirs` was `[]` and `ok` was still `true`.
    const depDir = writeTree(
      [
        {
          dir: "better-sqlite3@11.0.0",
          name: "better-sqlite3",
          version: "11.0.0",
          manifest: { name: "better-sqlite3", version: "11.0.0-patched" },
          links: ["better-sqlite3"],
        },
        { dir: "semver@7.6.3", name: "semver", version: "7.6.3" },
      ],
      SIMPLE_LOCK,
    );

    const result = prunePnpmBase(depDir, [SQLITE]);

    expect(result).toMatchObject({
      ok: true,
      removedDirs: ["better-sqlite3@11.0.0"],
      remainingPackages: 1,
    });
    expectGone(path.join(depDir, ".pnpm", "better-sqlite3@11.0.0"));
    expectGone(path.join(depDir, "better-sqlite3"));
  });

  it("refuses a tree whose carried lockfile it cannot read", () => {
    const depDir = writeTree(
      [{ dir: "better-sqlite3@11.0.0", name: "better-sqlite3", version: "11.0.0" }],
      SIMPLE_LOCK,
    );
    fs.rmSync(path.join(depDir, ".pnpm", "lock.yaml"));

    expect(prunePnpmBase(depDir, [SQLITE])).toMatchObject({ ok: false });
    expect((prunePnpmBase(depDir, [SQLITE]) as { detail: string }).detail).toContain("lock.yaml");
  });

  it.skipIf(process.getuid?.() === 0)(
    "refuses AFTER removing, when the lockfile rewrite itself fails",
    () => {
      // The other refusal cells fail on the first read. This one fails at the write, with the
      // directories already gone — the half-pruned state the invariant exists for. Skipped as
      // root, for whom a read-only file is not read-only.
      const depDir = writeTree(
        [
          { dir: "better-sqlite3@11.0.0", name: "better-sqlite3", version: "11.0.0" },
          { dir: "semver@7.6.3", name: "semver", version: "7.6.3" },
        ],
        SIMPLE_LOCK,
      );
      fs.chmodSync(path.join(depDir, ".pnpm", "lock.yaml"), 0o444);

      const result = prunePnpmBase(depDir, [SQLITE]);

      expect(result).toMatchObject({ ok: false });
      expect((result as { detail: string }).detail).toContain("could not be rewritten");
      // The tree really was modified first, so this is the post-removal path and not the read one.
      expectGone(path.join(depDir, ".pnpm", "better-sqlite3@11.0.0"));
    },
  );

  it("refuses a virtual-store entry whose package it cannot identify", () => {
    // A directory the prune cannot classify is a directory that might hold a package it has to
    // remove, so it fails closed rather than skipping the entry.
    const depDir = writeTree(
      [{ dir: "semver@7.6.3", name: "semver", version: "7.6.3" }],
      SIMPLE_LOCK,
    );
    fs.mkdirSync(path.join(depDir, ".pnpm", "mystery@1.0.0", "node_modules"), { recursive: true });

    const result = prunePnpmBase(depDir, [SQLITE]);
    expect(result).toMatchObject({ ok: false });
    expect((result as { detail: string }).detail).toContain("mystery@1.0.0");
  });
});

describe("findPruneRemnants", () => {
  it("names a hole in the tree the carried lockfile still papers over", () => {
    // The inconsistent pair the whole mechanism turns on: a bare `pnpm install` compares the
    // carried lockfile against the repo's, finds them equal, and reports "Already up to date"
    // with the package missing from the tree.
    const depDir = writeTree(
      [{ dir: "semver@7.6.3", name: "semver", version: "7.6.3" }],
      SIMPLE_LOCK,
    );
    fs.rmSync(path.join(depDir, ".pnpm-workspace-state-v1.json"));

    expect(findPruneRemnants(depDir, [SQLITE])).toContain("better-sqlite3@11.0.0");
  });

  it("names a package still in the tree after its lockfile entry went", () => {
    const depDir = writeTree(
      [
        { dir: "better-sqlite3@11.0.0", name: "better-sqlite3", version: "11.0.0" },
        { dir: "semver@7.6.3", name: "semver", version: "7.6.3" },
      ],
      {
        lockfileVersion: "9.0",
        importers: { ".": { dependencies: { semver: { specifier: "7.6.3", version: "7.6.3" } } } },
        packages: { "semver@7.6.3": {} },
        snapshots: { "semver@7.6.3": {} },
      },
    );
    fs.rmSync(path.join(depDir, ".pnpm-workspace-state-v1.json"));

    expect(findPruneRemnants(depDir, [SQLITE])).toContain("still holds better-sqlite3@11.0.0");
  });

  it("names carried install state, which hides the prune before the lockfile is read", () => {
    const depDir = writeTree(
      [{ dir: "semver@7.6.3", name: "semver", version: "7.6.3" }],
      {
        lockfileVersion: "9.0",
        importers: { ".": { dependencies: { semver: { specifier: "7.6.3", version: "7.6.3" } } } },
        packages: { "semver@7.6.3": {} },
        snapshots: { "semver@7.6.3": {} },
      },
    );

    expect(findPruneRemnants(depDir, [SQLITE])).toContain(".pnpm-workspace-state-v1.json");
  });

  it("passes on a consistent tree, so the checks above are not vacuous", () => {
    const depDir = writeTree(
      [{ dir: "semver@7.6.3", name: "semver", version: "7.6.3" }],
      {
        lockfileVersion: "9.0",
        importers: { ".": { dependencies: { semver: { specifier: "7.6.3", version: "7.6.3" } } } },
        packages: { "semver@7.6.3": {} },
        snapshots: { "semver@7.6.3": {} },
      },
    );
    fs.rmSync(path.join(depDir, ".pnpm-workspace-state-v1.json"));

    expect(findPruneRemnants(depDir, [SQLITE])).toBeNull();
  });

  it("reports an unreadable tree as a reason, never as a pass", () => {
    expect(findPruneRemnants(path.join(tmp, "absent"), [SQLITE])).not.toBeNull();
  });
});

describe("resolveLockEdge", () => {
  it.each([
    ["semver", "7.6.3", { name: "semver", version: "7.6.3" }],
    ["semver", "7.6.3(react@18.2.0)", { name: "semver", version: "7.6.3" }],
    ["sqlite", "better-sqlite3@11.0.0", { name: "better-sqlite3", version: "11.0.0" }],
    ["x", "@scope/native@2.0.0", { name: "@scope/native", version: "2.0.0" }],
    ["x", "1.0.0(patch_hash=abc)", { name: "x", version: "1.0.0" }],
  ])("reads %s: %s as its target", (name, raw, expected) => {
    expect(resolveLockEdge(name, raw)).toEqual(expected);
  });

  it.each([["lib", "link:../lib"], ["lib", "workspace:*"], ["lib", "file:../lib.tgz"], ["x", ""]])(
    "reads %s: %s as no registry target",
    (name, raw) => {
      expect(resolveLockEdge(name, raw)).toBeNull();
    },
  );
});
