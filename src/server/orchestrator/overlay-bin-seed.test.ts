import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BIN_SEED_MARKER_FILE,
  binSeedMarkerPath,
  packageBinTargets,
  resolvePnpmBinSeedSet,
  seedBinTargetsIntoUpper,
  seedOverlayBinTargetsOnce,
} from "./overlay-bin-seed.js";
import { PNPM_VERIFIED_NAMESPACE, type DepDirOverlaySpec } from "./overlay-session.js";

const tmpDirs: string[] = [];
const prevUid = process.env.SHIPIT_SESSION_WORKER_UID;
// `identityForTarget` reads this, and the seed's chown is not what these cells are about; the one
// that IS passes an explicit owner.
beforeEach(() => { delete process.env.SHIPIT_SESSION_WORKER_UID; });
afterEach(() => {
  if (prevUid === undefined) delete process.env.SHIPIT_SESSION_WORKER_UID;
  else process.env.SHIPIT_SESSION_WORKER_UID = prevUid;
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(file: string, body: string, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  fs.chmodSync(file, mode);
}

/** One package inside a pnpm virtual store, named the way pnpm names its directories. */
function pkg(
  treeRoot: string,
  name: string,
  manifest: object,
  files: Record<string, string> = {},
): string {
  const id = `${name.replace("/", "+")}@1.0.0`;
  const dir = path.join(treeRoot, ".pnpm", id, "node_modules", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", ...manifest }));
  for (const [rel, body] of Object.entries(files)) writeFile(path.join(dir, rel), body, 0o755);
  return dir;
}

describe("packageBinTargets — the set pnpm links executables from", () => {
  it("takes a string `bin`", () => {
    const root = tmp("seed-bin-string-");
    const dir = pkg(root, "one", { bin: "cli.js" }, { "cli.js": "x" });

    expect(packageBinTargets(dir)).toEqual(["cli.js"]);
  });

  it("takes every value of a `bin` map, including nested paths", () => {
    const root = tmp("seed-bin-map-");
    const dir = pkg(
      root,
      "two",
      { bin: { a: "bin/a.js", b: "./bin/b.js" } },
      { "bin/a.js": "a", "bin/b.js": "b" },
    );

    expect(packageBinTargets(dir).sort()).toEqual(["bin/a.js", "bin/b.js"]);
  });

  /**
   * `directories.bin` is enumerated RECURSIVELY — measured on pnpm 12.5.1, which wrote a `.bin`
   * shim for a file four levels down. A list that took only the directory's own files leaves the
   * deeper ones in the foreign-owned lower and the EPERM comes back for them.
   */
  it("takes every file under `directories.bin`, recursively", () => {
    const root = tmp("seed-dirbin-");
    const dir = pkg(root, "three", { directories: { bin: "tools" } }, {
      "tools/t.js": "t",
      "tools/a/l1.js": "1",
      "tools/a/b/l2.js": "2",
    });

    expect(packageBinTargets(dir)).toEqual([
      path.join("tools", "a", "b", "l2.js"),
      path.join("tools", "a", "l1.js"),
      path.join("tools", "t.js"),
    ]);
  });

  /**
   * Deliberately wider than pnpm: measured, a non-empty `bin` makes pnpm ignore `directories.bin`
   * (only `cli.js` got a shim). Seeding `t/t.js` anyway costs one byte-identical copy, while a
   * precedence rule this encoded and pnpm later changed would put the EPERM back — the two
   * mistakes are not the same size.
   */
  it("takes `bin` AND `directories.bin` when both are present", () => {
    const root = tmp("seed-both-");
    const dir = pkg(
      root,
      "four",
      { bin: "cli.js", directories: { bin: "tools" } },
      { "cli.js": "c", "tools/t.js": "t" },
    );

    expect(packageBinTargets(dir)).toEqual(["cli.js", path.join("tools", "t.js")]);
  });

  // pnpm falls through to `directories.bin` for `bin: ""` and not for `bin: {}` (measured); the
  // union covers both without having to keep that distinction right.
  it("falls through to `directories.bin` for an empty `bin`", () => {
    const root = tmp("seed-emptybin-");
    for (const bin of ["", {}] as const) {
      const dir = pkg(root, `five-${typeof bin}`, { bin, directories: { bin: "tools" } }, { "tools/t.js": "t" });
      expect(packageBinTargets(dir), JSON.stringify(bin)).toEqual([path.join("tools", "t.js")]);
    }
  });

  it("gives nothing for a package that declares neither", () => {
    const root = tmp("seed-none-");
    expect(packageBinTargets(pkg(root, "six", { main: "index.js" }, { "index.js": "i" }))).toEqual([]);
  });

  // A manifest is package-controlled input, and the seed copies whatever it names.
  it("skips a target that escapes its own package", () => {
    const root = tmp("seed-escape-");
    const dir = pkg(root, "seven", { bin: { evil: "../../../../etc/passwd", ok: "cli.js" } }, { "cli.js": "c" });
    // And a `directories.bin` that escapes contributes nothing either.
    pkg(root, "eight", { directories: { bin: "../.." } }, {});

    expect(packageBinTargets(dir)).toEqual(["cli.js"]);
  });

  it("skips a target that is missing, a directory, or a symlink", () => {
    const root = tmp("seed-shapes-");
    const dir = pkg(root, "nine", { bin: { a: "gone.js", b: "adir", c: "link.js", d: "real.js" } }, { "real.js": "r" });
    fs.mkdirSync(path.join(dir, "adir"));
    fs.symlinkSync(path.join(dir, "real.js"), path.join(dir, "link.js"));

    expect(packageBinTargets(dir)).toEqual(["real.js"]);
  });

  it("gives nothing for an unreadable or malformed manifest", () => {
    const root = tmp("seed-broken-");
    const dir = path.join(root, "broken");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), "{ not json");

    expect(packageBinTargets(dir)).toEqual([]);
    expect(packageBinTargets(path.join(root, "absent"))).toEqual([]);
  });
});

describe("resolvePnpmBinSeedSet — every executable target in a pnpm tree", () => {
  it("walks the virtual store, handles scoped packages, and sorts", () => {
    const root = tmp("seed-tree-");
    pkg(root, "alpha", { bin: "cli.js" }, { "cli.js": "a" });
    pkg(root, "@scope/beta", { bin: { beta: "bin/beta.js" } }, { "bin/beta.js": "b" });
    pkg(root, "gamma", { directories: { bin: "tools" } }, { "tools/g.js": "g" });
    pkg(root, "delta", {}, { "index.js": "d" });

    expect(resolvePnpmBinSeedSet(root)).toEqual([
      path.join(".pnpm", "@scope+beta@1.0.0", "node_modules", "@scope", "beta", "bin", "beta.js"),
      path.join(".pnpm", "alpha@1.0.0", "node_modules", "alpha", "cli.js"),
      path.join(".pnpm", "gamma@1.0.0", "node_modules", "gamma", "tools", "g.js"),
    ]);
  });

  /**
   * Each virtual-store entry links in its dependencies; only its own package directory is real.
   * Following a link would name the same file twice, under a path that is not where it lives.
   */
  it("does not follow the dependency symlinks a virtual-store entry carries", () => {
    const root = tmp("seed-links-");
    pkg(root, "alpha", { bin: "cli.js" }, { "cli.js": "a" });
    const consumer = pkg(root, "beta", {}, { "index.js": "b" });
    fs.symlinkSync(
      path.join(root, ".pnpm", "alpha@1.0.0", "node_modules", "alpha"),
      path.join(path.dirname(consumer), "alpha"),
    );

    expect(resolvePnpmBinSeedSet(root)).toEqual([
      path.join(".pnpm", "alpha@1.0.0", "node_modules", "alpha", "cli.js"),
    ]);
  });

  it("gives nothing for a tree with no virtual store", () => {
    expect(resolvePnpmBinSeedSet(tmp("seed-empty-"))).toEqual([]);
  });
});

describe("seedBinTargetsIntoUpper", () => {
  function fixture(): { lower: string; upper: string } {
    const root = tmp("seed-copy-");
    const lower = path.join(root, "lower");
    const upper = path.join(root, "upper");
    fs.mkdirSync(upper, { recursive: true });
    pkg(lower, "alpha", { bin: "bin/cli.js" }, { "bin/cli.js": "#!/usr/bin/env node\nalpha\n" });
    return { lower, upper };
  }

  it("copies each target byte-identically, with the base's mode, into the upper", () => {
    const { lower, upper } = fixture();
    const rel = path.join(".pnpm", "alpha@1.0.0", "node_modules", "alpha", "bin", "cli.js");
    fs.chmodSync(path.join(lower, rel), 0o775);
    // The lower's directories carry the group write `shareTreeOnce` gives a published base.
    fs.chmodSync(path.join(lower, ".pnpm"), 0o2775);

    const result = seedBinTargetsIntoUpper({ lowerdir: lower, upperdir: upper, owner: null });

    expect(result).toEqual({ files: 1, bytes: 26, present: 0, failed: 0 });
    expect(fs.readFileSync(path.join(upper, rel))).toEqual(fs.readFileSync(path.join(lower, rel)));
    expect(fs.lstatSync(path.join(upper, rel)).mode & 0o7777).toBe(0o775);
    // The merged view shows the UPPER directory's mode, so a copied-up directory must keep the
    // base's group write or a Compose service loses it (docs/271 §3).
    expect(fs.lstatSync(path.join(upper, ".pnpm")).mode & 0o7777).toBe(0o2775);
    // Nothing is staged where the agent can trip over it.
    expect(fs.readdirSync(path.dirname(path.join(upper, rel)))).toEqual(["cli.js"]);
  });

  /**
   * Ownership is the point of the seed, not a nicety: a copy the session does not own leaves pnpm's
   * chmod EPERMing on it exactly as the base file did. So a chown that fails is a FAILED seed.
   */
  it("hands each copy to the session, and counts a chown it cannot do as a failure", () => {
    const uid = process.getuid?.(); const gid = process.getgid?.();
    if (uid === undefined || gid === undefined) return;
    const { lower, upper } = fixture();
    const rel = path.join(".pnpm", "alpha@1.0.0", "node_modules", "alpha", "bin", "cli.js");

    expect(seedBinTargetsIntoUpper({ lowerdir: lower, upperdir: upper, owner: { uid, gid } }))
      .toMatchObject({ files: 1, failed: 0 });
    expect(fs.lstatSync(path.join(upper, rel)).uid).toBe(uid);

    const other = fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A uid this process cannot chown to; the copy must not be left behind claiming success.
    const result = seedBinTargetsIntoUpper({
      lowerdir: other.lower, upperdir: other.upper, owner: { uid: uid + 1, gid: gid + 1 },
    });

    expect(result).toMatchObject({ files: 0, failed: 1 });
    expect(fs.existsSync(path.join(other.upper, rel))).toBe(false);
    warn.mockRestore();
  });

  /**
   * The one way this repair could destroy work: the upper holds the agent's own edit to a
   * dependency (docs/276 req 11), and the base's copy must never go back over it.
   */
  it("leaves an entry the upper already has alone", () => {
    const { lower, upper } = fixture();
    const rel = path.join(".pnpm", "alpha@1.0.0", "node_modules", "alpha", "bin", "cli.js");
    writeFile(path.join(upper, rel), "the agent's own edit\n", 0o755);

    const result = seedBinTargetsIntoUpper({ lowerdir: lower, upperdir: upper, owner: null });

    expect(result).toMatchObject({ files: 0, present: 1, failed: 0 });
    expect(fs.readFileSync(path.join(upper, rel), "utf8")).toBe("the agent's own edit\n");
  });

  // The upper is session-controlled, so a component of the destination path can be anything.
  it("refuses to seed through a symlink the upper has on the path", () => {
    const { lower, upper } = fixture();
    const elsewhere = path.join(path.dirname(upper), "elsewhere");
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.symlinkSync(elsewhere, path.join(upper, ".pnpm"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = seedBinTargetsIntoUpper({ lowerdir: lower, upperdir: upper, owner: null });

    expect(result).toMatchObject({ files: 0, failed: 1 });
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    warn.mockRestore();
  });

  it("counts a target it cannot read as a failure rather than seeding nothing else", () => {
    const { lower, upper } = fixture();
    pkg(lower, "beta", { bin: "cli.js" }, { "cli.js": "b" });
    fs.rmSync(path.join(lower, ".pnpm", "beta@1.0.0", "node_modules", "beta", "cli.js"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // The resolver would have dropped the missing file, so name it explicitly.
    const result = seedBinTargetsIntoUpper({
      lowerdir: lower,
      upperdir: upper,
      owner: null,
      targets: [
        path.join(".pnpm", "alpha@1.0.0", "node_modules", "alpha", "bin", "cli.js"),
        path.join(".pnpm", "beta@1.0.0", "node_modules", "beta", "cli.js"),
      ],
    });

    expect(result).toMatchObject({ files: 1, failed: 1 });
    warn.mockRestore();
  });
});

describe("seedOverlayBinTargetsOnce", () => {
  function specFor(root: string, opts: { namespace?: string } = {}): DepDirOverlaySpec {
    const lowerdir = path.join(root, "base");
    const upperdir = path.join(root, "g3", "upper");
    fs.mkdirSync(upperdir, { recursive: true });
    pkg(lowerdir, "alpha", { bin: "cli.js" }, { "cli.js": "a" });
    return {
      volumeName: "v", lowerdir: "/container/lower", upperdir: "/container/upper", workdir: "/container/work",
      depDir: "node_modules",
      mountPath: "/workspace/node_modules",
      scope: {
        repoUrl: "git@github.com:acme/app.git",
        runtimeKey: "rt",
        depDir: "node_modules",
        ...("namespace" in opts ? { namespace: opts.namespace } : { namespace: PNPM_VERIFIED_NAMESPACE }),
      },
      scopeHash: "abcd",
      generation: 3,
      orchDirs: { lowerdir, upperdir, workdir: path.join(root, "g3", "work"), sessionScopeDir: root },
    } as DepDirOverlaySpec;
  }

  it("seeds a fresh upper and records the cost in a marker beside it", () => {
    const root = tmp("seed-once-");
    const spec = specFor(root);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = seedOverlayBinTargetsOnce(spec, { tag: "[overlay:s1]" });

    expect(result).toMatchObject({ files: 1, failed: 0 });
    const marker = binSeedMarkerPath(spec.orchDirs!.upperdir);
    expect(path.basename(marker)).toBe(BIN_SEED_MARKER_FILE);
    // Beside the upper, never inside it: the upper is the tree the agent sees.
    expect(path.dirname(marker)).toBe(path.dirname(spec.orchDirs!.upperdir));
    expect(JSON.parse(fs.readFileSync(marker, "utf8"))).toMatchObject({ version: 1, files: 1 });
    expect(log.mock.calls[0]?.[0]).toContain("planning#606");
  });

  /**
   * Seed-once, stated as the thing it protects: within a generation the upper is REUSED across
   * container restarts, so a second seed would put the base's copy back over the agent's edit.
   */
  it("does not seed again over a reused upper, and cannot clobber an edit made there", () => {
    const root = tmp("seed-reuse-");
    const spec = specFor(root);
    vi.spyOn(console, "log").mockImplementation(() => {});
    seedOverlayBinTargetsOnce(spec);

    const seeded = path.join(spec.orchDirs!.upperdir, ".pnpm", "alpha@1.0.0", "node_modules", "alpha", "cli.js");
    fs.writeFileSync(seeded, "the agent's own edit\n");

    expect(seedOverlayBinTargetsOnce(spec)).toBeNull();
    expect(fs.readFileSync(seeded, "utf8")).toBe("the agent's own edit\n");
  });

  it("leaves no marker when the seed was incomplete, so the next start retries it", () => {
    const root = tmp("seed-partial-");
    const spec = specFor(root);
    fs.symlinkSync(root, path.join(spec.orchDirs!.upperdir, ".pnpm"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(seedOverlayBinTargetsOnce(spec)).toMatchObject({ failed: 1 });
    expect(fs.existsSync(binSeedMarkerPath(spec.orchDirs!.upperdir))).toBe(false);
    expect(error.mock.calls[0]?.[0]).toContain("planning#606");
    warn.mockRestore();
    error.mockRestore();
  });

  // Only a verified pnpm base has a lower whose files the session cannot chmod.
  it("does nothing for an overlay outside the verified pnpm namespace", () => {
    const root = tmp("seed-npm-");
    const spec = specFor(root, { namespace: undefined });

    expect(seedOverlayBinTargetsOnce(spec)).toBeNull();
    expect(fs.existsSync(binSeedMarkerPath(spec.orchDirs!.upperdir))).toBe(false);
  });
});
