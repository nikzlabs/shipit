// docs/262 — phase-1 parsing of the consumer `plugins:` block and the
// plugin-side `exports.plugins:` manifest, plus the snapshot projection.

import { describe, expect, it } from "vitest";
import type { DeclaredTracker } from "./declared-tracker.js";
import {
  buildPluginReposSnapshot,
  parsePluginExports,
  parsePluginRepos,
} from "./plugin-repos.js";
import { parseShipitConfig } from "./shipit-config.js";

const NO_TRACKERS: DeclaredTracker[] = [];

function repos(raw: unknown, trackers: DeclaredTracker[] = NO_TRACKERS) {
  const warnings: string[] = [];
  const config = parsePluginRepos(raw, trackers, warnings);
  return { config, warnings };
}

describe("parsePluginRepos — grammar", () => {
  it("absent block → not declared, no warnings", () => {
    const { config, warnings } = repos(undefined);
    expect(config.declared).toBe(false);
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
      credentials: ["PROBE_TOKEN"],
      hosts: ["example.com"],
    });
    expect(exportsList[0].settings.greeting).toEqual({ description: "Echo text", default: "hello" });
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
    expect(warnings).toContainEqual(expect.stringContaining("Ignoring exported plugin `bad`"));
    expect(warnings).toContainEqual(expect.stringContaining("Ignoring exported plugin `escaping`"));
    expect(warnings).toContainEqual(expect.stringContaining("Ignoring exported plugin `bad-cred`"));
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
      { plugin: "probe", alias: "probe", found: true },
      { plugin: "missing", alias: "gone", found: false },
    ]);
    expect(dev?.issues).toHaveLength(1);
    expect(tools).toMatchObject({ source: "nikzlabs/shipit", status: "declared", ref: "main", commit: null });
    expect(tools?.uses).toEqual([{ plugin: "probe", alias: "remote", found: null }]);
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
});
