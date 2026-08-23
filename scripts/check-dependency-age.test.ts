import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import os from "node:os";
import {
  MIN_AGE_DAYS,
  POLICY_MANIFESTS,
  findViolations,
  readManifestDeps,
  type ManifestDeps,
  type PublishLookup,
} from "./check-dependency-age.js";

/**
 * Regression coverage for the dependency-age gate.
 *
 * The defect these guard against: the script read only the root `package.json`,
 * so `docker/agent-cli/package.json` — the agent CLIs baked into the
 * session-worker image — was never age-checked. Renovate's per-package
 * `minimumReleaseAge` was the only cooldown on those bumps, and a package the
 * rule's name list did not mention got no cooldown at all. #2502 bumped
 * `opencode-ai` to a version published that same morning and CI went green.
 *
 * The lookup is injected, so nothing here touches the registry: the rules are
 * what is under test, not npm's reachability.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-08-21T12:00:00.000Z");

/** A lookup over a fixed `name@version` → ISO-stamp table. */
function lookupFrom(table: Record<string, string>): PublishLookup {
  return (name, version) => table[`${name}@${version}`];
}

/** Days before NOW, as the ISO string the registry would return. */
function daysAgo(days: number): string {
  return new Date(NOW - days * DAY_MS).toISOString();
}

function manifest(name: string, deps: Record<string, string>): ManifestDeps {
  return { manifest: name, deps: Object.entries(deps) };
}

describe("POLICY_MANIFESTS", () => {
  it("covers the agent-CLI manifest as well as the root one", () => {
    expect([...POLICY_MANIFESTS]).toEqual(["package.json", "docker/agent-cli/package.json"]);
  });

  it("names manifests that exist in the repo", () => {
    for (const relPath of POLICY_MANIFESTS) {
      expect(existsSync(resolve(REPO_ROOT, relPath)), `${relPath} is missing`).toBe(true);
    }
  });

  it("reads a real manifest's pins", () => {
    const { manifest: name, deps } = readManifestDeps(REPO_ROOT, "docker/agent-cli/package.json");
    expect(name).toBe("docker/agent-cli/package.json");
    expect(deps.length).toBeGreaterThan(0);
    expect(deps.map(([pkg]) => pkg)).toContain("@anthropic-ai/claude-code");
  });
});

describe("readManifestDeps", () => {
  it("flattens dependencies and devDependencies together", () => {
    const dir = mkdtempSync(join(os.tmpdir(), "check-deps-"));
    try {
      mkdirSync(join(dir, "docker", "agent-cli"), { recursive: true });
      writeFileSync(
        join(dir, "docker", "agent-cli", "package.json"),
        JSON.stringify({ dependencies: { a: "1.0.0" }, devDependencies: { b: "2.0.0" } }),
      );
      const read = readManifestDeps(dir, "docker/agent-cli/package.json");
      expect(read.deps).toEqual([
        ["a", "1.0.0"],
        ["b", "2.0.0"],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tolerates a manifest with neither dependency block", () => {
    const dir = mkdtempSync(join(os.tmpdir(), "check-deps-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "empty" }));
      expect(readManifestDeps(dir, "package.json").deps).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("findViolations", () => {
  it("passes a dependency published longer ago than the minimum", () => {
    const violations = findViolations([manifest("package.json", { react: "19.2.4" })], {
      now: NOW,
      lookup: lookupFrom({ "react@19.2.4": daysAgo(30) }),
    });
    expect(violations).toEqual([]);
  });

  it("flags an agent-CLI bump published the same day — the #2502 case", () => {
    const violations = findViolations(
      [manifest("docker/agent-cli/package.json", { "opencode-ai": "1.18.20" })],
      { now: NOW, lookup: lookupFrom({ "opencode-ai@1.18.20": daysAgo(0) }) },
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      manifest: "docker/agent-cli/package.json",
      name: "opencode-ai",
      version: "1.18.20",
      kind: "too-new",
    });
    expect(violations[0].detail).toContain(`< ${MIN_AGE_DAYS}`);
  });

  it("checks every manifest, not just the first", () => {
    const violations = findViolations(
      [
        manifest("package.json", { react: "19.2.4" }),
        manifest("docker/agent-cli/package.json", { "@xai-official/grok": "1.0.5" }),
      ],
      {
        now: NOW,
        lookup: lookupFrom({
          "react@19.2.4": daysAgo(30),
          "@xai-official/grok@1.0.5": daysAgo(5),
        }),
      },
    );
    expect(violations.map((v) => [v.manifest, v.name])).toEqual([
      ["docker/agent-cli/package.json", "@xai-official/grok"],
    ]);
  });

  it("holds the boundary: exactly MIN_AGE_DAYS old passes, a minute younger fails", () => {
    const lookup = lookupFrom({
      "old@1.0.0": new Date(NOW - MIN_AGE_DAYS * DAY_MS).toISOString(),
      "new@1.0.0": new Date(NOW - MIN_AGE_DAYS * DAY_MS + 60_000).toISOString(),
    });
    const deps = manifest("package.json", { old: "1.0.0", new: "1.0.0" });
    expect(findViolations([deps], { now: NOW, lookup }).map((v) => v.name)).toEqual(["new"]);
  });

  it("applies the exact-pin rule to the agent-CLI manifest too", () => {
    const violations = findViolations(
      [
        manifest("docker/agent-cli/package.json", {
          "@openai/codex": "^0.147.0",
          "@playwright/mcp": "latest",
        }),
      ],
      { now: NOW, lookup: lookupFrom({}) },
    );
    expect(violations.map((v) => [v.name, v.kind])).toEqual([
      ["@openai/codex", "not-pinned"],
      ["@playwright/mcp", "not-pinned"],
    ]);
  });

  it("accepts a prerelease pin as exact", () => {
    const violations = findViolations([manifest("package.json", { vite: "8.3.0-beta.1" })], {
      now: NOW,
      lookup: lookupFrom({ "vite@8.3.0-beta.1": daysAgo(14) }),
    });
    expect(violations).toEqual([]);
  });

  it("does not spend a registry lookup on a version that is not pinned", () => {
    const asked: string[] = [];
    findViolations([manifest("package.json", { react: "^19.2.4" })], {
      now: NOW,
      lookup: (name, version) => {
        asked.push(`${name}@${version}`);
        return daysAgo(30);
      },
    });
    expect(asked).toEqual([]);
  });

  it("reports a version the registry has no timestamp for", () => {
    const violations = findViolations([manifest("package.json", { ghost: "9.9.9" })], {
      now: NOW,
      lookup: lookupFrom({}),
    });
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("lookup-failed");
  });

  it("reports a failed lookup instead of throwing, and keeps checking the rest", () => {
    const violations = findViolations(
      [manifest("package.json", { broken: "1.0.0", fine: "1.0.0" })],
      {
        now: NOW,
        lookup: (name) => {
          if (name === "broken") throw new Error("npm view failed: ETIMEDOUT\nstack line");
          return daysAgo(30);
        },
      },
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ name: "broken", kind: "lookup-failed" });
    // Only the first line of the error reaches the report — a stack would bury it.
    expect(violations[0].detail).not.toContain("stack line");
  });
});
