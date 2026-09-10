import { describe, it, expect } from "vitest";
import { pluginHostDeclarationsFor } from "./plugin-hosts.js";
import {
  parsePluginExports as parseExports,
  parsePluginRepos as parseRepos,
} from "../shared/plugin-repos.js";

const parsePluginRepos = (raw: unknown) => parseRepos(raw, [], []);
const parsePluginExports = (raw: unknown) => parseExports(raw, []);

const req = (name: string, optional = false) => ({ name, optional });

describe("pluginHostDeclarationsFor", () => {
  it("reads the LIVE manifest of each declared repository", () => {
    const plugins = parsePluginRepos({
      repos: [{ repo: "self", name: "dev" }],
      use: [{ plugin: "probe", from: "dev" }],
    });
    const selfExports = parsePluginExports({ plugins: { probe: { hosts: ["fal.run"] } } });
    expect(pluginHostDeclarationsFor(plugins, selfExports, () => null)).toEqual([
      { repo: "dev", plugin: "probe", alias: "probe", hosts: [{ name: "fal.run", optional: false }] },
    ]);
  });

  it("carries an optional declaration through unchanged (req 24)", () => {
    const plugins = parsePluginRepos({
      repos: [{ repo: "self", name: "dev" }],
      use: [{ plugin: "assetgen", from: "dev" }],
    });
    const selfExports = parsePluginExports({
      plugins: { assetgen: { hosts: ["fal.run", { name: "pixellab.ai", optional: true }] } },
    });
    expect(pluginHostDeclarationsFor(plugins, selfExports, () => null)[0]?.hosts).toEqual([
      { name: "fal.run", optional: false },
      { name: "pixellab.ai", optional: true },
    ]);
  });

  it("reads the version the last attempt TRIED, when nothing is live", () => {
    const plugins = parsePluginRepos({
      repos: [{ repo: "a/b", name: "tools", branch: "main" }],
      use: [{ plugin: "probe", from: "tools", alias: "artk" }],
    });
    const attempted = () => [{ name: "probe", hosts: [req("downloads.vendor.example")] }];

    expect(pluginHostDeclarationsFor(plugins, [], () => null, attempted)).toEqual([
      { repo: "tools", plugin: "probe", alias: "artk", hosts: [req("downloads.vendor.example")] },
    ]);
  });

  it("unions the live version's hosts with the attempted version's", () => {
    const plugins = parsePluginRepos({
      repos: [{ repo: "self", name: "dev" }],
      use: [{ plugin: "probe", from: "dev" }],
    });
    const selfExports = parsePluginExports({ plugins: { probe: { hosts: ["fal.run"] } } });
    const attempted = () => [{ name: "probe", hosts: [req("fal.run"), req("api.pixellab.ai")] }];

    expect(pluginHostDeclarationsFor(plugins, selfExports, () => null, attempted)).toEqual([
      { repo: "dev", plugin: "probe", alias: "probe", hosts: [req("fal.run"), req("api.pixellab.ai")] },
    ]);
  });

  it("stays silent when neither version can be read", () => {
    const plugins = parsePluginRepos({
      repos: [{ repo: "a/b", name: "tools", branch: "main" }],
      use: [{ plugin: "probe", from: "tools" }],
    });
    expect(pluginHostDeclarationsFor(plugins, [], () => null, () => null)).toEqual([]);
  });

  it("never throws — a card must describe a repository whose manifest it cannot read", () => {
    const plugins = parsePluginRepos({
      repos: [{ repo: "a/b", name: "tools", branch: "main" }],
      use: [{ plugin: "probe", from: "tools" }],
    });
    expect(
      pluginHostDeclarationsFor(plugins, [], () => {
        throw new Error("state dir went away mid-request");
      }),
    ).toEqual([]);
  });
});
