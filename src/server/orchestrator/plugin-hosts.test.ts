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
