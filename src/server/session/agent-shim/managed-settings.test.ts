
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

const INSTALLED_DIR = "/etc/shipit";
const AGENT_CWD = "/workspace";
// The session worker's home, the dogfood `dev` service's (docker-compose.yml), and a sub-agent spawn's.
const AGENT_HOMES = ["/home/shipit", "/workspace/.inner-shipit/agent-home", "/credentials/sub-agent-homes/spawn-1"];

// The CLI's rule semantics, measured with Claude Code 2.1.300 (docs/097-explicit-session-agent-permissions).
// Symlink resolution is not modelled, so every spelling must match on its own.
function resolveRulePath(pattern: string, home: string): string {
  if (pattern.startsWith("//")) return pattern.slice(1);
  if (pattern.startsWith("~/")) return path.posix.join(home, pattern.slice(2));
  if (pattern.startsWith("/")) return path.posix.join(INSTALLED_DIR, pattern);
  return path.posix.join(AGENT_CWD, pattern);
}

// Only Edit(path) rules are path-matched, and they cover every file-edit tool.
function isDenied(deny: string[], filePath: string, home: string): boolean {
  return deny.some((rule) => {
    const parsed = parseRule(rule);
    if (parsed?.tool !== "Edit") return false;
    return minimatch(filePath, resolveRulePath(parsed.pattern, home), { dot: true });
  });
}

function docProtectedPaths(): string[] {
  const doc = readFileSync(path.resolve(__dirname, "..", "..", "shipit-docs", "environment.md"), "utf8");
  const section = /^### Write-protected paths\n([\s\S]*?)\n### /m.exec(doc)?.[1] ?? "";
  return section
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .flatMap((line) => {
      // A bullet lists its paths before the first " — "; the rest explains them.
      const [list, rest = ""] = line.split(" — ");
      const paths = [...list.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((p) => /^[~/]/.test(p));
      const twins = rest.includes("the same files under `/credentials/`")
        ? paths.filter((p) => p.startsWith("~/")).map((p) => p.replace(/^~\//, "/credentials/"))
        : [];
      return [...paths, ...twins];
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
    expect(allow).toContain("Bash");
  });

  // A write through a workspace symlink needs a path rule for its target; `Edit(**)` covers the
  // working directory only, and one Edit rule covers Write and NotebookEdit too (measured with
  // Claude Code 2.1.300, docs/193-sensitive-file-permission).
  it("allows the write tools on the persist directory by its real path", () => {
    expect(loadSettings().permissions?.allow).toContain("Edit(//persist/**)");
  });

  it("holds no allow rule that the CLI ignores", () => {
    const allow = loadSettings().permissions?.allow ?? [];
    for (const rule of allow) {
      expect(["Write", "NotebookEdit", "Glob"], rule).not.toContain(parseRule(rule)?.tool);
    }
  });

  // A Write(path) or NotebookEdit(path) rule matches nothing, and a single leading slash
  // names a path under /etc/shipit; both left the whole deny list dead until 2026-10-28.
  it("writes every deny rule as Edit(//absolute) or Edit(~/home)", () => {
    const deny = loadSettings().permissions?.deny ?? [];
    for (const rule of deny) {
      const parsed = parseRule(rule);
      expect(parsed?.tool, rule).toBe("Edit");
      expect(parsed?.pattern, rule).toMatch(/^(\/\/|~\/)/);
    }
  });

  it("denies writes to the agent's own settings + hooks under /etc/shipit", () => {
    const deny = loadSettings().permissions?.deny ?? [];
    expect(isDenied(deny, "/etc/shipit/managed-settings.json", "/home/shipit")).toBe(true);
    expect(isDenied(deny, "/etc/shipit/agent-hooks/block-branch-ops.mjs", "/home/shipit")).toBe(true);
  });

  describe("denies writes to the OAuth / CLI-config credential files", () => {
    const CLAUDE_DIR_FILES = [
      ".credentials.json",
      "credentials.json",
      "auth.json",
      "settings.json",
      "settings.local.json",
      "settings.team.json",
    ];
    for (const home of AGENT_HOMES) {
      it(`denies them in the home ${home} and under /credentials`, () => {
        const deny = loadSettings().permissions?.deny ?? [];
        for (const file of CLAUDE_DIR_FILES) {
          expect(isDenied(deny, `${home}/.claude/${file}`, home), `${home}/.claude/${file}`).toBe(true);
          expect(isDenied(deny, `/credentials/.claude/${file}`, home), `/credentials/.claude/${file}`).toBe(true);
        }
        expect(isDenied(deny, `${home}/.claude.json`, home)).toBe(true);
        expect(isDenied(deny, "/credentials/.claude.json", home)).toBe(true);
      });
    }
  });

  describe("does NOT block the agent's own memory updates (planning#38 follow-up)", () => {
    for (const home of AGENT_HOMES) {
      it(`allows memory writes in the home ${home} and under /credentials`, () => {
        const deny = loadSettings().permissions?.deny ?? [];
        for (const file of [
          `${home}/.claude/projects/-workspace/memory/MEMORY.md`,
          `${home}/.claude/projects/-workspace/memory/some-fact.md`,
          "/credentials/.claude/projects/-workspace/memory/MEMORY.md",
        ]) {
          expect(isDenied(deny, file, home), file).toBe(false);
        }
      });
    }
  });

  it("denies exactly the paths that shipit-docs/environment.md lists", () => {
    const documented = docProtectedPaths();
    expect(documented).toContain("/etc/shipit/**");
    const denied = (loadSettings().permissions?.deny ?? []).map((rule) => {
      const pattern = parseRule(rule)?.pattern ?? rule;
      return pattern.startsWith("//") ? pattern.slice(1) : pattern;
    });
    expect([...denied].sort()).toEqual([...documented].sort());
  });

  it("names no credential file or /etc/shipit path in an allow rule", () => {
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
