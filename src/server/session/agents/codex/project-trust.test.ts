import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexProjectsState, ensureCodexProjectTrusted } from "./project-trust.js";

/**
 * Codex disables a project's own `.codex/` config, hooks and exec policies —
 * and logs an ERROR on `initialize` — until the directory is trusted in
 * `$CODEX_HOME/config.toml`. Every ShipIt workspace has a `.codex/` (plugin
 * skills create one per harness), so this ran on every Codex turn.
 *
 * The exact TOML shape is the contract with the CLI (verified against
 * codex-cli 0.153.2 by driving the real app-server), so the assertions match it
 * literally rather than through a parser.
 */
describe("ensureCodexProjectTrusted", () => {
  let configDir: string;
  const configText = (): string => fs.readFileSync(path.join(configDir, "config.toml"), "utf-8");

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-trust-"));
  });

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it("writes the trust entry in the shape the CLI reads", () => {
    expect(ensureCodexProjectTrusted(configDir, "/workspace")).toBe(true);
    expect(configText()).toContain('[projects."/workspace"]\ntrust_level = "trusted"');
  });

  it("creates config.toml inside an existing, empty config dir", () => {
    const fresh = path.join(configDir, "nested");
    fs.mkdirSync(fresh);
    expect(ensureCodexProjectTrusted(fresh, "/workspace")).toBe(true);
    expect(fs.readFileSync(path.join(fresh, "config.toml"), "utf-8"))
      .toContain('[projects."/workspace"]');
  });

  it("never creates the config dir itself", () => {
    // A caller with a not-yet-real home (a fake account root in a unit test)
    // must not grow a directory tree on disk — the production callers all mkdir
    // it first, and the CLI would create it anyway.
    const absent = path.join(configDir, "absent", ".codex");
    expect(ensureCodexProjectTrusted(absent, "/workspace")).toBe(false);
    expect(fs.existsSync(path.join(configDir, "absent"))).toBe(false);
  });

  it("is idempotent — a second call writes nothing", () => {
    ensureCodexProjectTrusted(configDir, "/workspace");
    const first = configText();
    expect(ensureCodexProjectTrusted(configDir, "/workspace")).toBe(false);
    expect(configText()).toBe(first);
  });

  it("preserves an existing config, including the managed MCP block", () => {
    const existing = [
      "model = \"gpt-5.6-sol\"",
      "",
      "# <shipit-managed-mcp>",
      "[mcp_servers.playwright]",
      'command = "sh"',
      "# </shipit-managed-mcp>",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(configDir, "config.toml"), existing);

    expect(ensureCodexProjectTrusted(configDir, "/workspace")).toBe(true);
    const cfg = configText();
    expect(cfg).toContain('model = "gpt-5.6-sol"');
    expect(cfg).toContain("[mcp_servers.playwright]");
    // The entry lands AFTER the managed block's end marker, which is what keeps
    // the next writeMcpConfig() (it replaces only between the markers) from
    // dropping it — and what keeps it out of the `[mcp_servers.*]` tables.
    expect(cfg.indexOf('[projects."/workspace"]'))
      .toBeGreaterThan(cfg.indexOf("# </shipit-managed-mcp>"));
  });

  it("leaves an existing [projects.…] table for the same dir alone", () => {
    // An explicit decision — the user's, or the Codex CLI's own — is not ours
    // to overwrite, even when it says untrusted.
    fs.writeFileSync(
      path.join(configDir, "config.toml"),
      '[projects."/workspace"]\ntrust_level = "untrusted"\n',
    );
    expect(ensureCodexProjectTrusted(configDir, "/workspace")).toBe(false);
    expect(configText()).not.toContain('trust_level = "trusted"');
  });

  it("still adds an entry when a DIFFERENT directory is already declared", () => {
    fs.writeFileSync(
      path.join(configDir, "config.toml"),
      '[projects."/other"]\ntrust_level = "trusted"\n',
    );
    expect(ensureCodexProjectTrusted(configDir, "/workspace")).toBe(true);
    const cfg = configText();
    expect(cfg).toContain('[projects."/other"]');
    expect(cfg).toContain('[projects."/workspace"]');
  });

  it("normalizes the directory it keys on", () => {
    ensureCodexProjectTrusted(configDir, "/workspace/");
    expect(configText()).toContain('[projects."/workspace"]');
    // …so the normalized form is recognized on the next spawn.
    expect(ensureCodexProjectTrusted(configDir, "/workspace")).toBe(false);
  });

  it("keys on the exact directory — a local-mode workspace is not /workspace", () => {
    // RUNTIME_MODE=local spawns in `<dataDir>/sessions/<id>/workspace`, and
    // Codex trust is per-directory: an ancestor grants nothing.
    ensureCodexProjectTrusted(configDir, "/data/sessions/abc/workspace");
    expect(configText()).toContain('[projects."/data/sessions/abc/workspace"]');
    expect(codexProjectsState(configText(), "/workspace")).toBe("absent");
  });

  it("survives a config it cannot write, leaving the old content intact", () => {
    // A directory where the file goes: writeFileSync fails with EISDIR for root
    // too, so this exercises the failure branch on every runner.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-trust-ro-"));
    fs.mkdirSync(path.join(dir, "config.toml"));
    fs.writeFileSync(path.join(dir, "config.toml", "canary"), "kept");
    try {
      expect(() => ensureCodexProjectTrusted(dir, "/workspace")).not.toThrow();
      expect(ensureCodexProjectTrusted(dir, "/workspace")).toBe(false);
      // Nothing of the original was destroyed on the way to failing.
      expect(fs.readFileSync(path.join(dir, "config.toml", "canary"), "utf-8")).toBe("kept");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * A duplicate table is not a cosmetic problem: it makes the whole file
   * invalid TOML, so Codex fails to start instead of merely warning. These are
   * the spellings of the SAME table a string compare misses — the reviewer's
   * finding on the first cut of this module.
   */
  describe("equivalent spellings of an existing entry", () => {
    for (const [name, header] of [
      ["a trailing comment", '[projects."/workspace"] # my decision'],
      ["a literal string", "[projects.'/workspace']"],
      ["whitespace inside the header", '[ projects . "/workspace" ]'],
      ["a subtable of the same dir", '[projects."/workspace".extra]'],
      ["a root dotted key", 'projects."/workspace".trust_level = "untrusted"'],
    ] as const) {
      it(`recognizes ${name}`, () => {
        fs.writeFileSync(path.join(configDir, "config.toml"), `${header}\n`);
        expect(codexProjectsState(configText(), "/workspace")).toBe("declared");
        expect(ensureCodexProjectTrusted(configDir, "/workspace")).toBe(false);
        expect(configText()).toBe(`${header}\n`);
      });
    }

    it("refuses a bare [projects] table rather than risk a duplicate key", () => {
      // The dir's key may or may not be inside it, and this scanner does not
      // parse table bodies. Skipping costs the warning; guessing costs the file.
      fs.writeFileSync(
        path.join(configDir, "config.toml"),
        '[projects]\n"/workspace" = { trust_level = "trusted" }\n',
      );
      expect(codexProjectsState(configText(), "/workspace")).toBe("ambiguous");
      expect(ensureCodexProjectTrusted(configDir, "/workspace")).toBe(false);
    });

    it("refuses an array of tables named projects", () => {
      fs.writeFileSync(path.join(configDir, "config.toml"), '[[projects]]\nname = "x"\n');
      expect(ensureCodexProjectTrusted(configDir, "/workspace")).toBe(false);
    });

    it("still writes past an unrelated table whose keys mention projects", () => {
      // `[tools] projects = 3` is not the root `projects` table, and a
      // `[projects."/other"]` entry is a different directory — neither blocks.
      fs.writeFileSync(
        path.join(configDir, "config.toml"),
        '[projects."/other"]\ntrust_level = "trusted"\n\n[tools]\nprojects = 3\n',
      );
      expect(ensureCodexProjectTrusted(configDir, "/workspace")).toBe(true);
      const cfg = configText();
      expect(cfg).toContain('[projects."/other"]');
      expect(cfg).toContain('[projects."/workspace"]');
      // Exactly one declaration of our table, whatever else the file holds.
      expect(cfg.match(/\[projects\."\/workspace"\]/g)).toHaveLength(1);
    });
  });
});
