// docs/262 req 24 — declared hosts, collected and resolved. The property under
// test throughout: the declaration is an INPUT to the report and never to the
// answer — "a plugin declaration never widens a session's network reach by
// itself".

import { describe, expect, it } from "vitest";
import { declaredPluginHosts, resolvePluginHosts } from "./plugin-hosts.js";
import { parsePluginExports, parsePluginRepos } from "./plugin-repos.js";
import type { PluginExport } from "./plugin-repos.js";
import type { DeclaredTracker } from "./declared-tracker.js";

const NO_TRACKERS: DeclaredTracker[] = [];

function config(raw: unknown) {
  return parsePluginRepos(raw, NO_TRACKERS, []);
}

function manifest(raw: unknown): PluginExport[] {
  return parsePluginExports(raw, []);
}

const DECLARATION = {
  repos: [
    { repo: "a/b", name: "tools", branch: "main" },
    { repo: "c/d", name: "other", branch: "main" },
  ],
  use: [
    { plugin: "palette", from: "tools", alias: "artk" },
    { plugin: "probe", from: "tools" },
    { plugin: "anything", from: "other" },
  ],
};

const TOOLS = manifest({
  plugins: {
    palette: { hosts: ["fal.run", "cdn.fal.run", "fal.run"] },
    probe: {},
  },
});

describe("declaredPluginHosts", () => {
  it("groups hosts under the activated plugin, de-duplicated in manifest order", () => {
    const declarations = declaredPluginHosts(config(DECLARATION), (name) =>
      name === "tools" ? TOOLS : null,
    );
    expect(declarations).toEqual([
      { repo: "tools", plugin: "palette", alias: "artk", hosts: ["fal.run", "cdn.fal.run"] },
    ]);
  });

  it("a repository with no readable manifest reports nothing, never 'needs no network'", () => {
    // req 13 — "not knowable" must not render as an answer. A repository that
    // never activated has not told us what it calls, and a card saying it needs
    // nothing would be a fetch failure disguised as a clean bill of health.
    expect(declaredPluginHosts(config(DECLARATION), () => null)).toEqual([]);
  });

  it("skips a selector that names no exported plugin", () => {
    const declarations = declaredPluginHosts(
      config({
        repos: [{ repo: "a/b", name: "tools", branch: "main" }],
        use: [{ plugin: "ghost", from: "tools" }],
      }),
      () => TOOLS,
    );
    expect(declarations).toEqual([]);
  });

  it("a declared repository with no `use:` entry activates nothing", () => {
    const declarations = declaredPluginHosts(
      config({ repos: [{ repo: "a/b", name: "tools", branch: "main" }] }),
      () => TOOLS,
    );
    expect(declarations).toEqual([]);
  });
});

describe("resolvePluginHosts", () => {
  const declarations = [
    { repo: "tools", plugin: "palette", alias: "artk", hosts: ["fal.run", "cdn.fal.run"] },
  ];

  it("asks the session's predicate for every host and carries its verdict through", () => {
    const asked: string[] = [];
    const groups = resolvePluginHosts(declarations, (h) => {
      asked.push(h);
      return h === "fal.run" ? "allowed" : "grantable";
    });
    expect(asked).toEqual(["fal.run", "cdn.fal.run"]);
    expect(groups[0].hosts).toEqual([
      { host: "fal.run", reach: "allowed" },
      { host: "cdn.fal.run", reach: "grantable" },
    ]);
  });

  it("a predicate that allows nothing marks every declared host as a gap", () => {
    // The shape of the guarantee: nothing in this module can turn a declaration
    // into an allowance, so a session that permits nothing shows every host as
    // "not yet allowed" no matter what the manifest says.
    const groups = resolvePluginHosts(declarations, () => "grantable");
    expect(groups[0].hosts.every((h) => h.reach !== "allowed")).toBe(true);
  });

  it("passes a verdict no grant can close through unchanged", () => {
    // The projection must not flatten `blocked-*` back into "not allowed":
    // that distinction is the whole of planning#383, and the card decides
    // whether to render a button from it.
    const groups = resolvePluginHosts(declarations, () => "blocked-by-deployment");
    expect(groups[0].hosts.map((h) => h.reach)).toEqual(["blocked-by-deployment", "blocked-by-deployment"]);
  });
});
