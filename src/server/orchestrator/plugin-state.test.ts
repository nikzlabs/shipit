/**
 * docs/262 reqs 17, 18, 26 — the per-import primitives: where the shared state
 * directory lives, what survives a refresh, and what "validated settings" means.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPluginImportResolver,
  pluginDataRoot,
  pluginSettingsIssuesByRepo,
  pluginSettingsPath,
  pluginStateDir,
  preparePluginState,
  resolvePluginSettings,
  sessionRootForWorkspace,
} from "./plugin-state.js";
import { REGENERABLE_SESSION_SUBDIRS, reclaimRegenerableSessionDirs } from "./disk-utils.js";
import { resolveLiveGenerations } from "./plugin-generations.js";
import type { PluginExport, PluginReposConfig, PluginUse } from "../shared/plugin-repos.js";
import type { PluginImportResolver } from "./plugin-state.js";

let tmp: string;
let sessionDir: string;
let workspaceDir: string;
let stateDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-state-"));
  sessionDir = path.join(tmp, "session");
  workspaceDir = path.join(sessionDir, "workspace");
  stateDir = path.join(sessionDir, "state");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeExport(over: Partial<PluginExport> = {}): PluginExport {
  return {
    name: "requirements",
    cli: {},
    installInputs: [],
    credentials: [],
    hosts: [],
    settings: {},
    ...over,
  };
}

function makeUse(over: Partial<PluginUse> = {}): PluginUse {
  return {
    plugin: "requirements",
    from: "game-tools",
    alias: "reqs",
    overrides: { services: {}, commands: {}, settings: {} },
    ...over,
  };
}

/** This "operation's" live generations — what production resolves once per pass. */
function liveFor(plugins: PluginReposConfig): ReturnType<typeof resolveLiveGenerations> {
  return resolveLiveGenerations(stateDir, plugins.repos);
}

function readSettings(alias: string): unknown {
  return JSON.parse(fs.readFileSync(pluginSettingsPath(sessionDir, alias), "utf-8"));
}

// ---------------------------------------------------------------------------

describe("layout", () => {
  it("survives the reclaim archive and disk eviction actually run (req 18)", async () => {
    // Not a comparison against REGENERABLE_SESSION_SUBDIRS: the constant is a
    // declaration, and this has to pin the EFFECT. `reclaimRegenerableSessionDirs`
    // is what archive (`services/session.ts`), the startup janitor and the
    // disk-tier ladder all call.
    fs.mkdirSync(pluginStateDir(sessionDir, "reqs"), { recursive: true });
    fs.writeFileSync(path.join(pluginStateDir(sessionDir, "reqs"), "bumps"), "111");
    fs.mkdirSync(path.join(stateDir, "plugins", "tools"), { recursive: true });

    await reclaimRegenerableSessionDirs(workspaceDir);

    // The checkout and ShipIt's regenerable state are gone; the plugin's shared
    // state is not — only a session reset or delete may take that.
    expect(fs.existsSync(workspaceDir)).toBe(false);
    expect(fs.existsSync(stateDir)).toBe(false);
    expect(fs.readFileSync(path.join(pluginStateDir(sessionDir, "reqs"), "bumps"), "utf-8")).toBe("111");
  });

  it("puts the primitives OUTSIDE every reclaimable session subdir (req 18)", () => {
    const relative = path.relative(sessionDir, pluginStateDir(sessionDir, "reqs"));
    const top = relative.split(path.sep)[0];
    expect(REGENERABLE_SESSION_SUBDIRS).not.toContain(top);
    expect(relative.startsWith("..")).toBe(false);
  });

  it("keeps the settings file out of the plugin-writable state directory", () => {
    const settings = pluginSettingsPath(sessionDir, "reqs");
    const state = pluginStateDir(sessionDir, "reqs");
    expect(path.relative(state, settings).startsWith("..")).toBe(true);
  });

  it("resolves the session root only from a validated clone layout", () => {
    expect(sessionRootForWorkspace(workspaceDir)).toBe(sessionDir);
    expect(() => sessionRootForWorkspace(path.join(tmp, "flat"))).toThrow();
  });
});

describe("resolvePluginSettings", () => {
  const declared = makeExport({
    settings: {
      root: { description: "where output goes", default: "docs" },
      depth: { default: 3 },
      optional: {},
    },
  });

  it("applies the plugin's defaults when the project sets nothing (req 26)", () => {
    const { values, errors } = resolvePluginSettings(declared, makeUse());
    expect(errors).toEqual([]);
    expect({ ...values }).toEqual({ root: "docs", depth: 3 });
  });

  it("lets the project's value win over the default", () => {
    const use = makeUse({ overrides: { services: {}, commands: {}, settings: { root: "specs" } } });
    const { values, errors } = resolvePluginSettings(declared, use);
    expect(errors).toEqual([]);
    expect({ ...values }).toEqual({ root: "specs", depth: 3 });
  });

  it("omits a declared setting with neither a value nor a default", () => {
    const { values } = resolvePluginSettings(declared, makeUse());
    expect("optional" in values).toBe(false);
  });

  it("accepts any scalar for a setting that declares no default", () => {
    const use = makeUse({ overrides: { services: {}, commands: {}, settings: { optional: true } } });
    const { values, errors } = resolvePluginSettings(declared, use);
    expect(errors).toEqual([]);
    expect(values.optional).toBe(true);
  });

  it("rejects a value the plugin declares no setting for", () => {
    const use = makeUse({ overrides: { services: {}, commands: {}, settings: { rooot: "docs" } } });
    const { errors } = resolvePluginSettings(declared, use);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("`rooot`");
    expect(errors[0]).toContain("no effect");
  });

  it("rejects a value whose type disagrees with the declared default", () => {
    const use = makeUse({ overrides: { services: {}, commands: {}, settings: { depth: "3" } } });
    const { values, errors } = resolvePluginSettings(declared, use);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("`depth`");
    // and the bad value is not smuggled through under the default's name
    expect("depth" in values).toBe(false);
  });

  it("rejects a number JSON cannot carry, on either side", () => {
    // YAML has `.nan`, `.inf` and overflowing literals; JSON has none of them,
    // and `JSON.stringify` writes all three as `null` — so without this the
    // plugin would receive neither its declared value nor a number.
    const use = makeUse({ overrides: { services: {}, commands: {}, settings: { depth: Infinity } } });
    expect(resolvePluginSettings(declared, use).errors[0]).toContain("`depth`");

    const badDefault = makeExport({ settings: { depth: { default: NaN } } });
    const { values, errors } = resolvePluginSettings(badDefault, makeUse());
    expect(errors).toHaveLength(1);
    expect("depth" in values).toBe(false);
  });

  it("is not confused by a setting named after an Object prototype member", () => {
    const proto = makeExport({ settings: { constructor: { default: "x" } } });
    const use = makeUse({ overrides: { services: {}, commands: {}, settings: { toString: "y" } } });
    const { values, errors } = resolvePluginSettings(proto, use);
    // `toString` is not declared → an error, not an inherited-function hit.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("`toString`");
    expect(JSON.parse(JSON.stringify(values))).toEqual({ constructor: "x" });
  });

  it("names the import in every message, since one card carries several", () => {
    const use = makeUse({
      alias: "specs",
      overrides: { services: {}, commands: {}, settings: { nope: 1 } },
    });
    expect(resolvePluginSettings(declared, use).errors[0]).toContain("`specs`");
  });
});

describe("preparePluginState", () => {
  const exported = makeExport({ settings: { greeting: { default: "hello" } } });
  /** Every import in this block comes from one declared repo, `game-tools`. */
  const resolverFor = (e: PluginExport | null): PluginImportResolver => ({
    repoNameFor: () => "game-tools",
    exportFor: () => e,
  });
  const resolver = resolverFor(exported);

  it("creates one state directory per import, keyed by alias", () => {
    preparePluginState({
      sessionDir,
      uses: [makeUse(), makeUse({ alias: "specs" })],
      resolver,
    });
    expect(fs.existsSync(pluginStateDir(sessionDir, "reqs"))).toBe(true);
    expect(fs.existsSync(pluginStateDir(sessionDir, "specs"))).toBe(true);
  });

  it("materializes ONE validated settings file per import (req 26)", () => {
    const entries = preparePluginState({ sessionDir, uses: [makeUse()], resolver });
    expect(entries[0].settingsPath).toBe(pluginSettingsPath(sessionDir, "reqs"));
    expect(readSettings("reqs")).toEqual({ greeting: "hello" });
  });

  it("keeps the state directory's contents across a re-prepare (reqs 12, 18)", () => {
    preparePluginState({ sessionDir, uses: [makeUse()], resolver });
    const marker = path.join(pluginStateDir(sessionDir, "reqs"), "bumps");
    fs.writeFileSync(marker, "111");

    // A refresh brings a new manifest with a new default — the settings file
    // follows it, the state does not.
    preparePluginState({
      sessionDir,
      uses: [makeUse()],
      resolver: resolverFor(makeExport({ settings: { greeting: { default: "bonjour" } } })),
    });
    expect(fs.readFileSync(marker, "utf-8")).toBe("111");
    expect(readSettings("reqs")).toEqual({ greeting: "bonjour" });
  });

  it("keeps a dropped import's state but drops its settings file", () => {
    preparePluginState({ sessionDir, uses: [makeUse()], resolver });
    const marker = path.join(pluginStateDir(sessionDir, "reqs"), "bumps");
    fs.writeFileSync(marker, "1");

    preparePluginState({ sessionDir, uses: [], resolver });
    // Undeclaring an import is neither a session reset nor a delete (req 18).
    expect(fs.readFileSync(marker, "utf-8")).toBe("1");
    expect(fs.existsSync(pluginSettingsPath(sessionDir, "reqs"))).toBe(false);
  });

  it("writes no settings file when the settings cannot be resolved", () => {
    const use = makeUse({ overrides: { services: {}, commands: {}, settings: { nope: "x" } } });
    const entries = preparePluginState({ sessionDir, uses: [use], resolver });
    expect(entries[0].settingsPath).toBeNull();
    expect(entries[0].issues).toHaveLength(1);
    expect(fs.existsSync(pluginSettingsPath(sessionDir, "reqs"))).toBe(false);
    // The state directory still exists — it is not the settings' hostage.
    expect(fs.existsSync(pluginStateDir(sessionDir, "reqs"))).toBe(true);
  });

  it("removes a now-invalid settings file rather than leaving a stale one", () => {
    preparePluginState({ sessionDir, uses: [makeUse()], resolver });
    expect(fs.existsSync(pluginSettingsPath(sessionDir, "reqs"))).toBe(true);

    // The declaration changed to something the manifest cannot satisfy.
    const use = makeUse({ overrides: { services: {}, commands: {}, settings: { nope: "x" } } });
    preparePluginState({ sessionDir, uses: [use], resolver });
    expect(fs.existsSync(pluginSettingsPath(sessionDir, "reqs"))).toBe(false);
  });

  it("removes the stale file and reports a failure when the write itself fails", () => {
    preparePluginState({ sessionDir, uses: [makeUse()], resolver });
    expect(readSettings("reqs")).toEqual({ greeting: "hello" });

    // The project changed the value and the replacement cannot be written
    // (disk full, I/O error). Leaving the old file readable is how a plugin
    // keeps writing durable output to the directory the project moved away
    // from — so the old file goes, and the card hears about it.
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("ENOSPC: no space left on device");
    });
    const entries = preparePluginState({
      sessionDir,
      uses: [makeUse({ overrides: { services: {}, commands: {}, settings: { greeting: "bonjour" } } })],
      resolver,
    });
    rename.mockRestore();

    expect(entries[0].failure).toContain("could not be written");
    expect(entries[0].settingsPath).toBeNull();
    expect(fs.existsSync(pluginSettingsPath(sessionDir, "reqs"))).toBe(false);
    // …and no half-written temporary is left addressable either.
    const files = fs.readdirSync(path.dirname(pluginSettingsPath(sessionDir, "reqs")));
    expect(files.filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("reports the declaring repository, in the declaration's own spelling", () => {
    const entries = preparePluginState({
      sessionDir,
      uses: [makeUse({ from: "GAME-TOOLS" })],
      resolver,
    });
    expect(entries[0].repo).toBe("game-tools");
  });

  it("leaves an existing settings file alone when no manifest is available", () => {
    preparePluginState({ sessionDir, uses: [makeUse()], resolver });
    // Nothing is live yet (never fetched, or mid-restore): that is not evidence
    // the settings already written are wrong.
    preparePluginState({ sessionDir, uses: [makeUse()], resolver: resolverFor(null) });
    expect(readSettings("reqs")).toEqual({ greeting: "hello" });
    expect(fs.existsSync(pluginStateDir(sessionDir, "reqs"))).toBe(true);
  });

  it("is safe to run when nothing is declared", () => {
    expect(() => preparePluginState({ sessionDir, uses: [], resolver })).not.toThrow();
    expect(fs.existsSync(pluginDataRoot(sessionDir))).toBe(false);
  });

  it("writes the settings file read-only — ShipIt validated it, not the plugin", () => {
    preparePluginState({ sessionDir, uses: [makeUse()], resolver });
    const mode = fs.statSync(pluginSettingsPath(sessionDir, "reqs")).mode & 0o777;
    expect(mode & 0o222).toBe(0);
  });

  it("publishes the settings file by rename, never by writing it in place", () => {
    // The distinction is what a concurrently-reading plugin service sees: an
    // in-place rewrite exposes a truncated JSON document, which is a parse
    // error rather than an old value.
    preparePluginState({ sessionDir, uses: [makeUse()], resolver });
    const rename = vi.spyOn(fs, "renameSync");
    preparePluginState({
      sessionDir,
      uses: [makeUse()],
      resolver: resolverFor(makeExport({ settings: { greeting: { default: "bonjour" } } })),
    });
    const settings = pluginSettingsPath(sessionDir, "reqs");
    expect(rename.mock.calls).toContainEqual([expect.stringContaining(`${settings}.tmp-`), settings]);
    rename.mockRestore();
  });

  it("rewrites the settings file atomically, leaving no temporary behind", () => {
    preparePluginState({ sessionDir, uses: [makeUse()], resolver });
    preparePluginState({
      sessionDir,
      uses: [makeUse()],
      resolver: resolverFor(makeExport({ settings: { greeting: { default: "bonjour" } } })),
    });
    const files = fs.readdirSync(path.dirname(pluginSettingsPath(sessionDir, "reqs")));
    expect(files.filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("does not replace the settings file when nothing changed", () => {
    // Every round would otherwise hand it a new inode, which a Docker FILE bind
    // mount does not follow — a long-lived service would keep reading a file
    // nothing writes to any more.
    preparePluginState({ sessionDir, uses: [makeUse()], resolver });
    const before = fs.statSync(pluginSettingsPath(sessionDir, "reqs")).ino;

    preparePluginState({ sessionDir, uses: [makeUse()], resolver });
    expect(fs.statSync(pluginSettingsPath(sessionDir, "reqs")).ino).toBe(before);

    preparePluginState({
      sessionDir,
      uses: [makeUse()],
      resolver: resolverFor(makeExport({ settings: { greeting: { default: "bonjour" } } })),
    });
    expect(fs.statSync(pluginSettingsPath(sessionDir, "reqs")).ino).not.toBe(before);
  });
});

describe("createPluginImportResolver", () => {
  function config(): PluginReposConfig {
    return {
      declared: true,
      repos: [
        { name: "Game-Tools", source: { kind: "github", owner: "acme", repo: "tools" }, branch: "main" },
        { name: "here", source: { kind: "self" } },
      ],
      uses: [],
    };
  }

  /**
   * Publish a generation the way `plugin-generations.ts` does — manifest AND
   * record. The record is what carries the SOURCE, and every reader through the
   * `active` symlink checks it: the generation is filed under the declaration's
   * name, which is re-pointable, so a manifest read without it can answer with
   * the previous repository's exports.
   */
  function publishGeneration(repoName: string, yaml: string, source = "acme/tools"): void {
    const gen = path.join(stateDir, "plugins", repoName, "generations", "abc123");
    fs.mkdirSync(gen, { recursive: true });
    fs.writeFileSync(path.join(gen, "shipit.yaml"), yaml);
    fs.writeFileSync(
      path.join(gen, ".shipit-generation.json"),
      JSON.stringify({
        repoName,
        source,
        commit: "abc123",
        ref: "branch main",
        activatedAt: new Date().toISOString(),
        exports: ["requirements"],
        manifestWarnings: [],
      }),
    );
    fs.symlinkSync(path.join("generations", "abc123"), path.join(stateDir, "plugins", repoName, "active"));
  }

  it("reads a tracked import's manifest from the LIVE generation", () => {
    publishGeneration(
      "Game-Tools",
      "exports:\n  plugins:\n    requirements:\n      settings:\n        root:\n          default: docs\n",
    );
    const { exportFor } = createPluginImportResolver(config(), [], liveFor(config()));
    expect(exportFor(makeUse({ from: "game-tools" }))?.settings.root?.default).toBe("docs");
  });

  it("resolves the checkout through the DECLARATION's spelling, not the use entry's", () => {
    // The checkout directory carries `Game-Tools`; `from:` matches
    // case-insensitively, and a case-sensitive filesystem would otherwise find
    // nothing (the defect `plugin-runtime.ts` had to fix).
    publishGeneration("Game-Tools", "exports:\n  plugins:\n    requirements: {}\n");
    const { exportFor, repoNameFor } = createPluginImportResolver(config(), [], liveFor(config()));
    expect(exportFor(makeUse({ from: "GAME-TOOLS" }))?.name).toBe("requirements");
    expect(repoNameFor(makeUse({ from: "GAME-TOOLS" }))).toBe("Game-Tools");
  });

  // A declaration re-pointed at another repository keeps its name, and the
  // checkout is filed under that name — so without the source check this would
  // validate the consumer's settings against the PREVIOUS repository's manifest.
  it("ignores a live generation left by a repository the declaration no longer names", () => {
    publishGeneration(
      "Game-Tools",
      "exports:\n  plugins:\n    requirements:\n      settings:\n        root:\n          default: docs\n",
      "acme/previous-tools",
    );
    const { exportFor } = createPluginImportResolver(config(), [], liveFor(config()));
    expect(exportFor(makeUse({ from: "game-tools" }))).toBeNull();
  });

  it("reads a `repo: self` import from the project's own parsed manifest", () => {
    const { exportFor } = createPluginImportResolver(config(), [makeExport({ name: "probe" })], liveFor(config()));
    expect(exportFor(makeUse({ plugin: "probe", from: "here" }))?.name).toBe("probe");
  });

  it("returns null for an unknown repo or an export the manifest lacks", () => {
    const { exportFor, repoNameFor } = createPluginImportResolver(config(), [], liveFor(config()));
    expect(exportFor(makeUse({ from: "nope" }))).toBeNull();
    expect(repoNameFor(makeUse({ from: "nope" }))).toBeNull();
    expect(exportFor(makeUse({ from: "here" }))).toBeNull();
  });
});

describe("pluginSettingsIssuesByRepo", () => {
  it("groups issues under the declared repository the import came from", () => {
    const plugins: PluginReposConfig = {
      declared: true,
      repos: [{ name: "Here", source: { kind: "self" } }],
      uses: [
        makeUse({
          plugin: "probe",
          from: "here",
          alias: "p",
          overrides: { services: {}, commands: {}, settings: { nope: 1 } },
        }),
      ],
    };
    const issues = pluginSettingsIssuesByRepo(plugins, [makeExport({ name: "probe" })], liveFor(plugins));
    // Keyed by the declaration's own spelling — that is the card's identity.
    expect([...issues.keys()]).toEqual(["Here"]);
    expect(issues.get("Here")![0]).toContain("`nope`");
  });

  it("says nothing when there is no manifest to check against", () => {
    const plugins: PluginReposConfig = {
      declared: true,
      repos: [{ name: "tools", source: { kind: "github", owner: "a", repo: "b" }, branch: "main" }],
      uses: [makeUse({ from: "tools", overrides: { services: {}, commands: {}, settings: { x: 1 } } })],
    };
    expect(pluginSettingsIssuesByRepo(plugins, [], liveFor(plugins)).size).toBe(0);
  });
});
