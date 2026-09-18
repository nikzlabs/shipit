import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexProjectsState, ensureCodexProjectTrusted } from "./project-trust.js";

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
    expect(cfg.indexOf('[projects."/workspace"]'))
      .toBeGreaterThan(cfg.indexOf("# </shipit-managed-mcp>"));
  });

  it("leaves an existing [projects.…] table for the same dir alone", () => {
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
    expect(ensureCodexProjectTrusted(configDir, "/workspace")).toBe(false);
  });

  it("keys on the exact directory — a local-mode workspace is not /workspace", () => {
    ensureCodexProjectTrusted(configDir, "/data/sessions/abc/workspace");
    expect(configText()).toContain('[projects."/data/sessions/abc/workspace"]');
    expect(codexProjectsState(configText(), "/workspace")).toBe("absent");
  });

  it("survives a config it cannot write, leaving the old content intact", () => {
    // EISDIR fails even as root.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-trust-ro-"));
    fs.mkdirSync(path.join(dir, "config.toml"));
    fs.writeFileSync(path.join(dir, "config.toml", "canary"), "kept");
    try {
      expect(() => ensureCodexProjectTrusted(dir, "/workspace")).not.toThrow();
      expect(ensureCodexProjectTrusted(dir, "/workspace")).toBe(false);
      expect(fs.readFileSync(path.join(dir, "config.toml", "canary"), "utf-8")).toBe("kept");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

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
      fs.writeFileSync(
        path.join(configDir, "config.toml"),
        '[projects."/other"]\ntrust_level = "trusted"\n\n[tools]\nprojects = 3\n',
      );
      expect(ensureCodexProjectTrusted(configDir, "/workspace")).toBe(true);
      const cfg = configText();
      expect(cfg).toContain('[projects."/other"]');
      expect(cfg).toContain('[projects."/workspace"]');
      expect(cfg.match(/\[projects\."\/workspace"\]/g)).toHaveLength(1);
    });
  });
});
