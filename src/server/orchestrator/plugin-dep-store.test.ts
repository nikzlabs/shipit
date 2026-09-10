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
  describePluginDepStoreReason,
  livePluginStoreArtifacts,
  parsePluginBasePin,
  planPluginDepStore,
  pluginBasePin,
  pluginBasePinDir,
  pluginDepCacheDir,
  promotePluginDepDirs,
  type PluginDepStoreReasonKind,
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

function seedCheckout(lock: string): void {
  fs.writeFileSync(path.join(checkoutDir, "package.json"), `{"name":"probe"}`);
  fs.writeFileSync(path.join(checkoutDir, "package-lock.json"), lock);
}

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
  clearPluginBaseClaims();
  vi.unstubAllEnvs();
});

describe("planPluginDepStore", () => {
  it("plans a scope per declared dep dir when the install is content-keyable", () => {
    seedCheckout("{}");
    const plan = planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir }).plan;
    expect(plan?.dirs.map((d) => d.depDir)).toEqual(["node_modules", PLUGIN_TOOLCHAIN_DIR_NAME]);
    expect(plan?.installCommands).toEqual(["npm ci"]);
  });

  it("keys the scope on the REPOSITORY, not on what the consumer calls it (req 15)", () => {
    seedCheckout("{}");
    const one = planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir }).plan;
    const other = planPluginDepStore({ source: "acme/other", exports: [exportWith()], checkoutDir }).plan;
    expect(one?.dirs[0]!.scopeHash).not.toBe(other?.dirs[0]!.scopeHash);
  });

  it("re-keys when the dependency inputs change, and not when other files do", () => {
    seedCheckout("{}");
    const first = planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir }).plan;
    fs.writeFileSync(path.join(checkoutDir, "README.md"), "a source-only commit");
    const unchanged = planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir }).plan;
    expect(unchanged?.dirs[0]!.scopeHash).toBe(first?.dirs[0]!.scopeHash);

    seedCheckout(`{"lockfileVersion":3}`);
    const moved = planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir }).plan;
    expect(moved?.dirs[0]!.scopeHash).not.toBe(first?.dirs[0]!.scopeHash);
  });

  it("re-keys when the SET of selected exports changes", () => {
    seedCheckout("{}");
    const one = planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir }).plan;
    const two = planPluginDepStore({
      source: "acme/tools",
      exports: [exportWith(), exportWith({ name: "other", install: "npm ci --omit=dev" })],
      checkoutDir,
    }).plan;
    expect(two?.dirs[0]!.scopeHash).not.toBe(one?.dirs[0]!.scopeHash);
  });

  it("declines with a reason when nothing declares an install", () => {
    seedCheckout("{}");
    expect(planPluginDepStore({
      source: "acme/tools",
      exports: [exportWith({ install: undefined })],
      checkoutDir,
    })).toEqual({ plan: null, reason: { kind: "no-install" } });
  });

  it("declines when the install command is not a recognized pure dependency install", () => {
    seedCheckout("{}");
    expect(planPluginDepStore({
      source: "acme/tools",
      exports: [exportWith({ install: "./build.sh && npm ci" })],
      checkoutDir,
    })).toEqual({
      plan: null,
      reason: { kind: "unrecognized-install", subject: "probe", detail: "./build.sh && npm ci" },
    });
  });

  it("declines when there are no dependency input files to hash", () => {
    expect(planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir })).toEqual({
      plan: null,
      reason: { kind: "no-input-files", subject: "probe" },
    });
  });

  it("declines when a declared dep dir is tracked source rather than an artifact", () => {
    seedCheckout("{}");
    fs.mkdirSync(path.join(checkoutDir, "node_modules"), { recursive: true });
    expect(planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir })).toEqual({
      plan: null,
      reason: { kind: "tracked-dep-dir", subject: "node_modules" },
    });
  });

  it("declines under the OVERLAY_DEP_STORE kill switch", () => {
    seedCheckout("{}");
    expect(planPluginDepStore({
      source: "acme/tools",
      exports: [exportWith()],
      checkoutDir,
      env: { ...process.env, OVERLAY_DEP_STORE: "0" },
    })).toEqual({ plan: null, reason: { kind: "store-disabled" } });
  });

  it("declines when the repository's own package.json has an install lifecycle script", () => {
    seedCheckout("{}");
    fs.writeFileSync(
      path.join(checkoutDir, "package.json"),
      JSON.stringify({ name: "probe", scripts: { postinstall: "node scripts/build.js" } }),
    );
    expect(planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir })).toEqual({
      plan: null,
      reason: { kind: "install-lifecycle-script", subject: "probe" },
    });

    expect(planPluginDepStore({
      source: "acme/tools",
      exports: [exportWith({ installInputs: ["package.json", "package-lock.json", "scripts/build.js"] })],
      checkoutDir,
    }).plan).not.toBeNull();
  });

  it("keys on execution order, not a sorted one", () => {
    seedCheckout("{}");
    const a = exportWith({ name: "a", install: "npm ci" });
    const b = exportWith({ name: "b", install: "npm ci --omit=dev" });
    const forward = planPluginDepStore({ source: "acme/tools", exports: [a, b], checkoutDir }).plan;
    const reversed = planPluginDepStore({ source: "acme/tools", exports: [b, a], checkoutDir }).plan;
    expect(reversed?.dirs[0]!.scopeHash).not.toBe(forward?.dirs[0]!.scopeHash);
  });

  it("declines when an export opts out with an empty dep-dirs list", () => {
    seedCheckout("{}");
    expect(planPluginDepStore({
      source: "acme/tools",
      exports: [exportWith({ depDirs: [] })],
      checkoutDir,
    })).toEqual({ plan: null, reason: { kind: "no-dep-dirs" } });
  });
});

describe("promotePluginDepDirs", () => {
  it("moves the installed tree into the store and leaves the upper layer without it", async () => {
    seedCheckout("{}");
    seedInstalled();
    const plan = planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir }).plan!;

    const promoted = await promotePluginDepDirs({
      depStoreDir: root, plan, commit: COMMIT, upperDir, repoName: "tools",
    });
    const pins = promoted.map((p) => p.pin);

    expect(promoted).toEqual([
      { depDir: "node_modules", pin: pluginBasePin(plan.dirs[0]!.scopeHash, 1), lost: false },
      { depDir: PLUGIN_TOOLCHAIN_DIR_NAME, pin: pluginBasePin(plan.dirs[1]!.scopeHash, 1), lost: false },
    ]);
    expect(fs.existsSync(path.join(
      pluginBasePinDir(root, pins[1]!)!, PLUGIN_TOOLCHAIN_DIR_NAME, "playwright-browsers", "chromium-1194",
    ))).toBe(true);
    const genDir = pluginBasePinDir(root, pins[0]!)!;
    expect(fs.existsSync(path.join(genDir, "node_modules", "left-pad", "index.js"))).toBe(true);
    expect(fs.existsSync(path.join(upperDir, "node_modules"))).toBe(false);
  });

  it("records the content key on the pointer, so the scope is self-describing", async () => {
    seedCheckout("{}");
    seedInstalled();
    const plan = planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir }).plan!;
    await promotePluginDepDirs({ depStoreDir: root, plan, commit: COMMIT, upperDir, repoName: "tools" });

    const pointer = readBasePointerByHash(root, plan.dirs[0]!.scopeHash);
    expect(pointer?.commit).toBe(COMMIT);
    expect(pointer?.marker?.depsHash).toBe(plan.depsKey);
    expect(pointer?.marker?.installCommands).toEqual(["npm ci"]);
  });

  it("adopts an existing base instead of publishing a second generation", async () => {
    seedCheckout("{}");
    seedInstalled();
    const plan = planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir }).plan!;
    const first = (await promotePluginDepDirs({
      depStoreDir: root, plan, commit: COMMIT, upperDir, repoName: "tools",
    })).map((p) => p.pin);

    seedInstalled("module.exports = 2;\n");
    const second = (await promotePluginDepDirs({
      depStoreDir: root, plan, commit: "d".repeat(40), upperDir, repoName: "tools",
    })).map((p) => p.pin);

    expect(second).toEqual(first);
    expect(fs.readdirSync(path.join(root, "overlay-base", plan.dirs[0]!.scopeHash))).toEqual(["g1"]);
    expect(fs.existsSync(path.join(upperDir, "node_modules"))).toBe(false);
    expect(
      fs.readFileSync(path.join(pluginBasePinDir(root, first[0]!)!, "node_modules/left-pad/index.js"), "utf-8"),
    ).toBe("module.exports = 1;\n");
  });

  it("leaves a dep dir the install did not produce exactly where it is", async () => {
    seedCheckout("{}");
    const plan = planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir }).plan!;
    expect(await promotePluginDepDirs({
      depStoreDir: root, plan, commit: COMMIT, upperDir, repoName: "tools",
    })).toEqual([
      {
        depDir: "node_modules",
        pin: null,
        lost: false,
        reason: { kind: "nothing-installed", subject: "node_modules" },
      },
      {
        depDir: PLUGIN_TOOLCHAIN_DIR_NAME,
        pin: null,
        lost: false,
        reason: { kind: "nothing-installed", subject: PLUGIN_TOOLCHAIN_DIR_NAME },
      },
    ]);
    expect(readBasePointerByHash(root, plan.dirs[0]!.scopeHash)).toBeNull();
  });

  it("never follows a symlink into the shared store", async () => {
    seedCheckout("{}");
    fs.mkdirSync(path.join(root, "elsewhere"), { recursive: true });
    fs.writeFileSync(path.join(root, "elsewhere", "secret"), "not ours to share");
    fs.symlinkSync(path.join(root, "elsewhere"), path.join(upperDir, "node_modules"));
    const plan = planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir }).plan!;

    expect(await promotePluginDepDirs({
      depStoreDir: root, plan, commit: COMMIT, upperDir, repoName: "tools",
    })).toEqual([
      {
        depDir: "node_modules",
        pin: null,
        lost: false,
        reason: { kind: "not-a-directory", subject: "node_modules" },
      },
      {
        depDir: PLUGIN_TOOLCHAIN_DIR_NAME,
        pin: null,
        lost: false,
        reason: { kind: "nothing-installed", subject: PLUGIN_TOOLCHAIN_DIR_NAME },
      },
    ]);
    expect(fs.existsSync(path.join(root, "elsewhere", "secret"))).toBe(true);
  });

  it("reports a tree that reached neither place as LOST", async () => {
    seedCheckout("{}");
    seedInstalled();
    const plan = planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir }).plan!;
    // Fail the pointer write after the tree has already left the upper layer.
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

  it("says the store would not take a tree that is still in the writable layer", async () => {
    seedCheckout("{}");
    seedInstalled();
    const plan = planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir }).plan!;
    fs.writeFileSync(path.join(root, "overlay-base"), "not a directory");

    const promoted = await promotePluginDepDirs({
      depStoreDir: root, plan, commit: COMMIT, upperDir, repoName: "tools",
    });

    expect(promoted.every((p) => p.pin === null && !p.lost)).toBe(true);
    expect(promoted[0]!.reason?.kind).toBe("publish-failed");
    expect(promoted[0]!.reason?.subject).toBe("node_modules");
    expect(fs.existsSync(path.join(upperDir, "node_modules"))).toBe(true);
  });
});

describe("describePluginDepStoreReason", () => {
  const KINDS: PluginDepStoreReasonKind[] = [
    "store-disabled", "no-store", "no-install", "install-lifecycle-script",
    "unrecognized-install", "no-input-files", "no-dep-dirs", "tracked-dep-dir",
    "nothing-installed", "not-a-directory", "publish-failed",
  ];

  it("renders one complete sentence for every kind", () => {
    for (const kind of KINDS) {
      const text = describePluginDepStoreReason({ kind, subject: "probe", detail: "npm ci" });
      expect(text.length).toBeGreaterThan(20);
      expect(text.endsWith(".")).toBe(true);
      expect(text).toMatch(/installed from scratch in every session|stayed private to this install/);
    }
  });

  it("does not call a failed publish permanent", () => {
    const text = describePluginDepStoreReason({ kind: "publish-failed", subject: "node_modules" });
    expect(text).not.toContain("never shared");
    expect(text).toContain("will try again");
    expect(describePluginDepStoreReason({ kind: "nothing-installed", subject: "node_modules" }))
      .toContain("never shared");
  });

  it("tells an author what to declare when the install can be re-qualified", () => {
    for (const kind of ["unrecognized-install", "install-lifecycle-script"] as const) {
      expect(describePluginDepStoreReason({ kind, subject: "probe" })).toContain("`install-inputs:`");
    }
    expect(describePluginDepStoreReason({ kind: "store-disabled" })).not.toContain("install-inputs");
  });

  it("bounds what the manifest interpolates into it", () => {
    const text = describePluginDepStoreReason({
      kind: "unrecognized-install",
      subject: "p".repeat(500),
      detail: `npm ci ${"x".repeat(5000)}`,
    });
    expect(text.length).toBeLessThan(600);
    expect(text).toContain("npm ci xxx");
  });

  it("names the subject it has, and says something usable without one", () => {
    expect(describePluginDepStoreReason({ kind: "tracked-dep-dir", subject: "vendor/py" }))
      .toContain("`vendor/py`");
    expect(describePluginDepStoreReason({ kind: "no-dep-dirs" })).not.toContain("``");
  });
});

describe("adoptPluginDepBases", () => {
  it("returns every pin once each dep dir has a base", async () => {
    seedCheckout("{}");
    seedInstalled();
    const plan = planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir }).plan!;
    const promoted = await promotePluginDepDirs({
      depStoreDir: root, plan, commit: COMMIT, upperDir, repoName: "tools",
    });
    expect(adoptPluginDepBases(root, plan)).toEqual(promoted.map((p) => p.pin));
  });

  it("refuses when a pointer names a generation that is no longer on disk", async () => {
    seedCheckout("{}");
    seedInstalled();
    const plan = planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir }).plan!;
    await promotePluginDepDirs({ depStoreDir: root, plan, commit: COMMIT, upperDir, repoName: "tools" });

    fs.rmSync(overlayBaseGenDir(root, plan.dirs[0]!.scopeHash, 1), { recursive: true, force: true });
    expect(adoptPluginDepBases(root, plan)).toBeNull();
  });

  it("refuses when only some dep dirs have a base", async () => {
    seedCheckout("{}");
    fs.mkdirSync(path.join(upperDir, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(upperDir, "node_modules", "x"), "1");
    const exp = exportWith({ depDirs: ["node_modules", "tools/node_modules"] });
    const plan = planPluginDepStore({ source: "acme/tools", exports: [exp], checkoutDir }).plan!;
    await promotePluginDepDirs({ depStoreDir: root, plan, commit: COMMIT, upperDir, repoName: "tools" });

    expect(adoptPluginDepBases(root, plan)).toBeNull();
  });
});

describe("parsePluginBasePin", () => {
  it("fails closed on anything that is not a pin", () => {
    for (const bad of [null, 42, "", "..", "../../etc", "abc/g1", `${"a".repeat(16)}/g0`, { }]) {
      expect(parsePluginBasePin(bad)).toBeNull();
    }
    expect(parsePluginBasePin(`${"a".repeat(16)}/g7`)).toEqual({ scopeHash: "a".repeat(16), generation: 7 });
  });
});

describe("livePluginStoreArtifacts", () => {
  function session(workspaceDir: string, over: Partial<SessionInfo> = {}): SessionInfo {
    return { id: "s1", workspaceDir, ...over } as SessionInfo;
  }

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
    expect(live.cacheHashes.has(path.basename(pluginDepCacheDir("", "acme/tools")))).toBe(true);
    const { repoUrlToHash } = await import("./git-utils.js");
    expect(live.cacheHashes.has(repoUrlToHash("https://github.com/Acme/Tools.git"))).toBe(true);
  });

  it("reports a promotion no generation record can mention yet", async () => {
    seedCheckout("{}");
    seedInstalled();
    const plan = planPluginDepStore({ source: "acme/tools", exports: [exportWith()], checkoutDir }).plan!;
    await promotePluginDepDirs({ depStoreDir: root, plan, commit: COMMIT, upperDir, repoName: "tools" });

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
      await expect(livePluginStoreArtifacts([session(workspaceDir)])).rejects.toThrow();
    } finally {
      fs.chmodSync(generations, 0o755);
    }
  });

  it("protects the download cache from the DECLARATION, before any generation exists", async () => {
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
