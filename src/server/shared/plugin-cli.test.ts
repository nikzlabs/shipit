/**
 * docs/262 reqs 17, 20 — the command plan both sides of the container edge
 * share. Every case here is a way a surfaced command could be silently wrong.
 */

import { describe, it, expect } from "vitest";
import { planPluginCommands, RESERVED_PLUGIN_COMMANDS } from "./plugin-cli.js";
import type { PluginExport, PluginUse } from "./plugin-repos.js";

function exported(name: string, cli: Record<string, string>): PluginExport {
  return { name, cli, installInputs: [], credentials: [], hosts: [], settings: {} };
}

function use(
  alias: string,
  plugin: string,
  from: string,
  commands: Record<string, { as?: string }> = {},
): PluginUse {
  return { plugin, from, alias, overrides: { services: {}, commands, settings: {} } };
}

/** Resolve every import against one flat table of `alias → export`. */
function table(entries: Record<string, { repo: string; exported: PluginExport | null }>) {
  return (u: PluginUse) => entries[u.alias] ?? { repo: null, exported: null };
}

describe("planPluginCommands", () => {
  it("surfaces a plugin's declared commands under their manifest names", () => {
    const plan = planPluginCommands(
      [use("reqs", "requirements", "game-tools")],
      table({ reqs: { repo: "game-tools", exported: exported("requirements", { reqs: "cli/index.mjs" }) } }),
    );

    expect(plan.commands).toEqual([
      { name: "reqs", alias: "reqs", repo: "game-tools", plugin: "requirements", declared: "reqs", entry: "cli/index.mjs" },
    ]);
    expect(plan.issues.size).toBe(0);
  });

  it("applies the consumer's rename, matched case-insensitively", () => {
    const plan = planPluginCommands(
      [use("reqs", "requirements", "game-tools", { REQS: { as: "rt-reqs" } })],
      table({ reqs: { repo: "game-tools", exported: exported("requirements", { reqs: "cli" }) } }),
    );

    expect(plan.commands.map((c) => c.name)).toEqual(["rt-reqs"]);
    // The manifest's own name still travels, because that is what the run
    // boundary looks the command up by.
    expect(plan.commands[0].declared).toBe("reqs");
    expect(plan.issues.size).toBe(0);
  });

  it("reports a rename for a command the plugin does not export", () => {
    const plan = planPluginCommands(
      [use("reqs", "requirements", "game-tools", { nope: { as: "x" } })],
      table({ reqs: { repo: "game-tools", exported: exported("requirements", { reqs: "cli" }) } }),
    );

    // The command itself still surfaces — only the rename was meaningless.
    expect(plan.commands.map((c) => c.name)).toEqual(["reqs"]);
    expect(plan.issues.get("game-tools")?.join("\n")).toContain("`nope` is not a command");
  });

  // The requirement's own words: report the collision *before running the
  // ambiguous one*. First-declared-wins is exactly what that rules out.
  it("refuses EVERY claimant of a contested name and names the fix", () => {
    const plan = planPluginCommands(
      [use("a", "one", "repo-a"), use("b", "two", "repo-b")],
      table({
        a: { repo: "repo-a", exported: exported("one", { reqs: "a/cli" }) },
        b: { repo: "repo-b", exported: exported("two", { reqs: "b/cli" }) },
      }),
    );

    expect(plan.commands).toEqual([]);
    for (const repo of ["repo-a", "repo-b"]) {
      const text = plan.issues.get(repo)!.join("\n");
      expect(text).toContain("claimed by more than one plugin");
      expect(text).toContain("`a`");
      expect(text).toContain("`b`");
      expect(text).toContain("overrides.commands.reqs.as");
    }
  });

  it("treats names differing only in case as one name", () => {
    const plan = planPluginCommands(
      [use("a", "one", "repo-a"), use("b", "two", "repo-b")],
      table({
        a: { repo: "repo-a", exported: exported("one", { Reqs: "a/cli" }) },
        b: { repo: "repo-b", exported: exported("two", { reqs: "b/cli" }) },
      }),
    );
    expect(plan.commands).toEqual([]);
  });

  it("a rename RESOLVES the collision — which is req 20's second half", () => {
    const plan = planPluginCommands(
      [use("a", "one", "repo-a", { reqs: { as: "a-reqs" } }), use("b", "two", "repo-b")],
      table({
        a: { repo: "repo-a", exported: exported("one", { reqs: "a/cli" }) },
        b: { repo: "repo-b", exported: exported("two", { reqs: "b/cli" }) },
      }),
    );
    expect(plan.commands.map((c) => c.name)).toEqual(["a-reqs", "reqs"]);
    expect(plan.issues.size).toBe(0);
  });

  it("refuses a name ShipIt reserves, even where no binary exists", () => {
    expect(RESERVED_PLUGIN_COMMANDS.has("shipit")).toBe(true);
    const plan = planPluginCommands(
      [use("evil", "evil", "repo-a")],
      table({ evil: { repo: "repo-a", exported: exported("evil", { git: "cli" }) } }),
    );
    expect(plan.commands).toEqual([]);
    expect(plan.issues.get("repo-a")![0]).toContain("a name ShipIt reserves");
  });

  it("refuses a name that already resolves on PATH, and says what it would shadow", () => {
    const plan = planPluginCommands(
      [use("t", "tool", "repo-a")],
      table({ t: { repo: "repo-a", exported: exported("tool", { jq: "cli" }) } }),
      { isTaken: (name) => name === "jq", describeTaken: () => "`/usr/bin/jq`" },
    );
    expect(plan.commands).toEqual([]);
    expect(plan.issues.get("repo-a")![0]).toContain("would shadow `/usr/bin/jq`");
  });

  it("contributes nothing for an import with no live manifest", () => {
    const plan = planPluginCommands(
      [use("reqs", "requirements", "game-tools")],
      table({ reqs: { repo: "game-tools", exported: null } }),
    );
    expect(plan.commands).toEqual([]);
    expect(plan.issues.size).toBe(0);
  });

  it("orders commands by name, not by declaration", () => {
    const plan = planPluginCommands(
      [use("z", "zed", "repo-z"), use("a", "ay", "repo-a")],
      table({
        z: { repo: "repo-z", exported: exported("zed", { zulu: "cli" }) },
        a: { repo: "repo-a", exported: exported("ay", { alpha: "cli" }) },
      }),
    );
    expect(plan.commands.map((c) => c.name)).toEqual(["alpha", "zulu"]);
  });

  // A declared repository name is unconstrained enough to be `constructor` —
  // the exact defect the settings resolver's `Map` was introduced to fix.
  it("groups issues in a Map, so a prototype-named repository is not truthy for free", () => {
    const plan = planPluginCommands(
      [use("ok", "one", "constructor")],
      table({ ok: { repo: "constructor", exported: exported("one", { git: "cli" }) } }),
    );
    expect(plan.issues.get("constructor")).toHaveLength(1);
    expect(plan.issues.get("toString")).toBeUndefined();
  });
});
