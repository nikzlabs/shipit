/**
 * docs/262 req 20 — the card's copy for a command that cannot be surfaced.
 *
 * The property under test is that this is a pure re-derivation: it reads the
 * declaration and the live manifests off disk and activates nothing, so a
 * declaration that cannot work says so before any round has run.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { pluginCommandIssuesByRepo } from "./plugin-commands.js";
import { parsePluginExports, parsePluginRepos } from "../shared/plugin-repos.js";

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-commands-"));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

/**
 * Publish a live generation, record included. The record is not decoration
 * here: every reader through the `active` symlink checks the generation's
 * recorded `source` against the declaration, so a generation without one reads
 * as absent and this collector would correctly surface no commands at all.
 * `source` is the lowercased `owner/repo` (`destinationKey`), which is why it
 * is passed separately from the directory's own spelling.
 */
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
  return pluginCommandIssuesByRepo(
    parsePluginRepos(doc.plugins, [], warnings),
    parsePluginExports(doc.exports, warnings),
    stateDir,
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

  // `from:` matches case-insensitively while the checkout directory carries the
  // declaration's own spelling — the defect the skills path had to fix, and the
  // reason this goes through the resolver rather than through `use.from`.
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
    // No manifest means no surfaced commands, so nothing can collide — and a
    // pending fetch must not read as a declaration problem (req 13).
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
