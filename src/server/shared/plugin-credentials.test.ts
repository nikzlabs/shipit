import { describe, it, expect } from "vitest";
import { parsePluginExports, parsePluginRepos } from "./plugin-repos.js";
import type { PluginExport } from "./plugin-repos.js";
import {
  declaredPluginCredentials,
  pluginClaimantsOf,
  pluginCredentialNames,
  resolvePluginCredentials,
  satisfiedCredentialNames,
} from "./plugin-credentials.js";

const NO_TRACKERS: never[] = [];

/** Parse a `plugins:` block the way `shipit-config` does. */
function declare(raw: unknown) {
  const warnings: string[] = [];
  return parsePluginRepos(raw, NO_TRACKERS, warnings);
}

function manifest(raw: unknown): PluginExport[] {
  return parsePluginExports(raw, []);
}

/** A declared name, required unless said otherwise (reqs 23, 24). */
function req(name: string, optional = false) {
  return { name, optional };
}

describe("declaredPluginCredentials (docs/262 req 23)", () => {
  const plugins = declare({
    repos: [
      { repo: "self", name: "dev" },
      { repo: "nicolasalt/art-kit", name: "art-kit", branch: "main" },
    ],
    use: [
      { plugin: "probe", from: "dev" },
      { plugin: "palette", from: "art-kit", alias: "artk" },
    ],
  });

  it("groups declared names under the plugin that declares them", () => {
    const groups = declaredPluginCredentials(plugins, (repo) =>
      repo === "dev"
        ? manifest({ plugins: { probe: { credentials: ["PROBE_KEY"] } } })
        : manifest({ plugins: { palette: { credentials: ["FAL_KEY", "OPENAI_API_KEY"] } } }),
    );

    expect(groups).toEqual([
      { repo: "dev", plugin: "probe", alias: "probe", credentials: [req("PROBE_KEY")] },
      {
        repo: "art-kit",
        plugin: "palette",
        alias: "artk",
        credentials: [req("FAL_KEY"), req("OPENAI_API_KEY")],
      },
    ]);
  });

  it("carries each name's optionality through the collector", () => {
    const groups = declaredPluginCredentials(
      declare({ repos: [{ repo: "self", name: "dev" }], use: [{ plugin: "probe", from: "dev" }] }),
      () =>
        manifest({
          plugins: {
            probe: { credentials: ["PROBE_KEY", { name: "EXTRA_KEY", optional: true }] },
          },
        }),
    );
    expect(groups[0]?.credentials).toEqual([req("PROBE_KEY"), req("EXTRA_KEY", true)]);
  });

  it("resolves a name declared both ways to REQUIRED, whichever order", () => {
    // Only a malformed manifest produces the conflict, and over-reporting a gap
    // beats hiding one the plugin cannot work without.
    const collect = (credentials: unknown) =>
      declaredPluginCredentials(
        declare({ repos: [{ repo: "self", name: "dev" }], use: [{ plugin: "probe", from: "dev" }] }),
        () => manifest({ plugins: { probe: { credentials } } }),
      )[0]?.credentials;

    expect(collect([{ name: "K", optional: true }, "K"])).toEqual([req("K")]);
    expect(collect(["K", { name: "K", optional: true }])).toEqual([req("K")]);
  });

  it("reports nothing for a repository with no live manifest — not 'needs nothing'", () => {
    // req 13: a repository that never activated is unavailable, and an empty
    // needs list there would read as "this plugin requires no keys".
    const groups = declaredPluginCredentials(plugins, (repo) =>
      repo === "dev" ? manifest({ plugins: { probe: { credentials: ["PROBE_KEY"] } } }) : null,
    );
    expect(groups.map((g) => g.repo)).toEqual(["dev"]);
  });

  it("skips a selector the manifest does not export", () => {
    const groups = declaredPluginCredentials(
      declare({ repos: [{ repo: "self", name: "dev" }], use: [{ plugin: "ghost", from: "dev" }] }),
      () => manifest({ plugins: { probe: { credentials: ["PROBE_KEY"] } } }),
    );
    expect(groups).toEqual([]);
  });

  it("omits a plugin that declares no credentials", () => {
    const groups = declaredPluginCredentials(
      declare({ repos: [{ repo: "self", name: "dev" }], use: [{ plugin: "probe", from: "dev" }] }),
      () => manifest({ plugins: { probe: {} } }),
    );
    expect(groups).toEqual([]);
  });

  it("keys the group by the consumer's alias, so two uses of one plugin stay apart", () => {
    const groups = declaredPluginCredentials(
      declare({
        repos: [{ repo: "self", name: "dev" }],
        use: [
          { plugin: "probe", from: "dev", alias: "one" },
          { plugin: "probe", from: "dev", alias: "two" },
        ],
      }),
      () => manifest({ plugins: { probe: { credentials: ["PROBE_KEY"] } } }),
    );
    expect(groups.map((g) => g.alias)).toEqual(["one", "two"]);
  });
});

describe("resolvePluginCredentials", () => {
  const declarations = [
    {
      repo: "art-kit",
      plugin: "palette",
      alias: "artk",
      credentials: [req("FAL_KEY"), req("OPENAI_API_KEY")],
    },
  ];

  it("marks a name satisfied only when the project's store has it", () => {
    const [group] = resolvePluginCredentials(declarations, new Set(["FAL_KEY"]));
    expect(group.credentials).toEqual([
      { name: "FAL_KEY", satisfied: true, optional: false },
      { name: "OPENAI_API_KEY", satisfied: false, optional: false },
    ]);
  });

  it("matches names exactly — a credential name is an environment variable name", () => {
    const [group] = resolvePluginCredentials(declarations, new Set(["fal_key"]));
    expect(group.credentials[0]).toEqual({ name: "FAL_KEY", satisfied: false, optional: false });
  });

  it("with an empty store every declared name is a visible gap, never an omission", () => {
    const [group] = resolvePluginCredentials(declarations, new Set());
    expect(group.credentials.every((c) => !c.satisfied)).toBe(true);
    expect(group.credentials).toHaveLength(2);
  });

  it("carries optionality onto the resolved need, and resolves it the same way", () => {
    // Optionality bounds how an unsatisfied name is REPORTED; satisfaction
    // itself is the same store read either way (reqs 23, 24).
    const [group] = resolvePluginCredentials(
      [{ repo: "r", plugin: "p", alias: "a", credentials: [req("SET_KEY", true), req("UNSET_KEY", true)] }],
      new Set(["SET_KEY"]),
    );
    expect(group.credentials).toEqual([
      { name: "SET_KEY", satisfied: true, optional: true },
      { name: "UNSET_KEY", satisfied: false, optional: true },
    ]);
  });
});

describe("claimant projection (plan §3 — one stored secret, many claimants)", () => {
  const declarations = [
    { repo: "art-kit", plugin: "palette", alias: "artk", credentials: [req("FAL_KEY")] },
    { repo: "dev", plugin: "probe", alias: "probe", credentials: [req("FAL_KEY"), req("PROBE_KEY")] },
  ];

  it("de-duplicates names across plugins", () => {
    expect(pluginCredentialNames(declarations)).toEqual(["FAL_KEY", "PROBE_KEY"]);
  });

  it("lists every plugin claiming a name", () => {
    expect(pluginClaimantsOf(declarations, "FAL_KEY")).toEqual(["artk", "probe"]);
    expect(pluginClaimantsOf(declarations, "PROBE_KEY")).toEqual(["probe"]);
    expect(pluginClaimantsOf(declarations, "NOBODY")).toEqual([]);
  });

  it("counts an OPTIONAL name too — the settings row is where a key is set", () => {
    // A plugin that can use a key is exactly a plugin whose key someone may
    // want to provide; a row that never appears cannot be filled in.
    const withOptional = [
      { repo: "dev", plugin: "probe", alias: "probe", credentials: [req("EXTRA_KEY", true)] },
    ];
    expect(pluginCredentialNames(withOptional)).toEqual(["EXTRA_KEY"]);
    expect(pluginClaimantsOf(withOptional, "EXTRA_KEY")).toEqual(["probe"]);
  });
});

/**
 * docs/262 req 23 — the ONE rule that decides whether a stored value satisfies a
 * declared credential. Both the card's verdict and what a plugin container is
 * given are computed from it, which is what makes them the same answer.
 */
describe("the satisfaction rule (req 23)", () => {
  it("a non-empty single-line value satisfies its name", () => {
    expect([...satisfiedCredentialNames({ FAL_KEY: "sk-live" })]).toEqual(["FAL_KEY"]);
  });

  it("an empty value is a name the user started to set and did not", () => {
    expect(satisfiedCredentialNames({ FAL_KEY: "" }).size).toBe(0);
  });

  it("an arbitrary string value satisfies its name", () => {
    // No narrower rule: every delivery surface carries an arbitrary string —
    // the override's `environment` for a plugin service, the invocation
    // container's `Env` for a companion CLI — so excluding a shape here would
    // report a working credential as missing.
    const awkward = {
      PEM: "-----BEGIN-----\nx\n-----END-----",
      DOLLARS: `a$b$\{HOME}`,
      HASH: "value # not a comment",
      QUOTED: '"quoted"',
    };
    expect([...satisfiedCredentialNames(awkward)].sort()).toEqual(
      ["DOLLARS", "HASH", "PEM", "QUOTED"],
    );
  });

  it("a non-string value never satisfies a name", () => {
    expect(satisfiedCredentialNames({ N: 7 as unknown as string }).size).toBe(0);
  });
});
