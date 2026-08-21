#!/usr/bin/env tsx
/**
 * Dependency age policy enforcement.
 *
 * Policy: every package version listed in a POLICY_MANIFESTS manifest must have
 * been published to the registry at least MIN_AGE_DAYS ago. This is a defense
 * against supply-chain attacks where a compromised maintainer publishes a
 * malicious version — we want a buffer window for the community (and
 * automated scanners) to catch it before we pull it into our build.
 *
 * Also asserts that every version is pinned to an exact version (no `^`,
 * `~`, `*`, ranges, tags, or git URLs).
 *
 * Two manifests are under the policy, not one. `docker/agent-cli/package.json`
 * pins the agent CLIs baked into the session-worker image — code that runs with
 * the agent's own credentials — so it is the manifest a supply-chain attack
 * would most want, yet it was unchecked here for as long as this script existed.
 * Renovate's `minimumReleaseAge` was the only thing holding those bumps, and a
 * cooldown configured per-package is not a gate: when a CLI was absent from the
 * rule's name list it got no cooldown at all, and #2502 duly bumped `opencode-ai`
 * to a version published the same morning, green. A CI check that reads the
 * manifest cannot be opted out of by a package nobody remembered to list.
 *
 * The age rule has one escape hatch, and it is a written one: AGE_EXEMPTIONS
 * waives it for a single `manifest + name + version`, with a reason and a date
 * it stops applying. That exists because the alternative to a recorded waiver
 * is not "no waiver" — it is merging the bump past a red check, which leaves no
 * trace at all of what was skipped or why. The pin rule is never waivable.
 *
 * Run:  npm run check-deps
 *
 * Exits non-zero on any violation so it can be wired into CI.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const MIN_AGE_DAYS = 7;
const MIN_AGE_MS = MIN_AGE_DAYS * 24 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Every manifest the policy covers, repo-relative. Add a manifest here when one
 * is introduced — a pinned dependency that no entry names is unchecked, which
 * is the exact hole this list closes.
 */
export const POLICY_MANIFESTS = ["package.json", "docker/agent-cli/package.json"] as const;

const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * A time-boxed waiver of the age rule for one exact version. It never waives
 * the pin rule, and it matches one `manifest + name + version` triple, so the
 * next bump of the same package is checked normally.
 */
export interface AgeExemption {
  manifest: (typeof POLICY_MANIFESTS)[number];
  name: string;
  /** Exact version. A waiver that could match a future version is not a waiver. */
  version: string;
  /** Why the cooldown was waived, and who signed it off. */
  reason: string;
  /**
   * ISO `YYYY-MM-DD`, exclusive: from this date the entry stops applying. Set
   * it to the day the version turns MIN_AGE_DAYS old, so the waiver lapses
   * exactly when the ordinary rule starts passing on its own and the entry
   * becomes deletable dead weight rather than a lingering hole. An unparseable
   * date waives nothing — the entry fails closed.
   */
  expires: string;
}

/**
 * Live waivers. Delete an entry once it has lapsed; `main` prints the ones that
 * have.
 */
export const AGE_EXEMPTIONS: readonly AgeExemption[] = [
  {
    manifest: "docker/agent-cli/package.json",
    name: "opencode-ai",
    version: "1.18.21",
    reason:
      "Cooldown waived by Nik (explicit request, 2026-08-21) to take the OpenCode " +
      "harness onto 1.18.21 the day it published, three patches ahead of the pinned " +
      "1.18.18. Published 2026-08-21T14:51Z, so it clears MIN_AGE_DAYS on 2026-08-28.",
    expires: "2026-08-28",
  },
];

// `npm view` reaches the registry over the network, so a transient blip
// (DNS hiccup, 5xx, rate-limit) makes a single call fail and would otherwise
// fail the whole build with a spurious `lookup-failed`. Retry a few times with
// a short synchronous backoff before giving up; genuine failures still surface
// after the last attempt, behaving exactly as before.
const VIEW_ATTEMPTS = 4;
const VIEW_BACKOFF_MS = 1500;

export interface Violation {
  manifest: string;
  name: string;
  version: string;
  kind: "not-pinned" | "too-new" | "lookup-failed";
  detail: string;
}

/** A manifest's `dependencies` + `devDependencies`, flattened and labelled. */
export interface ManifestDeps {
  manifest: string;
  deps: Array<[string, string]>;
}

/**
 * Resolves the publish timestamp of `name@version` as an ISO string, or
 * `undefined` when the registry knows the package but not that version.
 * Throws when the lookup itself fails.
 */
export type PublishLookup = (name: string, version: string) => string | undefined;

function sleepSync(ms: number): void {
  // Block synchronously (this script is intentionally sequential/sync).
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function npmViewTime(spec: string): string {
  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= VIEW_ATTEMPTS; attempt++) {
    try {
      return execFileSync("npm", ["view", "--json", spec, "time"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      lastErr = err as Error;
      if (attempt < VIEW_ATTEMPTS) sleepSync(VIEW_BACKOFF_MS * attempt);
    }
  }
  throw lastErr;
}

/** The real registry lookup, retried. Swapped out in tests. */
export const npmPublishLookup: PublishLookup = (name, version) => {
  const times = JSON.parse(npmViewTime(`${name}@${version}`)) as Record<string, string>;
  return times[version];
};

/** Reads one manifest's dependencies. `manifest` is repo-relative. */
export function readManifestDeps(repoRoot: string, manifest: string): ManifestDeps {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, manifest), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return {
    manifest,
    deps: [...Object.entries(pkg.dependencies ?? {}), ...Object.entries(pkg.devDependencies ?? {})],
  };
}

/**
 * True when `entry` waives the age rule for this exact dependency right now.
 * `Date.parse` of a malformed `expires` is NaN and every comparison against NaN
 * is false, so an unparseable date waives nothing rather than waiving forever —
 * the failure mode that matters, since a silently-immortal entry is a permanent
 * hole in the gate.
 */
export function isActiveExemption(
  entry: AgeExemption,
  dep: { manifest: string; name: string; version: string },
  now: number,
): boolean {
  if (entry.manifest !== dep.manifest || entry.name !== dep.name) return false;
  if (entry.version !== dep.version) return false;
  return now < Date.parse(`${entry.expires}T00:00:00.000Z`);
}

/**
 * Applies both rules — exact pin, then minimum age — to every dependency of
 * every manifest. Pure apart from the injected lookup, so the tests drive it
 * without touching the registry.
 */
export function findViolations(
  manifests: ManifestDeps[],
  options: { now: number; lookup: PublishLookup; exemptions?: readonly AgeExemption[] },
): Violation[] {
  const violations: Violation[] = [];
  const exemptions = options.exemptions ?? AGE_EXEMPTIONS;

  for (const { manifest, deps } of manifests) {
    for (const [name, version] of deps) {
      if (!EXACT_SEMVER.test(version)) {
        violations.push({
          manifest,
          name,
          version,
          kind: "not-pinned",
          detail: `version must be an exact semver (no ^, ~, ranges, tags, or URLs)`,
        });
        continue;
      }

      // Checked after the pin rule, which no exemption can waive: an unpinned
      // spec has no single version a waiver could even name.
      if (exemptions.some((e) => isActiveExemption(e, { manifest, name, version }, options.now))) {
        continue;
      }

      let publishedAt: number;
      try {
        const stamp = options.lookup(name, version);
        if (!stamp) {
          violations.push({
            manifest,
            name,
            version,
            kind: "lookup-failed",
            detail: `registry returned no publish time for ${name}@${version}`,
          });
          continue;
        }
        publishedAt = Date.parse(stamp);
      } catch (err) {
        violations.push({
          manifest,
          name,
          version,
          kind: "lookup-failed",
          detail: `npm view failed: ${(err as Error).message.split("\n")[0]}`,
        });
        continue;
      }

      const ageMs = options.now - publishedAt;
      if (ageMs < MIN_AGE_MS) {
        violations.push({
          manifest,
          name,
          version,
          kind: "too-new",
          detail: `published ${(ageMs / MS_PER_DAY).toFixed(1)} days ago (< ${MIN_AGE_DAYS})`,
        });
      }
    }
  }

  return violations;
}

function main(): void {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const manifests = POLICY_MANIFESTS.map((manifest) => readManifestDeps(repoRoot, manifest));
  const total = manifests.reduce((sum, m) => sum + m.deps.length, 0);

  console.log(
    `Checking ${total} dependencies across ${manifests.length} manifests ` +
      `(${POLICY_MANIFESTS.join(", ")}) against policy ` +
      `(pinned + published ≥ ${MIN_AGE_DAYS} days ago)…`,
  );

  const now = Date.now();

  // Say what was waived, every run. A waiver nobody reads is the silent bypass
  // it was written to replace.
  for (const e of AGE_EXEMPTIONS) {
    // An entry trivially matches itself, so this reports exactly the
    // active/lapsed split `findViolations` acts on — one definition, not two.
    const active = isActiveExemption(e, { ...e }, now);
    const label = `${e.manifest} → ${e.name}@${e.version}`;
    if (active) console.log(`  [age waived until ${e.expires}] ${label} — ${e.reason}`);
    else console.log(`  [waiver lapsed ${e.expires}, delete it] ${label}`);
  }

  const violations = findViolations(manifests, { now, lookup: npmPublishLookup });

  if (violations.length === 0) {
    console.log(`All ${total} dependencies pass the policy.`);
    process.exit(0);
  }

  console.error(`\n${violations.length} dependency policy violation(s):\n`);
  for (const v of violations) {
    console.error(`  [${v.kind}] ${v.manifest} → ${v.name}@${v.version} — ${v.detail}`);
  }
  console.error(
    `\nPolicy: dependencies must be pinned to an exact version and published at least ${MIN_AGE_DAYS} days ago.`,
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
