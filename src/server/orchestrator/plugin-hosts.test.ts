/**
 * docs/262 req 24 — what each activated plugin DECLARES it must reach.
 *
 * The requirement has two halves and they are tested apart, because the module
 * split is the point: a plugin declares hosts, and the declaration GRANTS
 * NOTHING. This file covers the declaration read only. What the session's egress
 * configuration says about a declared host — the half that must never be derived
 * from the manifest — is one predicate shared with every other host surface, and
 * lives in `egress-host-reach.test.ts`.
 */

import { describe, it, expect } from "vitest";
import { pluginHostDeclarationsFor } from "./plugin-hosts.js";
import {
  parsePluginExports as parseExports,
  parsePluginRepos as parseRepos,
} from "../shared/plugin-repos.js";

const parsePluginRepos = (raw: unknown) => parseRepos(raw, [], []);
const parsePluginExports = (raw: unknown) => parseExports(raw, []);

describe("pluginHostDeclarationsFor", () => {
  it("reads the LIVE manifest of each declared repository", () => {
    const plugins = parsePluginRepos({
      repos: [{ repo: "self", name: "dev" }],
      use: [{ plugin: "probe", from: "dev" }],
    });
    const selfExports = parsePluginExports({ plugins: { probe: { hosts: ["fal.run"] } } });
    // `repo: self` resolves against the project's own manifest (req 27), so no
    // generation is needed for this half.
    expect(pluginHostDeclarationsFor(plugins, selfExports, () => null)).toEqual([
      { repo: "dev", plugin: "probe", alias: "probe", hosts: ["fal.run"] },
    ]);
  });

  /**
   * The state req 24's affordance was unreachable in: a FIRST activation whose
   * install was denied the network it declared publishes no generation, so the
   * live reader answers `null` and the card rendered no host rows — while the
   * install failure told the user to press the Allow buttons that were missing
   * (`plugin-install.ts`'s `blockedHostsClause`).
   */
  it("reads the version the last attempt TRIED, when nothing is live", () => {
    const plugins = parsePluginRepos({
      repos: [{ repo: "a/b", name: "tools", branch: "main" }],
      use: [{ plugin: "probe", from: "tools", alias: "artk" }],
    });
    const attempted = () => [{ name: "probe", hosts: ["downloads.vendor.example"] }];

    expect(pluginHostDeclarationsFor(plugins, [], () => null, attempted)).toEqual([
      { repo: "tools", plugin: "probe", alias: "artk", hosts: ["downloads.vendor.example"] },
    ]);
  });

  /**
   * A REFRESH that adds a host and then fails: the live manifest is the OLD
   * commit's and does not name it. Both versions are true at once — one is what
   * the session runs on, the other is what it will need — so the card shows the
   * union rather than either version silencing the other.
   */
  it("unions the live version's hosts with the attempted version's", () => {
    const plugins = parsePluginRepos({
      repos: [{ repo: "self", name: "dev" }],
      use: [{ plugin: "probe", from: "dev" }],
    });
    const selfExports = parsePluginExports({ plugins: { probe: { hosts: ["fal.run"] } } });
    const attempted = () => [{ name: "probe", hosts: ["fal.run", "api.pixellab.ai"] }];

    expect(pluginHostDeclarationsFor(plugins, selfExports, () => null, attempted)).toEqual([
      { repo: "dev", plugin: "probe", alias: "probe", hosts: ["fal.run", "api.pixellab.ai"] },
    ]);
  });

  // req 13 — "not knowable" is not "needs nothing", and an attempt that recorded
  // nothing must not turn a repository ShipIt cannot read into one that reports
  // an empty, satisfied-looking need list.
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
