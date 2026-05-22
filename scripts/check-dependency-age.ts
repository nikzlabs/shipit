#!/usr/bin/env tsx
/**
 * Dependency age policy enforcement.
 *
 * Policy: every package version listed in package.json must have been
 * published to the registry at least MIN_AGE_DAYS ago. This is a defense
 * against supply-chain attacks where a compromised maintainer publishes a
 * malicious version — we want a buffer window for the community (and
 * automated scanners) to catch it before we pull it into our build.
 *
 * Also asserts that every version is pinned to an exact version (no `^`,
 * `~`, `*`, ranges, tags, or git URLs).
 *
 * Run:  npm run check-deps
 *
 * Exits non-zero on any violation so it can be wired into CI.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const MIN_AGE_DAYS = 7;
const MIN_AGE_MS = MIN_AGE_DAYS * 24 * 60 * 60 * 1000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(__dirname, "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

interface Violation {
  name: string;
  version: string;
  kind: "not-pinned" | "too-new" | "lookup-failed";
  detail: string;
}

const violations: Violation[] = [];
const now = Date.now();

const allDeps: Array<[string, string]> = [
  ...Object.entries(pkg.dependencies ?? {}),
  ...Object.entries(pkg.devDependencies ?? {}),
];

console.log(
  `Checking ${allDeps.length} dependencies against policy (pinned + published ≥ ${MIN_AGE_DAYS} days ago)…`,
);

for (const [name, version] of allDeps) {
  if (!EXACT_SEMVER.test(version)) {
    violations.push({
      name,
      version,
      kind: "not-pinned",
      detail: `version must be an exact semver (no ^, ~, ranges, tags, or URLs)`,
    });
    continue;
  }

  let publishedAt: number | undefined;
  try {
    const raw = execFileSync(
      "npm",
      ["view", "--json", `${name}@${version}`, "time"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const times = JSON.parse(raw) as Record<string, string>;
    const stamp = times[version];
    if (!stamp) {
      violations.push({
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
      name,
      version,
      kind: "lookup-failed",
      detail: `npm view failed: ${(err as Error).message.split("\n")[0]}`,
    });
    continue;
  }

  const ageMs = now - publishedAt;
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  if (ageMs < MIN_AGE_MS) {
    violations.push({
      name,
      version,
      kind: "too-new",
      detail: `published ${ageDays.toFixed(1)} days ago (< ${MIN_AGE_DAYS})`,
    });
  }
}

if (violations.length === 0) {
  console.log(`All ${allDeps.length} dependencies pass the policy.`);
  process.exit(0);
}

console.error(`\n${violations.length} dependency policy violation(s):\n`);
for (const v of violations) {
  console.error(`  [${v.kind}] ${v.name}@${v.version} — ${v.detail}`);
}
console.error(
  `\nPolicy: dependencies must be pinned to an exact version and published at least ${MIN_AGE_DAYS} days ago.`,
);
process.exit(1);
