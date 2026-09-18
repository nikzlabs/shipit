
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { minimatch } from "minimatch";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "docker",
  "agent-hooks",
  "managed-settings.json",
);

interface ManagedSettings {
  includeCoAuthoredBy?: boolean;
  disableClaudeAiConnectors?: boolean;
  permissions?: { allow?: string[]; deny?: string[] };
  hooks?: Record<string, unknown>;
}

function loadSettings(): ManagedSettings {
  return JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as ManagedSettings;
}

function parseRule(rule: string): { tool: string; pattern: string } | null {
  const m = /^(\w+)\((.+)\)$/.exec(rule);
  if (!m) return null;
  return { tool: m[1], pattern: m[2] };
}

// Approximate CLI path rules; this checks policy intent, not CLI enforcement.
function isDenied(deny: string[], tool: string, filePath: string): boolean {
  return deny.some((rule) => {
    const parsed = parseRule(rule);
    if (!parsed) return false;
    if (parsed.tool !== tool) return false;
    return parsed.pattern === filePath || minimatch(filePath, parsed.pattern, { dot: true });
  });
}

describe("managed-settings.json", () => {
  it("is valid JSON", () => {
    expect(() => loadSettings()).not.toThrow();
  });

  it("declares an explicit permissions policy (allow + deny)", () => {
    const { permissions } = loadSettings();
    expect(permissions).toBeDefined();
    expect(Array.isArray(permissions?.allow)).toBe(true);
    expect(Array.isArray(permissions?.deny)).toBe(true);
    expect(permissions?.allow?.length).toBeGreaterThan(0);
    expect(permissions?.deny?.length).toBeGreaterThan(0);
  });

  it("allows the core editing/read/search tools (codifies today's behavior)", () => {
    const allow = loadSettings().permissions?.allow ?? [];
    expect(allow).toContain("Read(**)");
    expect(allow).toContain("Edit(**)");
    expect(allow).toContain("Write(**)");
    expect(allow).toContain("Bash");
  });

  const MUTATION_TOOLS = ["Edit", "Write"];

  describe("denies writes to the agent's own settings + hooks", () => {
    for (const tool of [...MUTATION_TOOLS, "NotebookEdit"]) {
      it(`denies ${tool} under /etc/shipit`, () => {
        const deny = loadSettings().permissions?.deny ?? [];
        expect(isDenied(deny, tool, "/etc/shipit/managed-settings.json")).toBe(true);
        expect(isDenied(deny, tool, "/etc/shipit/agent-hooks/block-branch-ops.mjs")).toBe(true);
      });
    }
  });

  describe("denies writes to the OAuth / CLI-config credential files", () => {
    const CREDENTIAL_FILES = [
      "/root/.claude/.credentials.json",
      "/root/.claude/credentials.json",
      "/root/.claude/auth.json",
      "/root/.claude.json",
      "/credentials/.claude/.credentials.json",
      "/credentials/.claude.json",
    ];
    for (const file of CREDENTIAL_FILES) {
      for (const tool of MUTATION_TOOLS) {
        it(`denies ${tool}(${file})`, () => {
          const deny = loadSettings().permissions?.deny ?? [];
          expect(isDenied(deny, tool, file)).toBe(true);
        });
      }
    }
  });

  describe("does NOT block the agent's own memory updates (planning#38 follow-up)", () => {
    const MEMORY_PATHS = [
      "/root/.claude/projects/-workspace/memory/MEMORY.md",
      "/root/.claude/projects/-workspace/memory/some-fact.md",
      "/credentials/.claude/projects/-workspace/memory/MEMORY.md",
    ];
    for (const file of MEMORY_PATHS) {
      for (const tool of MUTATION_TOOLS) {
        it(`allows ${tool}(${file})`, () => {
          const deny = loadSettings().permissions?.deny ?? [];
          expect(isDenied(deny, tool, file)).toBe(false);
        });
      }
    }
  });

  it("deny overrides allow — no allow rule re-opens a denied credential file", () => {
    const { permissions } = loadSettings();
    const allow = permissions?.allow ?? [];
    for (const rule of allow) {
      const parsed = parseRule(rule);
      if (!parsed) continue;
      expect(parsed.pattern).not.toContain(".credentials.json");
      expect(parsed.pattern).not.toContain("/etc/shipit");
    }
  });

  it("disables the claude.ai connectors", () => {
    expect(loadSettings().disableClaudeAiConnectors).toBe(true);
  });

  it("does not try to re-enable connectors with an explicit false anywhere", () => {
    const raw = readFileSync(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.disableClaudeAiConnectors).not.toBe(false);
  });

  it("keeps the existing hooks and attribution settings intact", () => {
    const settings = loadSettings();
    expect(settings.includeCoAuthoredBy).toBe(false);
    expect(settings.hooks).toHaveProperty("PreToolUse");
    expect(settings.hooks).toHaveProperty("Stop");
  });
});
