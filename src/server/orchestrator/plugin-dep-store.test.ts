/**
 * docs/262 req 28 — the plugin half of the shared dependency store.
 *
 * The three properties these tests exist to hold, in the order they matter:
 *
 *  - **req 15** — a base is keyed by the REPOSITORY a generation came from, so a
 *    re-pointed declaration can never be handed the previous repository's
 *    installed tree, and by the CONTENT of the install's inputs, so a base can
 *    never be a stale answer to a newer question.
 *  - **req 19** — nothing here is reachable from plugin code. The promotion is
 *    a rename the orchestrator performs, and the assertions below are about
 *    where the tree ends up, not about a container being told anything.
 *  - **the sweep** — a base a live generation pins must be reported live, or the
 *    disk janitor removes an overlay lowerdir out from under a mount.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionInfo } from "../shared/types.js";
import type { PluginExport } from "../shared/plugin-repos.js";
import { readBasePointerByHash } from "./overlay-base.js";
import { overlayBaseGenDir } from "./overlay-volume.js";
import {
  adoptPluginDepBases,
  clearPluginBaseClaims,
  livePluginStoreArtifacts,
  parsePluginBasePin,
  planPluginDepStore,
  pluginBasePin,
  pluginBasePinDir,
  pluginDepCacheDir,
  promotePluginDepDirs,
} from "./plugin-dep-store.js";
import { PLUGIN_TOOLCHAIN_DIR_NAME } from "./plugin-container-env.js";

const COMMIT = "c".repeat(40);

function exportWith(over: Partial<PluginExport> = {}): PluginExport {
  return {
    name: "probe",
    cli: {},
    install: "npm ci",
    installInputs: [],
    depDirs: ["node_modules"],
    credentials: [],
    hosts: [],
    settings: {},
    ...over,
  };
}

let root: string;
let checkoutDir: string;
let upperDir: string;

/** A checkout whose lockfile content decides the store scope. */
function seedCheckout(lock: string): void {
  fs.writeFileSync(path.join(checkoutDir, "package.json"), `{"name":"probe"}`);
  fs.writeFileSync(path.join(checkoutDir, "package-lock.json"), lock);
}

/**
 * What an install leaves behind in the generation's writable layer — including
 * the ShipIt-owned toolchain tree, which the install container creates
 * unconditionally (`plugin-container-env.ts`, `PLUGIN_TOOLCHAIN_DIRS`). Seeded
 * here because its promotion is part of the same lifecycle: a fixture that
 * omitted it could not fail on the store hit losing a downloaded browser.
 */
function seedInstalled(contents = "module.exports = 1;\n"): void {
  fs.mkdirSync(path.join(upperDir, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(upperDir, "node_modules", "left-pad", "index.js"), contents);
  fs.mkdirSync(path.join(upperDir, PLUGIN_TOOLCHAIN_DIR_NAME, "playwright-browsers"), { recursive: true });
  fs.writeFileSync(
    path.join(upperDir, PLUGIN_TOOLCHAIN_DIR_NAME, "playwright-browsers", "chromium-1194"),
    "a browser the install downloaded",
  );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-dep-store-"));
  checkoutDir = path.join(root, "checkout");
  upperDir = path.join(root, "upper");
  fs.mkdirSync(checkoutDir, { recursive: true });
  fs.mkdirSync(upperDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  // The in-flight claim map is module state, shared across cases here the way
  // it is shared across sessions in the process.
  clearPluginBaseClaims();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// planPluginDepStore
// ---------------------------------------------------------------------------

describe("planPluginDepStore", () => {
  it("plans a scope per declared dep dir when the install is content-keyable", () => {
    seedCheckout("{}");
    const plan = planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir });
    // The declared dir, plus ShipIt's own toolchain tree — see
    // `planPluginDepStore`. Without the second one a store hit would clear the
    // writable layer and skip the install, leaving a plugin that downloaded a
    // browser at install time with no browser and nothing naming the cause.
    expect(plan?.dirs.map((d) => d.depDir)).toEqual(["node_modules", PLUGIN_TOOLCHAIN_DIR_NAME]);
    expect(plan?.installCommands).toEqual(["npm ci"]);
  });

  it("keys the scope on the REPOSITORY, not on what the consumer calls it (req 15)", () => {
    seedCheckout("{}");
    const one = planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir });
    const other = planPluginDepStore({ source: "acme/other", exports: [exportWith()], checkoutDir });
    // Same declaration name, same dep dir, same runtime, same lockfile — and
    // still nothing in common, because the repository differs.
    expect(one?.dirs[0]!.scopeHash).not.toBe(other?.dirs[0]!.scopeHash);
  });

  it("re-keys when the dependency inputs change, and not when other files do", () => {
    seedCheckout("{}");
    const first = planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir });
    fs.writeFileSync(path.join(checkoutDir, "README.md"), "a source-only commit");
    const unchanged = planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir });
    expect(unchanged?.dirs[0]!.scopeHash).toBe(first?.dirs[0]!.scopeHash);

    seedCheckout(`{"lockfileVersion":3}`);
    const moved = planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir });
    expect(moved?.dirs[0]!.scopeHash).not.toBe(first?.dirs[0]!.scopeHash);
  });

  it("re-keys when the SET of selected exports changes", () => {
    seedCheckout("{}");
    const one = planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir });
    const two = planPluginDepStore({
      source: "acme/tools",
      exports: [exportWith(), exportWith({ name: "other", install: "npm ci --omit=dev" })],
      checkoutDir,
    });
    // Two consumers of one repository that select different plugins run
    // different installs, so they must not share one tree.
    expect(two?.dirs[0]!.scopeHash).not.toBe(one?.dirs[0]!.scopeHash);
  });

  it("declines when nothing declares an install", () => {
    seedCheckout("{}");
    expect(planPluginDepStore({
      source: "acme/tools",
      exports: [exportWith({ install: undefined })],
      checkoutDir,
    })).toBeNull();
  });

  it("declines when the install command is not a recognized pure dependency install", () => {
    seedCheckout("{}");
    // docs/198's codegen-safety rule: such a command can change its output
    // without the hashed inputs moving, so a hit would be a wrong tree in every
    // consumer, not just this one.
    expect(planPluginDepStore({
      source: "acme/tools",
      exports: [exportWith({ install: "./build.sh && npm ci" })],
      checkoutDir,
    })).toBeNull();
  });

  it("declines when there are no dependency input files to hash", () => {
    expect(planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir })).toBeNull();
  });

  it("declines when a declared dep dir is tracked source rather than an artifact", () => {
    seedCheckout("{}");
    fs.mkdirSync(path.join(checkoutDir, "node_modules"), { recursive: true });
    expect(planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir })).toBeNull();
  });

  it("declines under the OVERLAY_DEP_STORE kill switch", () => {
    seedCheckout("{}");
    expect(planPluginDepStore({
      source: "acme/tools",
      exports: [exportWith()],
      checkoutDir,
      env: { ...process.env, OVERLAY_DEP_STORE: "0" },
    })).toBeNull();
  });

  it("declines when the repository's own package.json has an install lifecycle script", () => {
    seedCheckout("{}");
    // `npm ci` runs `postinstall`, so a commit that changes only
    // `scripts/build.js` produces a DIFFERENT tree under an identical key — and
    // a hit would skip the build and serve the previous commit's output.
    fs.writeFileSync(
      path.join(checkoutDir, "package.json"),
      JSON.stringify({ name: "probe", scripts: { postinstall: "node scripts/build.js" } }),
    );
    expect(planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir })).toBeNull();

    // Declaring install-inputs is the author saying what the install consumes,
    // and it REPLACES the default set — so the store is available again.
    expect(planPluginDepStore({
      source: "acme/tools",
      exports: [exportWith({ installInputs: ["package.json", "package-lock.json", "scripts/build.js"] })],
      checkoutDir,
    })).not.toBeNull();
  });

  it("keys on execution order, not a sorted one", () => {
    seedCheckout("{}");
    const a = exportWith({ name: "a", install: "npm ci" });
    const b = exportWith({ name: "b", install: "npm ci --omit=dev" });
    // The installs run in manifest order and their result depends on it, so the
    // two orderings are two dep states and must not share a base.
    const forward = planPluginDepStore({ source: "acme/tools", exports: [a, b], checkoutDir });
    const reversed = planPluginDepStore({ source: "acme/tools", exports: [b, a], checkoutDir });
    expect(reversed?.dirs[0]!.scopeHash).not.toBe(forward?.dirs[0]!.scopeHash);
  });

  it("declines when an export opts out with an empty dep-dirs list", () => {
    seedCheckout("{}");
    expect(planPluginDepStore({
      source: "acme/tools",
      exports: [exportWith({ depDirs: [] })],
      checkoutDir,
    })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// promote + adopt
// ---------------------------------------------------------------------------

describe("promotePluginDepDirs", () => {
  it("moves the installed tree into the store and leaves the upper layer without it", async () => {
    seedCheckout("{}");
    seedInstalled();
    const plan = planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir })!;

    const promoted = await promotePluginDepDirs({
      depStoreDir: root, plan, commit: COMMIT, upperDir, repoName: "tools",
    });
    const pins = promoted.map((p) => p.pin);

    expect(promoted).toEqual([
      { depDir: "node_modules", pin: pluginBasePin(plan.dirs[0]!.scopeHash, 1), lost: false },
      { depDir: PLUGIN_TOOLCHAIN_DIR_NAME, pin: pluginBasePin(plan.dirs[1]!.scopeHash, 1), lost: false },
    ]);
    // The toolchain tree reaches the store on the same terms as a declared dir,
    // which is what makes it survive a later generation's store hit.
    expect(fs.existsSync(path.join(
      pluginBasePinDir(root, pins[1]!)!, PLUGIN_TOOLCHAIN_DIR_NAME, "playwright-browsers", "chromium-1194",
    ))).toBe(true);
    // The base tree is rooted at the dep dir's own relative path, because it is
    // stacked as a lowerdir of the plugin ROOT — not mounted at the dep dir.
    const genDir = pluginBasePinDir(root, pins[0]!)!;
    expect(fs.existsSync(path.join(genDir, "node_modules", "left-pad", "index.js"))).toBe(true);
    // And it is a move: two copies of a `node_modules` would be exactly the
    // disk cost the shared store exists to remove.
    expect(fs.existsSync(path.join(upperDir, "node_modules"))).toBe(false);
  });

  it("records the content key on the pointer, so the scope is self-describing", async () => {
    seedCheckout("{}");
    seedInstalled();
    const plan = planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir })!;
    await promotePluginDepDirs({ depStoreDir: root, plan, commit: COMMIT, upperDir, repoName: "tools" });

    const pointer = readBasePointerByHash(root, plan.dirs[0]!.scopeHash);
    expect(pointer?.commit).toBe(COMMIT);
    expect(pointer?.marker?.depsHash).toBe(plan.depsKey);
    expect(pointer?.marker?.installCommands).toEqual(["npm ci"]);
  });

  it("adopts an existing base instead of publishing a second generation", async () => {
    seedCheckout("{}");
    seedInstalled();
    const plan = planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir })!;
    const first = (await promotePluginDepDirs({
      depStoreDir: root, plan, commit: COMMIT, upperDir, repoName: "tools",
    })).map((p) => p.pin);

    // A second session installs the same dep state and offers its own tree.
    seedInstalled("module.exports = 2;\n");
    const second = (await promotePluginDepDirs({
      depStoreDir: root, plan, commit: "d".repeat(40), upperDir, repoName: "tools",
    })).map((p) => p.pin);

    expect(second).toEqual(first);
    // One generation per content scope — which is also what keeps the janitor's
    // "keep the pointer's current generation" rule sufficient.
    expect(fs.readdirSync(path.join(root, "overlay-base", plan.dirs[0]!.scopeHash))).toEqual(["g1"]);
    // The loser drops its own copy rather than keeping a second one.
    expect(fs.existsSync(path.join(upperDir, "node_modules"))).toBe(false);
    expect(
      fs.readFileSync(path.join(pluginBasePinDir(root, first[0]!)!, "node_modules/left-pad/index.js"), "utf-8"),
    ).toBe("module.exports = 1;\n");
  });

  it("leaves a dep dir the install did not produce exactly where it is", async () => {
    seedCheckout("{}");
    const plan = planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir })!;
    // Not a loss — a declared dep dir this install does not populate is an
    // ordinary, complete outcome.
    expect(await promotePluginDepDirs({
      depStoreDir: root, plan, commit: COMMIT, upperDir, repoName: "tools",
    })).toEqual([
      { depDir: "node_modules", pin: null, lost: false },
      { depDir: PLUGIN_TOOLCHAIN_DIR_NAME, pin: null, lost: false },
    ]);
    expect(readBasePointerByHash(root, plan.dirs[0]!.scopeHash)).toBeNull();
  });

  it("never follows a symlink into the shared store", async () => {
    seedCheckout("{}");
    fs.mkdirSync(path.join(root, "elsewhere"), { recursive: true });
    fs.writeFileSync(path.join(root, "elsewhere", "secret"), "not ours to share");
    fs.symlinkSync(path.join(root, "elsewhere"), path.join(upperDir, "node_modules"));
    const plan = planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir })!;

    expect(await promotePluginDepDirs({
      depStoreDir: root, plan, commit: COMMIT, upperDir, repoName: "tools",
    })).toEqual([
      { depDir: "node_modules", pin: null, lost: false },
      { depDir: PLUGIN_TOOLCHAIN_DIR_NAME, pin: null, lost: false },
    ]);
    expect(fs.existsSync(path.join(root, "elsewhere", "secret"))).toBe(true);
  });

  it("reports a tree that reached neither place as LOST", async () => {
    seedCheckout("{}");
    seedInstalled();
    const plan = planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir })!;
    // The pointer directory is a file, so the write inside `publishBase` fails
    // AFTER the materialize rename has already emptied the upper layer — the one
    // shape that leaves install output in neither place.
    fs.writeFileSync(path.join(root, "overlay-base-meta"), "not a directory");

    const promoted = await promotePluginDepDirs({
      depStoreDir: root, plan, commit: COMMIT, upperDir, repoName: "tools",
    });

    expect(promoted).toEqual([
      { depDir: "node_modules", pin: null, lost: true },
      { depDir: PLUGIN_TOOLCHAIN_DIR_NAME, pin: null, lost: true },
    ]);
    expect(fs.existsSync(path.join(upperDir, "node_modules"))).toBe(false);
  });
});

describe("adoptPluginDepBases", () => {
  it("returns every pin once each dep dir has a base", async () => {
    seedCheckout("{}");
    seedInstalled();
    const plan = planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir })!;
    const promoted = await promotePluginDepDirs({
      depStoreDir: root, plan, commit: COMMIT, upperDir, repoName: "tools",
    });
    expect(adoptPluginDepBases(root, plan)).toEqual(promoted.map((p) => p.pin));
  });

  it("refuses when a pointer names a generation that is no longer on disk", async () => {
    seedCheckout("{}");
    seedInstalled();
    const plan = planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir })!;
    await promotePluginDepDirs({ depStoreDir: root, plan, commit: COMMIT, upperDir, repoName: "tools" });

    // A sweep took the tree but left the pointer. Reusing it would build an
    // overlay whose lowerdir does not exist — a failure at container start,
    // far from its cause.
    fs.rmSync(overlayBaseGenDir(root, plan.dirs[0]!.scopeHash, 1), { recursive: true, force: true });
    expect(adoptPluginDepBases(root, plan)).toBeNull();
  });

  it("refuses when only some dep dirs have a base", async () => {
    seedCheckout("{}");
    fs.mkdirSync(path.join(upperDir, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(upperDir, "node_modules", "x"), "1");
    const exp = exportWith({ depDirs: ["node_modules", "tools/node_modules"] });
    const plan = planPluginDepStore({ source: "acme/tools", exports: [exp], checkoutDir })!;
    await promotePluginDepDirs({ depStoreDir: root, plan, commit: COMMIT, upperDir, repoName: "tools" });

    // Skipping the install with only half the tree available would leave the
    // plugin with dependencies nothing will ever complete.
    expect(adoptPluginDepBases(root, plan)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// pins
// ---------------------------------------------------------------------------

describe("parsePluginBasePin", () => {
  it("fails closed on anything that is not a pin", () => {
    // These come off disk, out of a record a previous ShipIt wrote.
    for (const bad of [null, 42, "", "..", "../../etc", "abc/g1", `${"a".repeat(16)}/g0`, { }]) {
      expect(parsePluginBasePin(bad)).toBeNull();
    }
    expect(parsePluginBasePin(`${"a".repeat(16)}/g7`)).toEqual({ scopeHash: "a".repeat(16), generation: 7 });
  });
});

// ---------------------------------------------------------------------------
// the sweep's liveness source
// ---------------------------------------------------------------------------

describe("livePluginStoreArtifacts", () => {
  function session(workspaceDir: string, over: Partial<SessionInfo> = {}): SessionInfo {
    return { id: "s1", workspaceDir, ...over } as SessionInfo;
  }

  /** A session tree with one plugin generation pinning `pins`. */
  function seedSession(name: string, pins: string[], source = "acme/tools"): string {
    const sessionDir = path.join(root, name);
    const workspaceDir = path.join(sessionDir, "workspace");
    const genDir = path.join(sessionDir, "state", "plugins", "tools", "generations", COMMIT);
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(genDir, { recursive: true });
    fs.writeFileSync(
      path.join(genDir, ".shipit-generation.json"),
      JSON.stringify({ repoName: "tools", source, commit: COMMIT, basePins: pins }),
    );
    fs.writeFileSync(
      path.join(workspaceDir, "shipit.yaml"),
      `plugins:\n  repos:\n    - name: tools\n      repo: Acme/Tools\n  use:\n    - from: tools\n      plugin: probe\n`,
    );
    return workspaceDir;
  }

  it("reports the bases a generation pins, so the sweep cannot take a live lowerdir", async () => {
    const pin = pluginBasePin("a".repeat(16), 3);
    const live = await livePluginStoreArtifacts([session(seedSession("one", [pin]))]);
    expect(live.scopeHashes.has("a".repeat(16))).toBe(true);
  });

  it("reports the download cache AND the bare cache of every declared repository", async () => {
    const live = await livePluginStoreArtifacts([session(seedSession("one", []))]);
    // The download cache, keyed by the repository the generation came from…
    expect(live.cacheHashes.has(path.basename(pluginDepCacheDir("", "acme/tools")))).toBe(true);
    // …and the bare git cache, keyed on the clone URL byte-for-byte — which is
    // why it is read from the declaration, whose case `destinationKey` has lost.
    const { repoUrlToHash } = await import("./git-utils.js");
    expect(live.cacheHashes.has(repoUrlToHash("https://github.com/Acme/Tools.git"))).toBe(true);
  });

  it("reports a promotion no generation record can mention yet", async () => {
    seedCheckout("{}");
    seedInstalled();
    const plan = planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir })!;
    await promotePluginDepDirs({ depStoreDir: root, plan, commit: COMMIT, upperDir, repoName: "tools" });

    // No session has published a generation naming this base yet — the record is
    // written after the install returns, behind the phase-3 gate and the publish
    // window. A sweep in that gap must not read it as an orphan.
    const live = await livePluginStoreArtifacts([]);
    expect(live.scopeHashes.has(plan.dirs[0]!.scopeHash)).toBe(true);
  });

  it("refuses to answer when a generation tree cannot be read", async () => {
    const workspaceDir = seedSession("unreadable", [pluginBasePin("c".repeat(16), 1)]);
    const generations = path.join(
      path.dirname(workspaceDir), "state", "plugins", "tools", "generations",
    );
    fs.chmodSync(generations, 0o000);
    try {
      // Silently reading an unreadable tree as "no generations" would report
      // that nothing pins these bases — to a sweep that then deletes them.
      await expect(livePluginStoreArtifacts([session(workspaceDir)])).rejects.toThrow();
    } finally {
      fs.chmodSync(generations, 0o755);
    }
  });

  it("protects the download cache from the DECLARATION, before any generation exists", async () => {
    // The install creates and mounts `/dep-cache` on a repository's very first
    // activation, long before a record could name it.
    const workspaceDir = seedSession("fresh", []);
    fs.rmSync(path.join(path.dirname(workspaceDir), "state"), { recursive: true, force: true });
    const live = await livePluginStoreArtifacts([session(workspaceDir)]);
    expect(live.cacheHashes.has(path.basename(pluginDepCacheDir("", "acme/tools")))).toBe(true);
  });

  it("ignores an evicted session, whose state dir is gone anyway", async () => {
    const pin = pluginBasePin("b".repeat(16), 1);
    const live = await livePluginStoreArtifacts([
      session(seedSession("two", [pin]), { diskTier: "evicted" }),
    ]);
    expect(live.scopeHashes.size).toBe(0);
  });

  it("keeps nothing alive for a generation whose source nothing recorded", async () => {
    const sessionDir = path.join(root, "three");
    const workspaceDir = path.join(sessionDir, "workspace");
    const genDir = path.join(sessionDir, "state", "plugins", "tools", "generations", COMMIT);
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(genDir, { recursive: true });
    fs.writeFileSync(path.join(genDir, ".shipit-generation.json"), JSON.stringify({ repoName: "tools" }));

    const live = await livePluginStoreArtifacts([session(workspaceDir)]);
    expect(live.cacheHashes.size).toBe(0);
    expect(live.scopeHashes.size).toBe(0);
  });
});
