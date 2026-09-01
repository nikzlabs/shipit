import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import os from "node:os";
import {
  ALLOWLIST_PATH,
  MIN_AGE_DAYS,
  POLICY_MANIFESTS,
  applyWaivers,
  evaluatePolicy,
  findViolations,
  loadWaivers,
  parseWaivers,
  readManifestDeps,
  type AgeWaiver,
  type ManifestDeps,
  type PublishLookup,
  type Violation,
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

  it("reads optionalDependencies too — it installs like a dependency", () => {
    const dir = mkdtempSync(join(os.tmpdir(), "check-deps-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ optionalDependencies: { fsevents: "2.3.3" } }),
      );
      expect(readManifestDeps(dir, "package.json").deps).toEqual([["fsevents", "2.3.3"]]);
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

  it("does not fail open on an unparseable publish timestamp", () => {
    // `Date.parse` gives NaN and `NaN < MIN_AGE_MS` is false, so a malformed or
    // hostile registry response would otherwise read as "old enough".
    const violations = findViolations([manifest("package.json", { demo: "1.0.0" })], {
      now: NOW,
      lookup: () => "not-a-date",
    });
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("lookup-failed");
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

/**
 * The age waiver — `.dependency-age-allowlist.json`. It is an escape hatch on a
 * supply-chain control, so what it must NOT waive is as load-bearing as what it
 * does: a different version, a different manifest, an expired entry, and any
 * violation that is not `too-new` all have to survive it.
 */
const TODAY = new Date(NOW).toISOString().slice(0, 10); // "2026-08-21"

function waiver(over: Partial<AgeWaiver> = {}): AgeWaiver {
  return {
    manifest: "docker/agent-cli/package.json",
    package: "@anthropic-ai/claude-code",
    version: "2.1.251",
    reason: "signed off while 4 days old",
    expires: "2026-08-25",
    ...over,
  };
}

function tooNew(over: Partial<Violation> = {}): Violation {
  return {
    manifest: "docker/agent-cli/package.json",
    name: "@anthropic-ai/claude-code",
    version: "2.1.251",
    kind: "too-new",
    detail: `published 4.2 days ago (< ${MIN_AGE_DAYS})`,
    ...over,
  };
}

describe("applyWaivers", () => {
  it("suppresses the exact manifest+package+version it names", () => {
    const result = applyWaivers([tooNew()], [waiver()], NOW);
    expect(result.violations).toEqual([]);
    expect(result.suppressed).toHaveLength(1);
    expect(result.suppressed[0].waiver.reason).toBe("signed off while 4 days old");
    expect(result.stale).toEqual([]);
  });

  it("does not carry forward to the next bump — a waiver is per-version", () => {
    const result = applyWaivers([tooNew({ version: "2.1.257" })], [waiver()], NOW);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].version).toBe("2.1.257");
    // The 2.1.251 entry now matches nothing, so it is reported as dead weight.
    expect(result.stale).toHaveLength(1);
  });

  it("does not leak across manifests", () => {
    const result = applyWaivers([tooNew({ manifest: "package.json" })], [waiver()], NOW);
    expect(result.violations).toHaveLength(1);
    expect(result.suppressed).toEqual([]);
  });

  it("does not leak across packages sharing a manifest and version", () => {
    // The near-miss the version and manifest cases do not cover: same manifest,
    // same version string, different package.
    const result = applyWaivers([tooNew({ name: "opencode-ai" })], [waiver()], NOW);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].name).toBe("opencode-ai");
    expect(result.suppressed).toEqual([]);
  });

  it("stops suppressing once expired, and says so", () => {
    const result = applyWaivers([tooNew()], [waiver({ expires: "2026-08-20" })], NOW);
    expect(result.violations).toHaveLength(1);
    expect(result.expired).toHaveLength(1);
    expect(result.expired[0].waiver.expires).toBe("2026-08-20");
    expect(result.suppressed).toEqual([]);
  });

  it("holds the expiry boundary: expiring today still suppresses", () => {
    const result = applyWaivers([tooNew()], [waiver({ expires: TODAY })], NOW);
    expect(result.suppressed).toHaveLength(1);
    expect(result.violations).toEqual([]);
  });

  it("cannot waive a floating range — not-pinned is not a cooldown question", () => {
    const notPinned = tooNew({ kind: "not-pinned", detail: "must be exact" });
    const result = applyWaivers([notPinned], [waiver()], NOW);
    expect(result.violations).toEqual([notPinned]);
    expect(result.suppressed).toEqual([]);
  });

  it("cannot waive a failed lookup", () => {
    const failed = tooNew({ kind: "lookup-failed", detail: "npm view failed" });
    const result = applyWaivers([failed], [waiver()], NOW);
    expect(result.violations).toEqual([failed]);
  });

  it("reports a waiver that no longer violates as stale, without failing", () => {
    const result = applyWaivers([], [waiver()], NOW);
    expect(result.violations).toEqual([]);
    expect(result.stale).toHaveLength(1);
  });
});

describe("parseWaivers", () => {
  it("accepts a well-formed entry", () => {
    expect(parseWaivers(JSON.stringify([waiver()]))).toEqual([waiver()]);
  });

  it("accepts an empty allowlist", () => {
    expect(parseWaivers("[]")).toEqual([]);
  });

  it.each(["never", "9999", "2026-8-25", "2026-02-31", "2026-08-25T00:00:00Z"])(
    "rejects %j as an expiry — it would read as unexpired forever",
    (expires) => {
      expect(() => parseWaivers(JSON.stringify([waiver({ expires })]))).toThrow(/expires/);
    },
  );

  it("rejects an entry with no reason — a waiver without one is not a decision", () => {
    expect(() => parseWaivers(JSON.stringify([waiver({ reason: "  " })]))).toThrow(/reason/);
  });

  it("rejects a manifest the policy does not cover", () => {
    expect(() => parseWaivers(JSON.stringify([waiver({ manifest: "other/package.json" })]))).toThrow(
      /manifest/,
    );
  });

  it("rejects a range where an exact version belongs", () => {
    expect(() => parseWaivers(JSON.stringify([waiver({ version: "^2.1.251" })]))).toThrow(/version/);
  });

  it("rejects a non-array and unparseable JSON rather than failing open", () => {
    expect(() => parseWaivers(JSON.stringify({ package: "x" }))).toThrow(/JSON array/);
    expect(() => parseWaivers("{oops")).toThrow(/not valid JSON/);
  });

  it("rejects a duplicate key — the diff would not mean what JSON.parse reads", () => {
    // Valid JSON. `JSON.parse` keeps the LAST "package", so a reviewer reading
    // the diff approves opencode-ai and the file waives claude-code.
    const raw = `[{
      "manifest": "docker/agent-cli/package.json",
      "package": "opencode-ai",
      "package": "@anthropic-ai/claude-code",
      "version": "2.1.251",
      "reason": "approved only opencode-ai",
      "expires": "2026-08-25"
    }]`;
    expect(JSON.parse(raw)[0].package).toBe("@anthropic-ai/claude-code"); // the trap is real
    expect(() => parseWaivers(raw, NOW)).toThrow(/duplicate "package" key/);
  });

  it("allows the same key in sibling objects — only same-object duplicates are the bug", () => {
    const raw = JSON.stringify([waiver(), waiver({ version: "2.1.252" })]);
    expect(parseWaivers(raw, NOW)).toHaveLength(2);
  });

  it("does not mistake a string VALUE containing a colon or brace for a key", () => {
    const raw = JSON.stringify([waiver({ reason: 'sign-off: {"package": "x"} — see PR' })]);
    expect(parseWaivers(raw, NOW)).toHaveLength(1);
  });

  it("caps the expiry horizon — a canonical far-future date is not a waiver", () => {
    expect(() => parseWaivers(JSON.stringify([waiver({ expires: "9999-12-31" })]), NOW)).toThrow(
      /beyond the 90-day limit/,
    );
  });

  it("accepts an expiry inside the horizon", () => {
    const inside = new Date(NOW + 89 * DAY_MS).toISOString().slice(0, 10);
    expect(parseWaivers(JSON.stringify([waiver({ expires: inside })]), NOW)).toHaveLength(1);
  });
});

describe("loadWaivers", () => {
  it("treats a missing allowlist as no waivers", () => {
    const dir = mkdtempSync(join(os.tmpdir(), "check-deps-"));
    try {
      expect(loadWaivers(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses the repo's own allowlist, whatever is in it today", () => {
    // Guards a hand-edit: a malformed entry fails here rather than at the point
    // where it would have silently waived nothing.
    expect(() => loadWaivers(REPO_ROOT)).not.toThrow();
    for (const entry of loadWaivers(REPO_ROOT)) {
      expect(POLICY_MANIFESTS).toContain(entry.manifest);
    }
  });

  it("surfaces a malformed allowlist as a throw", () => {
    const dir = mkdtempSync(join(os.tmpdir(), "check-deps-"));
    try {
      writeFileSync(join(dir, ALLOWLIST_PATH), JSON.stringify([waiver({ expires: "never" })]));
      expect(() => loadWaivers(dir)).toThrow(/expires/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The wiring, not the pieces. Every helper above can be correct and green while
 * `evaluatePolicy` never loads the allowlist or never calls `applyWaivers` —
 * a regression no pure-helper test can fail on, because those call the helpers
 * directly. These drive the composition over a temp repo root instead.
 */
describe("evaluatePolicy", () => {
  function repoWith(pins: Record<string, string>, allowlist?: unknown): string {
    const dir = mkdtempSync(join(os.tmpdir(), "check-deps-"));
    mkdirSync(join(dir, "docker", "agent-cli"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {} }));
    writeFileSync(
      join(dir, "docker", "agent-cli", "package.json"),
      JSON.stringify({ dependencies: pins }),
    );
    if (allowlist !== undefined) {
      writeFileSync(join(dir, ALLOWLIST_PATH), JSON.stringify(allowlist));
    }
    return dir;
  }

  const YOUNG = { "@anthropic-ai/claude-code": "2.1.251" };

  it("fails a young pin when no allowlist file exists", () => {
    const dir = repoWith(YOUNG);
    try {
      const { partition, total } = evaluatePolicy(dir, {
        now: NOW,
        lookup: lookupFrom({ "@anthropic-ai/claude-code@2.1.251": daysAgo(4) }),
      });
      expect(total).toBe(1);
      expect(partition.violations).toHaveLength(1);
      expect(partition.violations[0].kind).toBe("too-new");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads the allowlist off disk and applies it — the end-to-end path", () => {
    const dir = repoWith(YOUNG, [waiver()]);
    try {
      const { partition } = evaluatePolicy(dir, {
        now: NOW,
        lookup: lookupFrom({ "@anthropic-ai/claude-code@2.1.251": daysAgo(4) }),
      });
      expect(partition.violations).toEqual([]);
      expect(partition.suppressed).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still fails when the allowlist waives a different version", () => {
    const dir = repoWith(YOUNG, [waiver({ version: "2.1.999" })]);
    try {
      const { partition } = evaluatePolicy(dir, {
        now: NOW,
        lookup: lookupFrom({ "@anthropic-ai/claude-code@2.1.251": daysAgo(4) }),
      });
      expect(partition.violations).toHaveLength(1);
      expect(partition.stale).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("propagates a malformed allowlist as a throw, so the CLI can exit non-zero", () => {
    const dir = repoWith(YOUNG, [waiver({ reason: "" })]);
    try {
      expect(() =>
        evaluatePolicy(dir, { now: NOW, lookup: lookupFrom({}) }),
      ).toThrow(/reason/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
