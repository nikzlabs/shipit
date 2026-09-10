import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveLiveGenerations } from "./plugin-generations.js";
import { pluginCommandIssuesByRepo } from "./plugin-commands.js";
import { parsePluginExports, parsePluginRepos } from "../shared/plugin-repos.js";

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-commands-"));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function publish(repoName: string, manifest: string, source = "acme/tools"): void {
  const dir = path.join(stateDir, "plugins", repoName, "generations", "abc");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "shipit.yaml"), manifest);
  fs.writeFileSync(
    path.join(dir, ".shipit-generation.json"),
    JSON.stringify({
      repoName, source, commit: "abc", ref: "branch main",
      activatedAt: new Date(0).toISOString(), exports: [], manifestWarnings: [],
    }),
  );
  fs.symlinkSync(dir, path.join(stateDir, "plugins", repoName, "active"));
}

function issues(yaml: string) {
  const doc = parseYaml(yaml) as Record<string, unknown>;
  const warnings: string[] = [];
  const plugins = parsePluginRepos(doc.plugins, [], warnings);
  return pluginCommandIssuesByRepo(
    plugins,
    parsePluginExports(doc.exports, warnings),
    resolveLiveGenerations(stateDir, plugins.repos),
  );
}

describe("pluginCommandIssuesByRepo", () => {
  it("says nothing when every surfaced command is unambiguous", () => {
    publish("Tools", "exports:\n  plugins:\n    requirements:\n      cli:\n        reqs: cli\n");
    const result = issues(`
plugins:
  repos:
    - repo: acme/tools
      name: Tools
  use:
    - plugin: requirements
      from: tools
`);
    expect(result.size).toBe(0);
  });

  it("reads a tracked repo's live manifest under the DECLARATION's spelling", () => {
    publish("Tools", "exports:\n  plugins:\n    a:\n      cli:\n        git: cli\n");
    const result = issues(`
plugins:
  repos:
    - repo: acme/tools
      name: Tools
  use:
    - plugin: a
      from: tools
`);
    expect(result.get("Tools")![0]).toContain("a name ShipIt reserves");
  });

  it("reports a cross-repository collision on BOTH repositories' cards", () => {
    publish("tools", "exports:\n  plugins:\n    a:\n      cli:\n        reqs: cli\n");
    const result = issues(`
plugins:
  repos:
    - repo: acme/tools
      name: tools
    - repo: self
      name: here
  use:
    - plugin: a
      from: tools
      alias: a
    - plugin: b
      from: here
      alias: b
exports:
  plugins:
    b:
      cli:
        reqs: other
`);
    expect([...result.keys()].sort()).toEqual(["here", "tools"]);
  });

  it("stays silent for a repository that has not been fetched yet", () => {
    const result = issues(`
plugins:
  repos:
    - repo: acme/tools
      name: tools
  use:
    - plugin: a
      from: tools
`);
    expect(result.size).toBe(0);
  });
});
