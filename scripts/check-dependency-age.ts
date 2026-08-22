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
 * Applies both rules — exact pin, then minimum age — to every dependency of
 * every manifest. Pure apart from the injected lookup, so the tests drive it
 * without touching the registry.
 */
export function findViolations(
  manifests: ManifestDeps[],
  options: { now: number; lookup: PublishLookup },
): Violation[] {
  const violations: Violation[] = [];

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

  const violations = findViolations(manifests, { now: Date.now(), lookup: npmPublishLookup });

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
