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
 * The escape hatch is `.dependency-age-allowlist.json`, not a lowered
 * MIN_AGE_DAYS — same shape as `.audit-allowlist.json`: a reason and an expiry,
 * because an entry without either is not a decision. A waiver names one exact
 * `manifest` + `package` + `version`, so it dies the moment the pin moves and
 * can never carry forward into a bump nobody weighed. It suppresses `too-new`
 * ONLY; `not-pinned` and `lookup-failed` are not risk-window questions and stay
 * unwaivable.
 *
 * One deliberate difference from the audit allowlist: a waiver whose version
 * has since aged past MIN_AGE_DAYS is reported as stale and safe to delete
 * rather than failing the build. The subject of an age waiver ages out on its
 * own, so the entry becomes harmless without anyone acting, and failing CI over
 * dead weight would be churn. `expires` still bites where it matters — past it,
 * a waiver stops suppressing, and the underlying `too-new` violation fails
 * normally.
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
import { existsSync, readFileSync } from "node:fs";
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

/** Repo-relative path of the age-waiver allowlist. Absent file = no waivers. */
export const ALLOWLIST_PATH = ".dependency-age-allowlist.json";

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
 * One signed-off waiver of the minimum-age rule. Every field is matched
 * exactly — a waiver is for one pin at one version in one manifest, never for a
 * package in general, so bumping the pin invalidates it automatically.
 */
export interface AgeWaiver {
  /** Repo-relative manifest, e.g. "docker/agent-cli/package.json". */
  manifest: string;
  /** Package name, e.g. "@anthropic-ai/claude-code". */
  package: string;
  /** The exact version waived. A different version is not covered. */
  version: string;
  /** Why the cooldown is being skipped. Required: without one it is not a decision. */
  reason: string;
  /** ISO date (YYYY-MM-DD). Past this the waiver stops suppressing anything. */
  expires: string;
}

/**
 * True only for a canonical YYYY-MM-DD naming a real day. The lexicographic
 * `expires < today` comparison is sound only for canonical dates, so
 * "2026-9-04" and "2026-02-31" are rejected here rather than mis-compared —
 * and so are the false-PASS spellings ("never", "9999") that would otherwise
 * read as unexpired forever.
 */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Parses and validates the allowlist. Throws on anything malformed: a waiver
 * this script cannot read is a waiver nobody can audit, and silently ignoring
 * it would fail *open* the next time someone fat-fingers a field name.
 */
export function parseWaivers(raw: string): AgeWaiver[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${ALLOWLIST_PATH} is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${ALLOWLIST_PATH} must contain a JSON array.`);

  const problems: string[] = [];
  parsed.forEach((entry, i) => {
    const e = entry as Partial<AgeWaiver>;
    const label = `entry ${i}${e?.package ? ` (${e.package})` : ""}`;
    if (typeof e?.manifest !== "string" || !POLICY_MANIFESTS.includes(e.manifest as never)) {
      problems.push(`${label} — "manifest" must be one of: ${POLICY_MANIFESTS.join(", ")}`);
    }
    if (typeof e?.package !== "string" || e.package.trim() === "") {
      problems.push(`${label} — "package" must be a non-empty string`);
    }
    if (typeof e?.version !== "string" || !EXACT_SEMVER.test(e.version)) {
      problems.push(`${label} — "version" must be an exact semver`);
    }
    if (typeof e?.reason !== "string" || e.reason.trim() === "") {
      problems.push(`${label} — "reason" must be a non-empty string`);
    }
    if (typeof e?.expires !== "string" || !isCalendarDate(e.expires)) {
      problems.push(`${label} — "expires" must be a real calendar date, YYYY-MM-DD`);
    }
  });
  if (problems.length > 0) {
    throw new Error(
      `${problems.length} invalid ${ALLOWLIST_PATH} entr(ies):\n  ${problems.join("\n  ")}`,
    );
  }
  return parsed as AgeWaiver[];
}

/** Reads the allowlist from disk. A missing file means no waivers, not an error. */
export function loadWaivers(repoRoot: string): AgeWaiver[] {
  const path = resolve(repoRoot, ALLOWLIST_PATH);
  if (!existsSync(path)) return [];
  return parseWaivers(readFileSync(path, "utf8"));
}

/** The outcome of applying waivers to a raw violation list. */
export interface WaiverPartition {
  /** Violations that still fail the build. */
  violations: Violation[];
  /** Violations a live waiver suppressed, with the waiver that did it. */
  suppressed: Array<{ violation: Violation; waiver: AgeWaiver }>;
  /**
   * Waivers that matched a violation but have expired. The violation is in
   * `violations` and fails; this is the explanation of why it was not waived.
   */
  expired: Array<{ violation: Violation; waiver: AgeWaiver }>;
  /** Waivers matching no current violation — dead weight, reported not fatal. */
  stale: AgeWaiver[];
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

/**
 * Splits violations into what still fails and what a waiver excuses. Only
 * `too-new` is waivable: a floating range or an unresolvable version is a
 * broken pin rather than a cooldown someone chose to skip, so no allowlist
 * entry can suppress those however it is written.
 */
export function applyWaivers(
  violations: Violation[],
  waivers: AgeWaiver[],
  now: number,
): WaiverPartition {
  const today = new Date(now).toISOString().slice(0, 10);
  const matched = new Set<AgeWaiver>();
  const partition: WaiverPartition = { violations: [], suppressed: [], expired: [], stale: [] };

  for (const violation of violations) {
    const waiver =
      violation.kind === "too-new"
        ? waivers.find(
            (w) =>
              w.manifest === violation.manifest &&
              w.package === violation.name &&
              w.version === violation.version,
          )
        : undefined;

    if (!waiver) {
      partition.violations.push(violation);
      continue;
    }
    matched.add(waiver);
    if (waiver.expires < today) {
      partition.violations.push(violation);
      partition.expired.push({ violation, waiver });
    } else {
      partition.suppressed.push({ violation, waiver });
    }
  }

  partition.stale = waivers.filter((w) => !matched.has(w));
  return partition;
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

  let waivers: AgeWaiver[];
  try {
    waivers = loadWaivers(repoRoot);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }

  const now = Date.now();
  const raw = findViolations(manifests, { now, lookup: npmPublishLookup });
  const { violations, suppressed, expired, stale } = applyWaivers(raw, waivers, now);

  for (const { violation: v, waiver: w } of suppressed) {
    console.warn(
      `  [waived]  ${v.manifest} → ${v.name}@${v.version} — ${v.detail}; ` +
        `${w.reason} (expires ${w.expires})`,
    );
  }
  for (const w of stale) {
    console.warn(
      `  [stale]   ${w.manifest} → ${w.package}@${w.version} is waived but no longer ` +
        `violating — safe to delete from ${ALLOWLIST_PATH}`,
    );
  }
  for (const { waiver: w } of expired) {
    console.error(
      `  [expired] ${w.manifest} → ${w.package}@${w.version} — waiver expired ${w.expires}; ` +
        `it no longer suppresses anything`,
    );
  }

  if (violations.length === 0) {
    const note = suppressed.length > 0 ? ` (${suppressed.length} waived)` : "";
    console.log(`All ${total} dependencies pass the policy${note}.`);
    process.exit(0);
  }

  console.error(`\n${violations.length} dependency policy violation(s):\n`);
  for (const v of violations) {
    console.error(`  [${v.kind}] ${v.manifest} → ${v.name}@${v.version} — ${v.detail}`);
  }
  console.error(
    `\nPolicy: dependencies must be pinned to an exact version and published at least ${MIN_AGE_DAYS} days ago.` +
      `\n  A too-new bump that genuinely cannot wait needs a signed-off entry in ${ALLOWLIST_PATH}` +
      `\n  (manifest + package + version + reason + expires), not a lowered threshold.`,
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
