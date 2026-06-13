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
 * that catches the policy silently disappearing.
 *
 * Like the sibling block-branch-ops / stop-pr-check tests, the file ships from
 * docker/agent-hooks/ but the test lives under src/server/** so vitest picks it
 * up.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

  // The sensitive trees the agent must never write — even though Write(**) /
  // Edit(**) are allowed, deny overrides allow.
  const SENSITIVE_TREES = ["/etc/shipit/**", "/root/.claude/**", "/credentials/**"];
  const MUTATION_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

  describe("denies writes to sensitive trees", () => {
    for (const tree of SENSITIVE_TREES) {
      for (const tool of MUTATION_TOOLS) {
        it(`denies ${tool}(${tree})`, () => {
          const deny = loadSettings().permissions?.deny ?? [];
          expect(deny).toContain(`${tool}(${tree})`);
        });
      }
    }
  });

  it("deny overrides allow for sensitive trees (no allow rule re-opens them)", () => {
    // A regression guard: an over-broad allow like `Edit(/etc/shipit/**)` would
    // not actually grant access (deny wins in Claude Code), but it would signal
    // confused intent. Assert no allow rule names a sensitive tree explicitly.
    const allow = loadSettings().permissions?.allow ?? [];
    for (const rule of allow) {
      for (const tree of SENSITIVE_TREES) {
        expect(rule).not.toContain(tree);
      }
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
