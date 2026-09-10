#!/usr/bin/env tsx
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const MIN_AGE_DAYS = 7;
const MIN_AGE_MS = MIN_AGE_DAYS * 24 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const MAX_WAIVER_DAYS = 90;

export const POLICY_MANIFESTS = ["package.json", "docker/agent-cli/package.json"] as const;

export const ALLOWLIST_PATH = ".dependency-age-allowlist.json";

const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const VIEW_ATTEMPTS = 4;
const VIEW_BACKOFF_MS = 1500;

export interface Violation {
  manifest: string;
  name: string;
  version: string;
  kind: "not-pinned" | "too-new" | "lookup-failed";
  detail: string;
}

export interface ManifestDeps {
  manifest: string;
  deps: Array<[string, string]>;
}

export interface AgeWaiver {
  manifest: string;
  package: string;
  version: string;
  reason: string;
  expires: string;
}

// Lexicographic expiry checks require real, canonical YYYY-MM-DD dates.
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// Inspect raw text: JSON.parse discards duplicate keys and keeps only the last value.
function assertNoDuplicateKeys(raw: string): void {
  const seen: Array<Set<string>> = [];
  let i = 0;
  let pendingKey: string | undefined;

  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"') {
      let text = "";
      i++;
      while (i < raw.length && raw[i] !== '"') {
        if (raw[i] === "\\") {
          // Compare source spellings; escaped equivalents are not normalized.
          text += raw[i] + (raw[i + 1] ?? "");
          i += 2;
          continue;
        }
        text += raw[i];
        i++;
      }
      i++;
      pendingKey = text;
      continue;
    }
    if (ch === "{") {
      seen.push(new Set());
    } else if (ch === "}") {
      seen.pop();
    } else if (ch === ":") {
      const scope = seen[seen.length - 1];
      if (scope && pendingKey !== undefined) {
        if (scope.has(pendingKey)) {
          throw new Error(
            `${ALLOWLIST_PATH} has a duplicate "${pendingKey}" key in the same object. ` +
              `JSON keeps the last one, so the file would not mean what its diff shows.`,
          );
        }
        scope.add(pendingKey);
      }
      pendingKey = undefined;
    }
    i++;
  }
}

export function parseWaivers(raw: string, now: number = Date.now()): AgeWaiver[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${ALLOWLIST_PATH} is not valid JSON: ${(err as Error).message}`);
  }
  assertNoDuplicateKeys(raw);
  if (!Array.isArray(parsed)) throw new Error(`${ALLOWLIST_PATH} must contain a JSON array.`);

  const horizon = new Date(now + MAX_WAIVER_DAYS * MS_PER_DAY).toISOString().slice(0, 10);
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
    } else if (e.expires > horizon) {
      problems.push(
        `${label} — "expires" is ${e.expires}, beyond the ${MAX_WAIVER_DAYS}-day ` +
          `limit (${horizon}); a waiver this long is a policy change, not a waiver`,
      );
    }
  });
  if (problems.length > 0) {
    throw new Error(
      `${problems.length} invalid ${ALLOWLIST_PATH} entr(ies):\n  ${problems.join("\n  ")}`,
    );
  }
  return parsed as AgeWaiver[];
}

export function loadWaivers(repoRoot: string, now: number = Date.now()): AgeWaiver[] {
  const path = resolve(repoRoot, ALLOWLIST_PATH);
  if (!existsSync(path)) return [];
  return parseWaivers(readFileSync(path, "utf8"), now);
}

export interface WaiverPartition {
  violations: Violation[];
  suppressed: Array<{ violation: Violation; waiver: AgeWaiver }>;
  expired: Array<{ violation: Violation; waiver: AgeWaiver }>;
  stale: AgeWaiver[];
}

export type PublishLookup = (name: string, version: string) => string | undefined;

function sleepSync(ms: number): void {
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

export const npmPublishLookup: PublishLookup = (name, version) => {
  const times = JSON.parse(npmViewTime(`${name}@${version}`)) as Record<string, string>;
  return times[version];
};

// Transitive overrides are covered by check-audit, not this age gate.
export function readManifestDeps(repoRoot: string, manifest: string): ManifestDeps {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, manifest), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  return {
    manifest,
    deps: [
      ...Object.entries(pkg.dependencies ?? {}),
      ...Object.entries(pkg.devDependencies ?? {}),
      ...Object.entries(pkg.optionalDependencies ?? {}),
    ],
  };
}

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
        if (Number.isNaN(publishedAt)) {
          violations.push({
            manifest,
            name,
            version,
            kind: "lookup-failed",
            detail: `registry returned an unparseable publish time (${JSON.stringify(stamp)})`,
          });
          continue;
        }
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

export function evaluatePolicy(
  repoRoot: string,
  options: { now: number; lookup: PublishLookup },
): { partition: WaiverPartition; total: number } {
  const manifests = POLICY_MANIFESTS.map((manifest) => readManifestDeps(repoRoot, manifest));
  const waivers = loadWaivers(repoRoot, options.now);
  const raw = findViolations(manifests, options);
  return {
    partition: applyWaivers(raw, waivers, options.now),
    total: manifests.reduce((sum, m) => sum + m.deps.length, 0),
  };
}

function main(): void {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const now = Date.now();

  console.log(
    `Checking dependencies across ${POLICY_MANIFESTS.length} manifests ` +
      `(${POLICY_MANIFESTS.join(", ")}) against policy ` +
      `(pinned + published ≥ ${MIN_AGE_DAYS} days ago)…`,
  );

  let total: number;
  let partition: WaiverPartition;
  try {
    ({ partition, total } = evaluatePolicy(repoRoot, { now, lookup: npmPublishLookup }));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }

  const { violations, suppressed, expired, stale } = partition;

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
