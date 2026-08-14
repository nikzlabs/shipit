/**
 * docs/262 reqs 17, 20 — the wrapper directory, as the agent sees it.
 *
 * The properties that matter are: a wrapper runs ShipIt's shim and nothing
 * plugin-authored, a refused name never gets one, a name the declaration drops
 * stops being on PATH in the same round, and nothing this module did not write
 * is ever touched.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { preparePluginCommands, WRAPPER_MARKER } from "./plugin-cli.js";
import { parsePluginExports, parsePluginRepos } from "../shared/plugin-repos.js";
import { parse as parseYaml } from "yaml";

let root: string;
let workspaceDir: string;
let binDir: string;
let storeDir: string;
let shimPath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-cli-"));
  workspaceDir = path.join(root, "workspace");
  binDir = path.join(root, "plugin-bin");
  storeDir = path.join(root, "plugin-store");
  shimPath = path.join(root, "shipit");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(shimPath, "#!/bin/sh\n", { mode: 0o755 });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Publish a plugin repository's manifest into the store, as a live generation. */
function publishRepo(name: string, manifest: string): void {
  const active = path.join(storeDir, name, "generations", "abc");
  fs.mkdirSync(active, { recursive: true });
  fs.writeFileSync(path.join(active, "shipit.yaml"), manifest);
  fs.symlinkSync(active, path.join(storeDir, name, "active"));
}

/** Parse a consumer declaration the way `resolveShipitConfig` would. */
function declare(yaml: string) {
  const doc = parseYaml(yaml) as Record<string, unknown>;
  const warnings: string[] = [];
  return {
    plugins: parsePluginRepos(doc.plugins, [], warnings),
    selfExports: parsePluginExports(doc.exports, warnings),
  };
}

function run(yaml: string, overrides: Partial<Parameters<typeof preparePluginCommands>[0]> = {}) {
  const { plugins, selfExports } = declare(yaml);
  return preparePluginCommands({
    workspaceDir, plugins, selfExports, binDir, storeDir, shimPath,
    // A PATH with nothing on it, so only what a test declares can collide.
    pathEnv: "",
    ...overrides,
  });
}

const TRACKED = `
plugins:
  repos:
    - repo: acme/tools
      name: tools
  use:
    - plugin: requirements
      from: tools
      alias: reqs
`;

describe("preparePluginCommands", () => {
  it("writes an executable wrapper that execs the shim, not the plugin", () => {
    publishRepo("tools", "exports:\n  plugins:\n    requirements:\n      cli:\n        reqs: cli/index.mjs\n");

    const result = run(TRACKED);
    expect(result.commands).toEqual(["reqs"]);
    expect(result.failed).toEqual([]);

    const wrapper = fs.readFileSync(path.join(binDir, "reqs"), "utf-8");
    expect(wrapper).toContain(WRAPPER_MARKER);
    // The whole boundary in one assertion: the agent container runs the shim,
    // and the plugin's own entrypoint is never named here.
    expect(wrapper).toContain(`exec ${shimPath} plugin exec --alias 'reqs' --command 'reqs' -- "$@"`);
    expect(wrapper).not.toContain("cli/index.mjs");
    expect(fs.statSync(path.join(binDir, "reqs")).mode & 0o777).toBe(0o755);
  });

  it("reads a `repo: self` import's commands from the project's own manifest", () => {
    const yaml = `
plugins:
  repos:
    - repo: self
      name: here
  use:
    - plugin: probe
      from: here
exports:
  plugins:
    probe:
      cli:
        probe-cli: tools/probe
`;
    expect(run(yaml).commands).toEqual(["probe-cli"]);
  });

  it("surfaces nothing for a repository with no live generation", () => {
    const result = run(TRACKED);
    expect(result.commands).toEqual([]);
    expect(result.refused).toEqual([]);
  });

  it("removes a wrapper the declaration no longer surfaces", () => {
    publishRepo("tools", "exports:\n  plugins:\n    requirements:\n      cli:\n        reqs: cli\n");
    run(TRACKED);
    expect(fs.existsSync(path.join(binDir, "reqs"))).toBe(true);

    const result = run("plugins:\n  repos: []\n  use: []\n");
    expect(result.removed).toEqual(["reqs"]);
    expect(fs.existsSync(path.join(binDir, "reqs"))).toBe(false);
  });

  // A contested name must not be served by a wrapper from an earlier round —
  // "reports the collision before running the ambiguous one" (req 20) is not
  // satisfied by a stale file on disk.
  it("removes a wrapper whose name has since become a collision", () => {
    publishRepo("tools", "exports:\n  plugins:\n    requirements:\n      cli:\n        reqs: cli\n");
    publishRepo("other", "exports:\n  plugins:\n    rival:\n      cli:\n        reqs: cli\n");
    run(TRACKED);

    const contested = `
plugins:
  repos:
    - repo: acme/tools
      name: tools
    - repo: acme/other
      name: other
  use:
    - plugin: requirements
      from: tools
      alias: reqs
    - plugin: rival
      from: other
      alias: rival
`;
    const result = run(contested);
    expect(result.commands).toEqual([]);
    expect(result.removed).toEqual(["reqs"]);
    expect(result.refused.map((r) => r.reason).join("\n")).toContain("claimed by more than one plugin");
  });

  it("refuses a name that already resolves elsewhere on PATH", () => {
    const other = path.join(root, "bin");
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, "reqs"), "#!/bin/sh\n", { mode: 0o755 });
    publishRepo("tools", "exports:\n  plugins:\n    requirements:\n      cli:\n        reqs: cli\n");

    const result = run(TRACKED, { pathEnv: other });
    expect(result.commands).toEqual([]);
    // Attributed to the declared repository — this list is the ONLY route the
    // PATH-shadow refusal has to the plugin card (`readPrepareFailures`).
    expect(result.refused).toEqual([
      { repo: "tools", reason: expect.stringContaining("would shadow") as unknown as string },
    ]);
    expect(fs.existsSync(path.join(binDir, "reqs"))).toBe(false);
  });

  // Without this the SECOND round refuses everything the first one wrote.
  it("does not count its own previous wrapper as a collision", () => {
    publishRepo("tools", "exports:\n  plugins:\n    requirements:\n      cli:\n        reqs: cli\n");
    run(TRACKED, { pathEnv: binDir });
    const second = run(TRACKED, { pathEnv: binDir });
    expect(second.commands).toEqual(["reqs"]);
    expect(second.refused).toEqual([]);
  });

  it("never overwrites or sweeps a file it did not write", () => {
    fs.writeFileSync(path.join(binDir, "reqs"), "#!/bin/sh\necho mine\n", { mode: 0o755 });
    publishRepo("tools", "exports:\n  plugins:\n    requirements:\n      cli:\n        reqs: cli\n");

    const result = run(TRACKED);
    expect(result.commands).toEqual([]);
    expect(result.failed[0]).toMatchObject({ repo: "tools" });
    expect(result.failed[0].reason).toContain("was not created by ShipIt");
    expect(fs.readFileSync(path.join(binDir, "reqs"), "utf-8")).toContain("echo mine");

    // And the sweep leaves it alone too, even once nothing wants that name.
    const dropped = run("plugins:\n  repos: []\n  use: []\n");
    expect(dropped.removed).toEqual([]);
    expect(fs.existsSync(path.join(binDir, "reqs"))).toBe(true);
  });

  it("fails closed, and audibly, when the shim is not installed", () => {
    publishRepo("tools", "exports:\n  plugins:\n    requirements:\n      cli:\n        reqs: cli\n");
    const result = run(TRACKED, { shimPath: path.join(root, "absent") });
    expect(result.commands).toEqual([]);
    expect(result.failed[0]).toMatchObject({ repo: "tools" });
    expect(result.failed[0].reason).toContain("shim is not installed");
    expect(fs.existsSync(path.join(binDir, "reqs"))).toBe(false);
  });

  // The commands half resolves `active` ONCE and reads the manifest out of the
  // concrete directory, so a round cannot describe two generations. Observable
  // consequence: the generation the link pointed at when it was resolved is the
  // one that decides, and a link pointing nowhere surfaces nothing.
  it("reads the manifest out of the generation the link resolved to", () => {
    publishRepo("tools", "exports:\n  plugins:\n    requirements:\n      cli:\n        reqs: cli\n");
    expect(run(TRACKED).commands).toEqual(["reqs"]);

    // Re-point `active` at a generation exporting a different command, the way
    // an activation round would, and the next round follows it — pinning is per
    // pass, not a cache.
    const next = path.join(storeDir, "tools", "generations", "def");
    fs.mkdirSync(next, { recursive: true });
    fs.writeFileSync(
      path.join(next, "shipit.yaml"),
      "exports:\n  plugins:\n    requirements:\n      cli:\n        reqs-2: cli\n",
    );
    fs.rmSync(path.join(storeDir, "tools", "active"));
    fs.symlinkSync(next, path.join(storeDir, "tools", "active"));

    const result = run(TRACKED);
    expect(result.commands).toEqual(["reqs-2"]);
    expect(result.removed).toEqual(["reqs"]);
  });

  it("surfaces nothing for a repository whose `active` link points nowhere", () => {
    fs.mkdirSync(path.join(storeDir, "tools"), { recursive: true });
    fs.symlinkSync(path.join(storeDir, "tools", "generations", "gone"), path.join(storeDir, "tools", "active"));

    const result = run(TRACKED);
    expect(result.commands).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.refused).toEqual([]);
  });

  it("is idempotent — an unchanged wrapper is left byte-identical", () => {
    publishRepo("tools", "exports:\n  plugins:\n    requirements:\n      cli:\n        reqs: cli\n");
    run(TRACKED);
    const before = fs.statSync(path.join(binDir, "reqs"));
    const result = run(TRACKED);
    expect(result.commands).toEqual(["reqs"]);
    expect(fs.statSync(path.join(binDir, "reqs")).ino).toBe(before.ino);
  });

  it("puts the wrapper directory LAST on PATH, so a plugin cannot shadow a system binary", () => {
    const original = process.env.PATH;
    try {
      process.env.PATH = "/usr/bin";
      run(TRACKED);
      expect(process.env.PATH).toBe(`/usr/bin${path.delimiter}${binDir}`);
      // And re-asserting it does not append a second copy.
      run(TRACKED);
      expect(process.env.PATH).toBe(`/usr/bin${path.delimiter}${binDir}`);
    } finally {
      process.env.PATH = original;
    }
  });
});
