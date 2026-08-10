#!/usr/bin/env tsx
/**
 * Vulnerability gate.
 *
 * Policy: no advisory at or above FAIL_LEVEL may affect the dependency tree
 * unless it is explicitly allowlisted, with a reason and an expiry date.
 *
 * Why this exists: `package.json` carries an `overrides` block that lifts
 * vulnerable transitive dependencies onto patched versions. Nothing updates
 * that block automatically — Dependabot only manages dependencies /
 * devDependencies, and an override is absolute so `npm audit fix` and
 * `npm update` cannot move it either. In 2026 the block silently went stale for
 * roughly three months: six of its pins had become the exact vulnerable
 * versions being reported, and because CI ran lint/typecheck/check-deps/build/
 * test but never `npm audit`, nothing failed. This is the missing check.
 *
 * The escape hatch is the allowlist, not a lowered threshold. When an advisory
 * has no fix available yet — the case that would otherwise wedge every PR on
 * the repo — add an entry to .audit-allowlist.json saying so and set a date to
 * revisit. An expired entry fails the build on purpose: it is the reminder.
 *
 * Runs against the lockfile (`--package-lock-only`) so the result depends only
 * on committed state, not on what happens to be installed.
 *
 * Run:  npm run check-audit
 *
 * Exits non-zero on any un-allowlisted advisory at or above FAIL_LEVEL, and on
 * any expired allowlist entry.
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

type Severity = "info" | "low" | "moderate" | "high" | "critical";

/** Advisories at or above this rank fail the build. */
const FAIL_LEVEL: Severity = "high";

const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const allowlistPath = resolve(repoRoot, ".audit-allowlist.json");

interface AllowlistEntry {
  /** GHSA identifier, e.g. "GHSA-qwww-vcr4-c8h2". */
  advisory: string;
  /** Package the advisory is against — documentation only, not matched on. */
  package?: string;
  /** Why this is tolerated. Required: an entry without one is not a decision. */
  reason: string;
  /** ISO date (YYYY-MM-DD). Past this, the build fails until it is revisited. */
  expires: string;
}

interface AuditAdvisory {
  source: number;
  name: string;
  title: string;
  url: string;
  severity: Severity;
}

interface AuditVulnerability {
  name: string;
  severity: Severity;
  isDirect: boolean;
  via: Array<AuditAdvisory | string>;
  fixAvailable: boolean | { name: string; version: string };
}

function runAudit(): Record<string, AuditVulnerability> {
  let raw: string;
  try {
    raw = execFileSync(
      "npm",
      ["audit", "--json", "--package-lock-only", "--audit-level=none"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd: repoRoot },
    );
  } catch (err) {
    // `npm audit` exits non-zero precisely when it finds something, so a
    // non-zero exit is the normal path here — the JSON is still on stdout.
    // Only treat it as a failure when there is no parseable payload.
    const e = err as { stdout?: string; message?: string };
    raw = e.stdout ?? "";
    if (!raw.trim()) {
      console.error(`npm audit failed to run: ${e.message ?? "unknown error"}`);
      process.exit(2);
    }
  }

  let parsed: {
    vulnerabilities?: Record<string, AuditVulnerability>;
    message?: string;
    error?: { summary?: string; detail?: string };
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("npm audit returned output that is not JSON:");
    console.error(raw.slice(0, 2000));
    process.exit(2);
  }

  // A failed audit still prints JSON, but it carries `message`/`error` and no
  // `vulnerabilities` key — a registry outage or a proxy 5xx looks like this.
  // Defaulting that to {} would report "0 advisories, policy passes" and exit
  // 0, so a network blip would silently green-light a vulnerable tree. Treat a
  // missing `vulnerabilities` key as a tool failure, never as a clean result.
  if (!parsed || typeof parsed !== "object" || !parsed.vulnerabilities) {
    console.error("npm audit did not return a vulnerability report.");
    const reason = parsed?.message ?? parsed?.error?.summary;
    if (reason) console.error(`  ${reason}`);
    console.error(
      "  Refusing to pass on an audit that did not run — this is not a clean tree.",
    );
    process.exit(2);
  }

  return parsed.vulnerabilities;
}

function loadAllowlist(): AllowlistEntry[] {
  if (!existsSync(allowlistPath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(allowlistPath, "utf8"));
  } catch (err) {
    console.error(
      `.audit-allowlist.json is not valid JSON: ${(err as Error).message}`,
    );
    process.exit(2);
  }
  if (!Array.isArray(parsed)) {
    console.error(".audit-allowlist.json must contain a JSON array.");
    process.exit(2);
  }
  const entries = parsed as AllowlistEntry[];
  const malformed = entries.filter(
    (e) => !e?.advisory || !e?.reason || !e?.expires,
  );
  if (malformed.length > 0) {
    console.error(
      `\n${malformed.length} malformed .audit-allowlist.json entr(ies) — each needs "advisory", "reason", and "expires":\n`,
    );
    for (const e of malformed) console.error(`  ${JSON.stringify(e)}`);
    process.exit(2);
  }
  return entries;
}

/** Pull the GHSA id out of an advisory URL (…/advisories/GHSA-xxxx-…). */
function ghsaId(advisory: AuditAdvisory): string {
  const match = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i.exec(
    advisory.url ?? "",
  );
  return match ? match[0] : `source-${advisory.source}`;
}

const vulnerabilities = runAudit();
const allowlist = loadAllowlist();
const today = new Date().toISOString().slice(0, 10);

// One advisory can surface under several package entries (the vulnerable
// package plus every ancestor that depends on it). Dedupe so the report counts
// distinct advisories, not tree positions.
const advisories = new Map<string, AuditAdvisory & { id: string }>();
for (const vuln of Object.values(vulnerabilities)) {
  for (const via of vuln.via) {
    if (typeof via === "string") continue;
    const id = ghsaId(via);
    if (!advisories.has(id)) advisories.set(id, { ...via, id });
  }
}

const failThreshold = SEVERITY_RANK[FAIL_LEVEL];
const relevant = [...advisories.values()].filter(
  (a) => SEVERITY_RANK[a.severity] >= failThreshold,
);

const allowedById = new Map(allowlist.map((e) => [e.advisory, e]));
const expired: AllowlistEntry[] = [];
const blocking: Array<AuditAdvisory & { id: string }> = [];
const suppressed: Array<{ advisory: AuditAdvisory & { id: string }; entry: AllowlistEntry }> = [];

for (const advisory of relevant) {
  const entry = allowedById.get(advisory.id);
  if (!entry) {
    blocking.push(advisory);
    continue;
  }
  if (entry.expires < today) {
    expired.push(entry);
    continue;
  }
  suppressed.push({ advisory, entry });
}

// An allowlist entry that no longer matches anything is dead weight, but it is
// not a reason to fail an unrelated PR — say so and move on.
const stale = allowlist.filter((e) => !advisories.has(e.advisory));

console.log(
  `Checked ${advisories.size} advisor${advisories.size === 1 ? "y" : "ies"} against policy (fail at ${FAIL_LEVEL} or above)…`,
);

for (const { advisory, entry } of suppressed) {
  console.log(
    `  [allowed] ${advisory.id} ${advisory.name} (${advisory.severity}) — ${entry.reason} (expires ${entry.expires})`,
  );
}
for (const e of stale) {
  console.log(
    `  [stale]   ${e.advisory} is allowlisted but no longer reported — safe to delete from .audit-allowlist.json`,
  );
}

if (blocking.length === 0 && expired.length === 0) {
  console.log(
    `No un-allowlisted advisories at ${FAIL_LEVEL} or above. Policy passes.`,
  );
  process.exit(0);
}

if (blocking.length > 0) {
  console.error(
    `\n${blocking.length} advisor${blocking.length === 1 ? "y" : "ies"} at ${FAIL_LEVEL} or above:\n`,
  );
  for (const a of blocking) {
    const vuln = vulnerabilities[a.name];
    const fix =
      vuln && vuln.fixAvailable
        ? typeof vuln.fixAvailable === "object"
          ? `fix: ${vuln.fixAvailable.name}@${vuln.fixAvailable.version}`
          : "fix available"
        : "no fix available yet";
    console.error(`  [${a.severity}] ${a.name} — ${a.title}`);
    console.error(`      ${a.url} (${fix})`);
  }
}

if (expired.length > 0) {
  console.error(`\n${expired.length} expired allowlist entr(ies):\n`);
  for (const e of expired) {
    console.error(
      `  ${e.advisory} expired ${e.expires} — ${e.reason}`,
    );
  }
}

console.error(
  `
To resolve:
  - If the advisory is against a transitive dependency, raise or add the pin in
    the "overrides" block of package.json, then run \`npm install\`. Nothing
    updates that block for you — not Dependabot, not \`npm audit fix\`.
  - If it is a direct dependency, bump it in package.json and run \`npm install\`.
  - If there is genuinely no fix yet, add an entry to .audit-allowlist.json with
    a reason and an expiry date, and say why in the PR.
  - Pins must satisfy the dependency policy in CLAUDE.md (exact version, at
    least 7 days old).
`,
);
process.exit(1);
