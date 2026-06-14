/**
 * Tests for docker/agent-hooks/managed-settings.json — the ShipIt-managed
 * Claude Code settings file baked into /etc/shipit/managed-settings.json and
 * always passed to the CLI via --settings for the `claude` agent.
 *
 * SHI-36 / docs/097 — "Explicit session-agent permissions". These assertions
 * are the executable contract the design doc asks for: they fail if the
 * explicit permission policy is removed or its load-bearing deny rules are
 * weakened. Today the real CLI's enforcement can't run in this harness (the
 * integration tests use a FakeClaudeProcess), so this is the regression guard
 * that catches the policy silently disappearing — or, just as important,
 * silently becoming over-broad and blocking a legitimate write (memory).
 *
 * Like the sibling block-branch-ops / stop-pr-check tests, the file ships from
 * docker/agent-hooks/ but the test lives under src/server/** so vitest picks it
 * up.
 */

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
  permissions?: { allow?: string[]; deny?: string[] };
  hooks?: Record<string, unknown>;
}

function loadSettings(): ManagedSettings {
  return JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as ManagedSettings;
}

/** Parse a `Tool(path)` permission rule into its parts. Returns null if not file-scoped. */
function parseRule(rule: string): { tool: string; pattern: string } | null {
  const m = /^(\w+)\((.+)\)$/.exec(rule);
  if (!m) return null;
  return { tool: m[1], pattern: m[2] };
}

/**
 * True if any deny rule for `tool` would match `filePath`. Mirrors the
 * gitignore-style glob semantics the Claude CLI uses for path rules well enough
 * to assert intent (exact match or `/**`-suffix prefix match).
 */
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
    // The whole point of the feature: editing must stay permissive even if the
    // CLI ships a more restrictive headless default. These are the tools the
    // orchestrator grants via --allowedTools (AUTO_TOOLS in process.ts).
    expect(allow).toContain("Read(**)");
    expect(allow).toContain("Edit(**)");
    expect(allow).toContain("Write(**)");
    expect(allow).toContain("Bash");
  });

  const MUTATION_TOOLS = ["Edit", "Write"];

  describe("denies writes to the agent's own settings + hooks", () => {
    // /etc/shipit holds the managed policy + branch-block/PR hooks — the agent
    // must not be able to rewrite its own permission policy. No memory lives
    // here, so a tree-wide deny is safe.
    for (const tool of [...MUTATION_TOOLS, "NotebookEdit"]) {
      it(`denies ${tool} under /etc/shipit`, () => {
        const deny = loadSettings().permissions?.deny ?? [];
        expect(isDenied(deny, tool, "/etc/shipit/managed-settings.json")).toBe(true);
        expect(isDenied(deny, tool, "/etc/shipit/agent-hooks/block-branch-ops.mjs")).toBe(true);
      });
    }
  });

  describe("denies writes to the OAuth / CLI-config credential files", () => {
    // Both spellings: /root/.claude is a symlink to /credentials/.claude.
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

  describe("does NOT block the agent's own memory updates (SHI-36 follow-up)", () => {
    // /root/.claude/projects/<cwd>/memory/ lives inside the same .claude tree as
    // the credentials (via the /credentials/.claude symlink). The deny list is
    // deliberately file-specific, not a /root/.claude/** or /credentials/** tree
    // glob, so memory stays writable. This is the regression guard for the
    // over-broad-deny mistake the first cut of this policy made.
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
    // An allow like `Write(/root/.claude/.credentials.json)` wouldn't actually
    // grant access (deny wins in Claude Code) but would signal confused intent.
    for (const rule of allow) {
      const parsed = parseRule(rule);
      if (!parsed) continue;
      expect(parsed.pattern).not.toContain(".credentials.json");
      expect(parsed.pattern).not.toContain("/etc/shipit");
    }
  });

  it("keeps the existing hooks and attribution settings intact", () => {
    // The permissions block is additive — it must not have clobbered the
    // branch-block / PR-enforcement hooks or the co-author suppression.
    const settings = loadSettings();
    expect(settings.includeCoAuthoredBy).toBe(false);
    expect(settings.hooks).toHaveProperty("PreToolUse");
    expect(settings.hooks).toHaveProperty("Stop");
  });
});
