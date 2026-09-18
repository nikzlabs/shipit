#!/usr/bin/env tsx
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

type Severity = "info" | "low" | "moderate" | "high" | "critical";

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
  advisory: string;
  /** Display only; matching uses advisory. */
  package?: string;
  reason: string;
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
    // With --audit-level=none, a nonzero exit means the audit itself failed.
    const e = err as { message?: string };
    console.error(`npm audit failed to run: ${e.message ?? "unknown error"}`);
    console.error(
      "  Refusing to pass on an audit that did not run — this is not a clean tree.",
    );
    process.exit(2);
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
  const problems: string[] = [];
  for (const e of entries) {
    const label = JSON.stringify(e);
    if (!e || typeof e !== "object") {
      problems.push(`${label} — must be an object`);
      continue;
    }
    if (typeof e.advisory !== "string" || !GHSA_ID.test(e.advisory)) {
      problems.push(`${label} — "advisory" must be a GHSA id (GHSA-xxxx-xxxx-xxxx)`);
    }
    if (typeof e.reason !== "string" || e.reason.trim() === "") {
      problems.push(`${label} — "reason" must be a non-empty string`);
    }
    if (typeof e.expires !== "string" || !isCalendarDate(e.expires)) {
      problems.push(`${label} — "expires" must be a real calendar date, YYYY-MM-DD`);
    }
  }
  if (problems.length > 0) {
    console.error(
      `\n${problems.length} invalid .audit-allowlist.json entr(ies):\n`,
    );
    for (const p of problems) console.error(`  ${p}`);
    process.exit(2);
  }
  return entries;
}

const GHSA_ID = /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/i;

// Lexicographic expiry checks require real, canonical YYYY-MM-DD dates.
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function ghsaId(advisory: AuditAdvisory): string {
  const match = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i.exec(
    advisory.url ?? "",
  );
  return match ? match[0] : `source-${advisory.source}`;
}

const vulnerabilities = runAudit();
const allowlist = loadAllowlist();
const today = new Date().toISOString().slice(0, 10);

const advisories = new Map<string, AuditAdvisory & { id: string }>();
for (const vuln of Object.values(vulnerabilities)) {
  for (const via of vuln.via) {
    if (typeof via === "string") continue;
    const id = ghsaId(via);
    if (!advisories.has(id)) advisories.set(id, { ...via, id });
  }
}

const failThreshold = SEVERITY_RANK[FAIL_LEVEL];

if (Object.keys(vulnerabilities).length > 0 && advisories.size === 0) {
  console.error(
    `npm audit reported ${Object.keys(vulnerabilities).length} vulnerable package(s) but no advisory records could be read.`,
  );
  console.error(
    "  The report schema is not what this script expects — refusing to report a pass.",
  );
  process.exit(2);
}

const relevant = [...advisories.values()].filter(
  (a) => (SEVERITY_RANK[a.severity] ?? Number.MAX_SAFE_INTEGER) >= failThreshold,
);

const allowedById = new Map(allowlist.map((e) => [e.advisory, e]));
const blocking: Array<AuditAdvisory & { id: string }> = [];
const suppressed: Array<{ advisory: AuditAdvisory & { id: string }; entry: AllowlistEntry }> = [];

const expired = allowlist.filter((e) => e.expires < today);

for (const advisory of relevant) {
  const entry = allowedById.get(advisory.id);
  if (!entry) {
    blocking.push(advisory);
    continue;
  }
  if (entry.expires < today) continue;
  suppressed.push({ advisory, entry });
}

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
