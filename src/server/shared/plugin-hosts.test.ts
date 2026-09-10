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

function req(name: string, optional = false) {
  return { name, optional };
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
      { repo: "tools", plugin: "palette", alias: "artk", hosts: [req("fal.run"), req("cdn.fal.run")] },
    ]);
  });

  it("a repository with no readable manifest reports nothing, never 'needs no network'", () => {
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
    { repo: "tools", plugin: "palette", alias: "artk", hosts: [req("fal.run"), req("cdn.fal.run")] },
  ];

  it("asks the session's predicate for every host and carries its verdict through", () => {
    const asked: string[] = [];
    const groups = resolvePluginHosts(declarations, (h) => {
      asked.push(h);
      return h === "fal.run" ? "allowed" : "grantable";
    });
    expect(asked).toEqual(["fal.run", "cdn.fal.run"]);
    expect(groups[0].hosts).toEqual([
      { host: "fal.run", reach: "allowed", optional: false },
      { host: "cdn.fal.run", reach: "grantable", optional: false },
    ]);
  });

  it("a predicate that allows nothing marks every declared host as a gap", () => {
    const groups = resolvePluginHosts(declarations, () => "grantable");
    expect(groups[0].hosts.every((h) => h.reach !== "allowed")).toBe(true);
  });

  it("asks the predicate about an OPTIONAL host too, and carries the flag through", () => {
    const asked: string[] = [];
    const groups = resolvePluginHosts(
      [{ repo: "tools", plugin: "assetgen", alias: "assetgen", hosts: [req("fal.run"), req("pixellab.ai", true)] }],
      (h) => {
        asked.push(h);
        return "grantable";
      },
    );
    expect(asked).toEqual(["fal.run", "pixellab.ai"]);
    expect(groups[0].hosts).toEqual([
      { host: "fal.run", reach: "grantable", optional: false },
      { host: "pixellab.ai", reach: "grantable", optional: true },
    ]);
  });

  it("collects an optional host from the manifest as optional", () => {
    const declarations = declaredPluginHosts(
      config({
        repos: [{ repo: "a/b", name: "tools", branch: "main" }],
        use: [{ plugin: "assetgen", from: "tools" }],
      }),
      () =>
        manifest({
          plugins: {
            assetgen: { hosts: ["fal.run", { name: "pixellab.ai", optional: true }] },
          },
        }),
    );
    expect(declarations[0]?.hosts).toEqual([req("fal.run"), req("pixellab.ai", true)]);
  });

  it("passes a verdict no grant can close through unchanged", () => {
    const groups = resolvePluginHosts(declarations, () => "blocked-by-deployment");
    expect(groups[0].hosts.map((h) => h.reach)).toEqual(["blocked-by-deployment", "blocked-by-deployment"]);
  });
});
