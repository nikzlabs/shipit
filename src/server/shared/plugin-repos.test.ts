import { describe, expect, it } from "vitest";
import type { DeclaredTracker } from "./declared-tracker.js";
import {
  buildPluginReposSnapshot,
  parsePluginExports,
  parsePluginRepos,
  type PluginRepoRuntime,
} from "./plugin-repos.js";
import { PLUGIN_CONTRACT_ENV_NAMES } from "./plugin-contract.js";
import { parseShipitConfig } from "./shipit-config.js";

const NO_TRACKERS: DeclaredTracker[] = [];

function repos(raw: unknown, trackers: DeclaredTracker[] = NO_TRACKERS) {
  const warnings: string[] = [];
  const config = parsePluginRepos(raw, trackers, warnings);
  return { config, warnings };
}

describe("parsePluginRepos — grammar", () => {
  it("an empty `plugins:` key still declares intent", () => {
    const { config, warnings } = repos(undefined);
    expect(config.declared).toBe(true);
    expect(config.repos).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("a non-mapping block still counts as declared (intent gates the tab, req 13)", () => {
    const { config, warnings } = repos("nope");
    expect(config.declared).toBe(true);
    expect(config.repos).toEqual([]);
    expect(warnings).toContainEqual(expect.stringContaining("`plugins` must be a mapping"));
  });

  it("parses the full fixture shape", () => {
    const { config, warnings } = repos({
      repos: [
        { repo: "self", name: "shipit-dev" },
        { repo: "nikzlabs/shipit", name: "shipit-tools", branch: "main" },
      ],
      use: [
        { plugin: "probe", from: "shipit-dev", overrides: { services: { probe: { autostart: false } } } },
        { plugin: "probe", from: "shipit-tools", alias: "remote-probe" },
      ],
    });
    expect(warnings).toEqual([]);
    expect(config.repos).toEqual([
      { name: "shipit-dev", source: { kind: "self" } },
      { name: "shipit-tools", source: { kind: "github", owner: "nikzlabs", repo: "shipit" }, branch: "main" },
    ]);
    expect(config.uses).toHaveLength(2);
    expect(config.uses[0]).toMatchObject({ plugin: "probe", from: "shipit-dev", alias: "probe" });
    expect(config.uses[0].overrides.services.probe).toEqual({ autostart: false });
    expect(config.uses[1].alias).toBe("remote-probe");
  });

  it("keeps a service `port` the consuming project wrote (docs/266-plugin-service-ports req 2)", () => {
    const { config, warnings } = repos({
      repos: [{ repo: "self", name: "mine" }],
      use: [{ plugin: "probe", from: "mine", overrides: { services: { probe: { port: 4300 } } } }],
    });
    expect(warnings).toEqual([]);
    expect(config.uses[0].overrides.services.probe).toEqual({ port: 4300 });
  });

  it("drops an entry missing repo or name, keeps the rest", () => {
    const { config, warnings } = repos({
      repos: [{ name: "no-repo" }, { repo: "a/b" }, { repo: "c/d", name: "ok" }],
    });
    expect(config.repos.map((r) => r.name)).toEqual(["ok"]);
    expect(warnings).toHaveLength(2);
  });

  it("drops branch+pin together (req 8) and self with a version", () => {
    const { config, warnings } = repos({
      repos: [
        { repo: "a/b", name: "both", branch: "main", pin: "v1" },
        { repo: "self", name: "pinned-self", pin: "v1" },
      ],
    });
    expect(config.repos).toEqual([]);
    expect(warnings).toContainEqual(expect.stringContaining("mutually exclusive"));
    expect(warnings).toContainEqual(expect.stringContaining("`repo: self` takes no `branch`/`pin`"));
  });

  it("rejects a non-owner/name repo form (GitHub-only v1)", () => {
    const { config, warnings } = repos({ repos: [{ repo: "https://gitlab.com/x/y.git", name: "x" }] });
    expect(config.repos).toEqual([]);
    expect(warnings).toContainEqual(expect.stringContaining("`owner/name` slug or `self`"));
  });

  it.each([
    ["a non-boolean autostart", { services: { svc: { autostart: "false" } } }, "autostart"],
    ["a quoted port", { services: { svc: { port: "4300" } } }, "port"],
    ["a fractional port", { services: { svc: { port: 43.5 } } }, "port"],
    ["a port out of range", { services: { svc: { port: 70000 } } }, "port"],
    ["a zero port", { services: { svc: { port: 0 } } }, "port"],
    ["an invalid service alias", { services: { svc: { as: "bad name" } } }, "as"],
    ["an invalid command alias", { commands: { cmd: { as: "bad/name" } } }, "as"],
    ["a non-scalar setting value", { settings: { root: { nested: true } } }, "settings.root"],
    ["a non-mapping overrides block", "nope", "overrides"],
  ])("drops the whole use entry for %s", (_label, overrides, mentions) => {
    const { config, warnings } = repos({
      repos: [{ repo: "a/b", name: "tools" }],
      use: [{ plugin: "x", from: "tools", overrides }],
    });
    expect(config.uses).toEqual([]);
    expect(warnings).toContainEqual(expect.stringContaining(mentions));
  });

  it("warns on unknown keys at every level without dropping valid entries", () => {
    const { config, warnings } = repos({
      extra: 1,
      repos: [{ repo: "a/b", name: "ok", surprise: true }],
      use: [{ plugin: "p", from: "ok", what: 1, overrides: { nope: {} } }],
    });
    expect(config.repos).toHaveLength(1);
    expect(config.uses).toHaveLength(1);
    expect(warnings).toContainEqual(expect.stringContaining("`plugins.extra`"));
    expect(warnings).toContainEqual(expect.stringContaining("`plugins.repos[0].surprise`"));
    expect(warnings).toContainEqual(expect.stringContaining("`plugins.use[0].what`"));
    expect(warnings).toContainEqual(expect.stringContaining("overrides.nope"));
  });

  it.each(["settings", "services", "commands"])(
    "an override key written one level too high names where it belongs (%s)",
    (key) => {
      const { config, warnings } = repos({
        repos: [{ repo: "a/b", name: "tools" }],
        use: [{ plugin: "p", from: "tools", [key]: {} }],
      });
      expect(config.uses).toHaveLength(1);
      expect(warnings).toContainEqual(
        expect.stringContaining(`\`plugins.use[0].overrides.${key}\``),
      );
    },
  );

  it("an unknown key that is NOT an override key gets no misleading hint", () => {
    const { warnings } = repos({
      repos: [{ repo: "a/b", name: "tools" }],
      use: [{ plugin: "p", from: "tools", with: {} }],
    });
    expect(warnings).toContainEqual("Unknown key `plugins.use[0].with` in shipit.yaml.");
  });
});

describe("parsePluginRepos — reservation domains (plan §1a phase 1)", () => {
  const planningTracker: DeclaredTracker = {
    kind: "github",
    name: "planning",
    owner: "nikzlabs",
    repo: "shipit-planning",
  };

  it("a repo name colliding with a tracker name is dropped (first declared wins)", () => {
    const { config, warnings } = repos(
      { repos: [{ repo: "a/b", name: "planning" }] },
      [planningTracker],
    );
    expect(config.repos).toEqual([]);
    expect(warnings).toContainEqual(expect.stringContaining("already a declared tracker name"));
  });

  it("…unless the repo IS the tracker's repository — the sanctioned alias case", () => {
    const { config, warnings } = repos(
      { repos: [{ repo: "nikzlabs/shipit-planning", name: "planning" }] },
      [planningTracker],
    );
    expect(config.repos).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it("duplicate repo names and duplicate destinations are dropped, case-insensitively", () => {
    const { config, warnings } = repos({
      repos: [
        { repo: "a/b", name: "tools" },
        { repo: "c/d", name: "Tools" },
        { repo: "A/B", name: "other" },
      ],
    });
    expect(config.repos.map((r) => r.name)).toEqual(["tools"]);
    expect(warnings).toContainEqual(expect.stringContaining("duplicate repo name"));
    expect(warnings).toContainEqual(expect.stringContaining("already declared as `tools`"));
  });

  it("only one self declaration survives", () => {
    const { config, warnings } = repos({
      repos: [
        { repo: "self", name: "dev" },
        { repo: "self", name: "dev2" },
      ],
    });
    expect(config.repos.map((r) => r.name)).toEqual(["dev"]);
    expect(warnings).toContainEqual(expect.stringContaining("`self` is already declared"));
  });

  it("plugin aliases are unique across all use entries (domain 2)", () => {
    const { config, warnings } = repos({
      repos: [{ repo: "a/b", name: "tools" }],
      use: [
        { plugin: "x", from: "tools" },
        { plugin: "y", from: "tools", alias: "X" },
      ],
    });
    expect(config.uses).toHaveLength(1);
    expect(warnings).toContainEqual(expect.stringContaining("duplicate plugin alias"));
  });

  it("a use whose from names no declared repo is dropped", () => {
    const { config, warnings } = repos({
      repos: [{ repo: "a/b", name: "tools" }],
      use: [{ plugin: "x", from: "nope" }],
    });
    expect(config.uses).toEqual([]);
    expect(warnings).toContainEqual(expect.stringContaining("names no declared repo"));
  });
});

describe("parsePluginExports", () => {
  it("parses the fixture manifest", () => {
    const warnings: string[] = [];
    const exportsList = parsePluginExports(
      {
        plugins: {
          probe: {
            compose: "test-plugin/docker-compose.yml",
            cli: { probe: "test-plugin/cli/probe.mjs" },
            skills: "test-plugin/skills",
            install: "node test-plugin/install.mjs",
            "install-inputs": ["test-plugin/install.mjs"],
            credentials: ["PROBE_TOKEN"],
            hosts: ["example.com"],
            settings: { greeting: { description: "Echo text", default: "hello" } },
          },
        },
      },
      warnings,
    );
    expect(warnings).toEqual([]);
    expect(exportsList).toHaveLength(1);
    expect(exportsList[0]).toMatchObject({
      name: "probe",
      compose: "test-plugin/docker-compose.yml",
      cli: { probe: "test-plugin/cli/probe.mjs" },
      installInputs: ["test-plugin/install.mjs"],
      credentials: [{ name: "PROBE_TOKEN", optional: false }],
      hosts: [{ name: "example.com", optional: false }],
    });
    expect(exportsList[0].settings.greeting).toEqual({ description: "Echo text", default: "hello" });
  });

  it("defaults dep-dirs to the npm case and takes an explicit list (req 28)", () => {
    const warnings: string[] = [];
    const [byDefault, declared, optedOut] = parsePluginExports(
      {
        plugins: {
          a: { install: "npm ci" },
          b: { install: "npm ci", "dep-dirs": ["node_modules", "./tools/node_modules/", "node_modules"] },
          c: { install: "npm ci", "dep-dirs": [] },
        },
      },
      warnings,
    );
    expect(warnings).toEqual([]);
    expect(byDefault!.depDirs).toEqual(["node_modules"]);
    expect(declared!.depDirs).toEqual(["node_modules", "tools/node_modules"]);
    expect(optedOut!.depDirs).toEqual([]);
  });

  it("drops a plugin whose dep-dirs escape the repository", () => {
    const warnings: string[] = [];
    expect(parsePluginExports({ plugins: { bad: { "dep-dirs": ["../outside"] } } }, warnings)).toEqual([]);
    expect(parsePluginExports({ plugins: { bad: { "dep-dirs": "node_modules" } } }, [])).toEqual([]);
  });

  it("fail-closed per plugin: one bad field drops the whole export, siblings survive", () => {
    const warnings: string[] = [];
    const exportsList = parsePluginExports(
      {
        plugins: {
          bad: { compose: "/absolute/path.yml" },
          escaping: { skills: "../outside" },
          "bad-cred": { credentials: ["lower_case"] },
          good: { cli: { run: "bin/run.mjs" } },
        },
      },
      warnings,
    );
    expect(exportsList.map((e) => e.name)).toEqual(["good"]);
    expect(warnings).toContainEqual(expect.stringContaining("`exports.plugins.bad`"));
    expect(warnings).toContainEqual(expect.stringContaining("`exports.plugins.escaping`"));
    expect(warnings).toContainEqual(expect.stringContaining("`exports.plugins.bad-cred`"));
  });

  it("warns on a misspelled setting descriptor key instead of silently losing it", () => {
    const warnings: string[] = [];
    const exportsList = parsePluginExports(
      { plugins: { p: { settings: { greeting: { defualt: "hi" } } } } },
      warnings,
    );
    expect(exportsList).toHaveLength(1);
    expect(warnings).toContainEqual(expect.stringContaining("settings.greeting.defualt"));
  });

  it("hosts must be bare hostnames", () => {
    const warnings: string[] = [];
    const exportsList = parsePluginExports(
      { plugins: { p: { hosts: ["https://fal.run"] } } },
      warnings,
    );
    expect(exportsList).toEqual([]);
    expect(warnings).toContainEqual(expect.stringContaining("bare hostnames"));
  });

  it("refuses a credential named after a ShipIt contract variable", () => {
    for (const name of PLUGIN_CONTRACT_ENV_NAMES) {
      const warnings: string[] = [];
      expect(parsePluginExports({ plugins: { p: { credentials: [name] } } }, warnings)).toEqual([]);
      expect(warnings).toContainEqual(expect.stringContaining(name));
      expect(warnings).toContainEqual(expect.stringContaining("`exports.plugins.p`"));
    }
  });

  describe("optional credentials and hosts", () => {
    it("reads a bare string as required and a mapping as what it says", () => {
      const warnings: string[] = [];
      const [exported] = parsePluginExports(
        {
          plugins: {
            assetgen: {
              credentials: ["FAL_KEY", { name: "PIXELLAB_KEY", optional: true }],
              hosts: ["fal.run", { name: "pixellab.ai", optional: true }],
            },
          },
        },
        warnings,
      );
      expect(warnings).toEqual([]);
      expect(exported?.credentials).toEqual([
        { name: "FAL_KEY", optional: false },
        { name: "PIXELLAB_KEY", optional: true },
      ]);
      expect(exported?.hosts).toEqual([
        { name: "fal.run", optional: false },
        { name: "pixellab.ai", optional: true },
      ]);
    });

    it("takes an explicit `optional: false` as required", () => {
      const [exported] = parsePluginExports(
        { plugins: { p: { hosts: [{ name: "fal.run", optional: false }] } } },
        [],
      );
      expect(exported?.hosts).toEqual([{ name: "fal.run", optional: false }]);
    });

    it("validates a mapping's name exactly as a bare one, and says why it dropped", () => {
      const cases: [unknown, string][] = [
        [{ hosts: [{ name: "https://fal.run" }] }, "bare hostnames"],
        [{ credentials: [{ name: "lower_case" }] }, "look like environment variables"],
        ...[...PLUGIN_CONTRACT_ENV_NAMES].map(
          (name): [unknown, string] => [{ credentials: [{ name, optional: true }] }, name],
        ),
      ];
      for (const [entry, mentions] of cases) {
        const warnings: string[] = [];
        expect(parsePluginExports({ plugins: { p: entry } }, warnings)).toEqual([]);
        expect(warnings).toContainEqual(expect.stringContaining("`exports.plugins.p`"));
        expect(warnings).toContainEqual(expect.stringContaining(mentions));
      }
    });

    it("drops the plugin when `optional` is not a boolean", () => {
      const warnings: string[] = [];
      expect(
        parsePluginExports(
          { plugins: { p: { credentials: [{ name: "FAL_KEY", optional: "true" }] } } },
          warnings,
        ),
      ).toEqual([]);
      expect(warnings).toContainEqual(expect.stringContaining("`optional: true`"));
    });

    it("drops the plugin when a mapping entry has no name", () => {
      const warnings: string[] = [];
      expect(parsePluginExports({ plugins: { p: { hosts: [{ optional: true }] } } }, warnings)).toEqual([]);
      expect(warnings).toContainEqual(expect.stringContaining("needs a `name:`"));
    });

    it("warns on an unknown key inside an entry, keeping the plugin", () => {
      const warnings: string[] = [];
      const [exported] = parsePluginExports(
        { plugins: { p: { credentials: [{ name: "FAL_KEY", optionl: true }] } } },
        warnings,
      );
      expect(exported?.credentials).toEqual([{ name: "FAL_KEY", optional: false }]);
      expect(warnings).toContainEqual(expect.stringContaining("credentials[].optionl"));
    });
  });

  it("leaves an ordinary SHIPIT_-ish name alone — only the contract names are taken", () => {
    const warnings: string[] = [];
    const exportsList = parsePluginExports(
      { plugins: { p: { credentials: ["SHIPIT_TOOL_TOKEN", "FAL_KEY"] } } },
      warnings,
    );
    expect(exportsList[0]?.credentials).toEqual([
      { name: "SHIPIT_TOOL_TOKEN", optional: false },
      { name: "FAL_KEY", optional: false },
    ]);
    expect(warnings).toEqual([]);
  });
});

describe("parseShipitConfig integration (docs/262)", () => {
  it("parses this repo's own fixture shape end to end with zero warnings", () => {
    const config = parseShipitConfig({
      agent: { install: "npm install" },
      issues: { trackers: [{ kind: "github", repo: "nikzlabs/shipit-planning", name: "planning" }] },
      exports: {
        plugins: {
          probe: { cli: { probe: "test-plugin/cli/probe.mjs" }, skills: "test-plugin/skills" },
        },
      },
      plugins: {
        repos: [{ repo: "self", name: "shipit-dev" }],
        use: [{ plugin: "probe", from: "shipit-dev", overrides: { services: { probe: { autostart: false } } } }],
      },
    });
    expect(config.warnings).toEqual([]);
    expect(config.plugins.declared).toBe(true);
    expect(config.plugins.repos).toHaveLength(1);
    expect(config.pluginExports).toHaveLength(1);
  });

  it("absent blocks keep the always-present defaults", () => {
    const config = parseShipitConfig({ agent: {} });
    expect(config.plugins).toEqual({ declared: false, repos: [], uses: [] });
    expect(config.pluginExports).toEqual([]);
  });

  it("a bare `plugins:` key (YAML null) declares intent — the tab must appear", () => {
    const config = parseShipitConfig({ agent: {}, plugins: null });
    expect(config.plugins.declared).toBe(true);
  });
});

describe("buildPluginReposSnapshot", () => {
  it("resolves self selectors against the same file's manifest; remote stays unknown", () => {
    const warnings: string[] = [];
    const plugins = parsePluginRepos(
      {
        repos: [
          { repo: "self", name: "dev" },
          { repo: "nikzlabs/shipit", name: "tools", branch: "main" },
        ],
        use: [
          { plugin: "probe", from: "dev" },
          { plugin: "missing", from: "dev", alias: "gone" },
          { plugin: "probe", from: "tools", alias: "remote" },
        ],
      },
      NO_TRACKERS,
      warnings,
    );
    const exportsList = parsePluginExports({ plugins: { probe: {} } }, warnings);
    const snapshot = buildPluginReposSnapshot(plugins, exportsList, "https://github.com/x/y", warnings);

    expect(snapshot.declared).toBe(true);
    expect(snapshot.consumerRepoUrl).toBe("https://github.com/x/y");
    const dev = snapshot.repos.find((r) => r.name === "dev");
    const tools = snapshot.repos.find((r) => r.name === "tools");
    expect(dev).toMatchObject({ source: "self", status: "self", ref: null });
    expect(dev?.uses).toEqual([
      { plugin: "probe", alias: "probe", found: true, credentials: [], hosts: [] },
      { plugin: "missing", alias: "gone", found: false, credentials: [], hosts: [] },
    ]);
    expect(dev?.issues).toHaveLength(1);
    expect(tools).toMatchObject({ source: "nikzlabs/shipit", status: "unavailable", ref: "branch main", commit: null });
    expect(tools?.uses).toEqual([{ plugin: "probe", alias: "remote", found: null, credentials: [], hosts: [] }]);
  });

  it("marks a pinned repository pinned, and a branch-tracking or self one not", () => {
    const warnings: string[] = [];
    const plugins = parsePluginRepos(
      {
        repos: [
          { repo: "self", name: "dev" },
          { repo: "a/b", name: "tracked", branch: "main" },
          { repo: "a/c", name: "tagged", pin: "v1.2.0" },
          { repo: "a/d", name: "sha-pinned", pin: "0123456789abcdef0123456789abcdef01234567" },
          { repo: "a/e", name: "defaulted" },
        ],
        use: [],
      },
      NO_TRACKERS,
      warnings,
    );
    const snapshot = buildPluginReposSnapshot(plugins, [], null, warnings);
    const pinnedByName = Object.fromEntries(snapshot.repos.map((r) => [r.name, r.pinned]));
    expect(pinnedByName).toEqual({
      dev: false,
      tracked: false,
      tagged: true,
      "sha-pinned": true,
      defaulted: false,
    });
  });

  it("reads pinned off the declaration even when a live generation records a branch ref", () => {
    const warnings: string[] = [];
    const plugins = parsePluginRepos(
      { repos: [{ repo: "a/b", name: "tools", pin: "v2.0.0" }], use: [] },
      NO_TRACKERS,
      warnings,
    );
    const card = buildPluginReposSnapshot(plugins, [], null, warnings, {
      tools: { commit: "abc123def", ref: "branch main", exports: [] },
    }).repos[0];
    expect(card).toMatchObject({ status: "active", ref: "branch main", pinned: true });
  });

  it("keeps only plugin/export-shaped warnings", () => {
    const snapshot = buildPluginReposSnapshot(
      { declared: true, repos: [], uses: [] },
      [],
      null,
      ["Unknown key `plugins.foo` in shipit.yaml.", "`agent.memory` is no longer used"],
    );
    expect(snapshot.warnings).toEqual(["Unknown key `plugins.foo` in shipit.yaml."]);
  });

  it("carries the reason an export was dropped, so a self consumer sees the cause", () => {
    const warnings: string[] = [];
    const plugins = parsePluginRepos(
      { repos: [{ repo: "self", name: "dev" }], use: [{ plugin: "probe", from: "dev" }] },
      NO_TRACKERS,
      warnings,
    );
    const exportsList = parsePluginExports({ plugins: { probe: { compose: "/abs.yml" } } }, warnings);
    const snapshot = buildPluginReposSnapshot(plugins, exportsList, null, warnings);
    expect(snapshot.repos[0].issues).toHaveLength(1);
    expect(snapshot.warnings).toContainEqual(expect.stringContaining("`exports.plugins.probe`"));
  });

  it("an exports-only repo grows no tab from a manifest warning", () => {
    const snapshot = buildPluginReposSnapshot(
      { declared: false, repos: [], uses: [] },
      [],
      null,
      ["Ignoring `exports.plugins.broken`: `compose` must be a relative path."],
    );
    expect(snapshot.declared).toBe(false);
    expect(snapshot.warnings).toEqual([]);
  });

  describe("runtime status projection", () => {
    const declaration = { repos: [{ repo: "a/b", name: "tools", branch: "main" }], use: [{ plugin: "p", from: "tools" }] };
    const build = (runtime: Record<string, PluginRepoRuntime>) => {
      const warnings: string[] = [];
      const plugins = parsePluginRepos(declaration, NO_TRACKERS, warnings);
      return buildPluginReposSnapshot(plugins, [], null, warnings, runtime).repos[0];
    };

    it("a live generation is active, with its exact commit", () => {
      const card = build({ tools: { commit: "abc123", exports: ["p"] } });
      expect(card).toMatchObject({ status: "active", commit: "abc123" });
      expect(card.uses[0].found).toBe(true);
      expect(card.issues).toEqual([]);
    });

    it("does not render the same sentence twice when both warning channels carry it", () => {
      const notInstalled =
        "`p` declares an install command, which this runtime cannot run — "
        + "the plugin is active but was not installed.";
      const card = build({
        tools: { commit: "abc123", exports: ["p"], manifestWarnings: [notInstalled], warning: notInstalled },
      });
      expect(card.issues.filter((i) => i === notInstalled)).toHaveLength(1);
    });

    it("keeps both when the two channels carry DIFFERENT facts", () => {
      const card = build({
        tools: {
          commit: "abc123",
          exports: ["p"],
          manifestWarnings: ["`p` declares an install command, which this runtime cannot run."],
          warning: "the tag moved",
        },
      });
      expect(card.issues).toHaveLength(2);
    });

    it("a selector missing from the live manifest becomes an issue", () => {
      const card = build({ tools: { commit: "abc123", exports: ["other"] } });
      expect(card.uses[0].found).toBe(false);
      expect(card.issues).toHaveLength(1);
    });

    it("an error over a live generation is degraded, not unavailable", () => {
      const card = build({ tools: { commit: "abc123", exports: ["p"], error: "authorization failed" } });
      expect(card).toMatchObject({ status: "degraded", commit: "abc123" });
      expect(card.issues[0]).toContain("authorization failed");
    });

    it("an error with nothing live is unavailable", () => {
      expect(build({ tools: { error: "authorization failed" } })).toMatchObject({
        status: "unavailable",
        commit: null,
      });
    });

    it("in-flight activation reads as activating", () => {
      expect(build({ tools: { activating: true } }).status).toBe("activating");
    });

    it("selectors stay unknown until there is a manifest to check", () => {
      expect(build({}).uses[0].found).toBeNull();
    });

    it("states a failed selector once, not twice", () => {
      const card = build({
        tools: {
          commit: "abc123",
          exports: ["other"],
          error: "`p` is not exported by this repository at the declared version.",
          missingSelectors: ["p"],
        },
      });
      expect(card.status).toBe("degraded");
      expect(card.uses[0].found).toBe(false);
      expect(card.issues).toEqual(["`p` is not exported by this repository at the declared version."]);
    });

    it("still reports a live-manifest gap when the attempt failed for another reason", () => {
      const card = build({ tools: { commit: "abc123", exports: ["other"], error: "authorization failed" } });
      expect(card.issues).toEqual([
        "authorization failed",
        "`p` is not in this repository's `exports.plugins` manifest.",
      ]);
    });

    it("pairs the commit with the ref that produced it, never the declared one", () => {
      const card = build({ tools: { commit: "abc123", exports: ["p"], ref: "pin v1.0.0" } });
      expect(card).toMatchObject({ status: "active", ref: "pin v1.0.0", commit: "abc123" });
    });

    it("names the declared ref when nothing is running — there is nothing else to name", () => {
      expect(build({}).ref).toBe("branch main");
      expect(build({ tools: { activating: true } }).ref).toBe("branch main");
    });

    it("shows the running ref even when the declaration has moved past it", () => {
      const card = build({ tools: { commit: "abc123", exports: ["p"], ref: "branch next" } });
      expect(card).toMatchObject({ status: "active", ref: "branch next", commit: "abc123" });
      expect(card.issues).toEqual([]);
    });

    it("a live generation with no recorded ref reports the commit alone", () => {
      const card = build({ tools: { commit: "abc123", exports: ["p"] } });
      expect(card).toMatchObject({ status: "active", ref: null, commit: "abc123" });
    });
  });

  describe("host needs projection", () => {
    const declaration = {
      repos: [{ repo: "a/b", name: "tools", branch: "main" }],
      use: [
        { plugin: "palette", from: "tools", alias: "artk" },
        { plugin: "probe", from: "tools" },
      ],
    };
    const build = (groups: Parameters<typeof buildPluginReposSnapshot>[6]) => {
      const warnings: string[] = [];
      const plugins = parsePluginRepos(declaration, NO_TRACKERS, warnings);
      return buildPluginReposSnapshot(
        plugins,
        [],
        null,
        warnings,
        { tools: { commit: "abc123", exports: ["palette", "probe"], ref: "branch main" } },
        [],
        groups,
      ).repos[0];
    };

    it("attaches each group to its own use entry, by alias", () => {
      const card = build([
        { repo: "tools", plugin: "palette", alias: "artk", hosts: [{ host: "fal.run", reach: "grantable", optional: false }] },
      ]);
      expect(card.uses[0]).toMatchObject({
        alias: "artk",
        hosts: [{ host: "fal.run", reach: "grantable", optional: false }],
      });
      expect(card.uses[1]).toMatchObject({ alias: "probe", hosts: [] });
    });

    it("an unallowed host is a need, never an issue row", () => {
      const card = build([
        { repo: "tools", plugin: "palette", alias: "artk", hosts: [{ host: "fal.run", reach: "grantable", optional: false }] },
      ]);
      expect(card.status).toBe("active");
      expect(card.issues).toEqual([]);
    });

    it("reports nothing when nothing has been resolved yet", () => {
      expect(build([]).uses.every((u) => u.hosts.length === 0)).toBe(true);
    });
  });

  describe("credential needs projection", () => {
    const declaration = {
      repos: [{ repo: "a/b", name: "tools", branch: "main" }],
      use: [
        { plugin: "palette", from: "tools", alias: "artk" },
        { plugin: "probe", from: "tools" },
      ],
    };
    const build = (groups: Parameters<typeof buildPluginReposSnapshot>[5]) => {
      const warnings: string[] = [];
      const plugins = parsePluginRepos(declaration, NO_TRACKERS, warnings);
      return buildPluginReposSnapshot(
        plugins,
        [],
        null,
        warnings,
        { tools: { commit: "abc123", exports: ["palette", "probe"] } },
        groups,
      ).repos[0];
    };

    it("attaches each group to its own use entry, by alias", () => {
      const card = build([
        {
          repo: "tools",
          plugin: "palette",
          alias: "artk",
          credentials: [{ name: "FAL_KEY", satisfied: false, optional: false }],
        },
      ]);
      expect(card.uses[0]).toMatchObject({
        alias: "artk",
        credentials: [{ name: "FAL_KEY", satisfied: false, optional: false }],
      });
      expect(card.uses[1]).toMatchObject({ alias: "probe", credentials: [] });
    });

    it("reports no needs when nothing has been resolved yet", () => {
      expect(build([]).uses.every((u) => u.credentials.length === 0)).toBe(true);
    });
  });

  it("reports pending: false — the route owns the pending answer", () => {
    const snapshot = buildPluginReposSnapshot({ declared: true, repos: [], uses: [] }, [], null, []);
    expect(snapshot.pending).toBe(false);
  });
});
