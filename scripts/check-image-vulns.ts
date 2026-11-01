#!/usr/bin/env node
// Imports only Node built-ins, so CI runs it with Node's type stripping and no `npm ci`.
import { execFileSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FAIL_SEVERITIES: ReadonlySet<string> = new Set(["Critical", "High"]);

// Longer than the 7-day pin cooldown plus a base image's ~2-week rebuild cycle, so a failure
// always names a fix that a compliant digest bump can already take.
export const STALE_FIX_DAYS = 30;

// npm's own bundled dependencies: no Dockerfile here can move them, only a newer Node image.
export const IGNORED_LOCATION_PREFIXES = ["/usr/local/lib/node_modules/npm/"];

// Grype's severity vocabulary; any other value means its report format changed under us.
const KNOWN_SEVERITIES = new Set(["Critical", "High", "Medium", "Low", "Negligible", "Unknown"]);

const SCAN_PLATFORM = "linux/amd64";
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DIGEST_REF = String.raw`\S+@sha256:[0-9a-f]{64}`;
const FROM_LINE = new RegExp(String.raw`^\s*FROM\s+(?:--platform=\S+\s+)?(${DIGEST_REF})(?:\s|$)`, "i");
const COPY_FROM_LINE = new RegExp(String.raw`^\s*COPY\s.*--from=(${DIGEST_REF})(?:\s|$)`, "i");

export interface PinnedImage {
  ref: string;
  files: string[];
}

interface GrypeMatch {
  vulnerability: {
    id: string;
    severity: string;
    fix: {
      state: string;
      versions?: string[];
      available?: Array<{ version?: string; date?: string; kind?: string }>;
    };
  };
  artifact: {
    name: string;
    version: string;
    type: string;
    locations?: Array<{ path: string }>;
  };
}

export interface GrypeReport {
  matches: GrypeMatch[];
}

export interface Finding {
  image: string;
  id: string;
  severity: string;
  pkg: string;
  version: string;
  fixVersions: string[];
  fixedSince: string | undefined;
  ageDays: number | undefined;
  stale: boolean;
}

/** Every digest-pinned image the Dockerfiles build FROM or COPY from, with the files that use it. */
export function pinnedImages(dockerfiles: Array<{ path: string; text: string }>): PinnedImage[] {
  const byRef = new Map<string, Set<string>>();
  for (const { path, text } of dockerfiles) {
    for (const line of text.replace(/\\\r?\n/g, " ").split("\n")) {
      const ref = FROM_LINE.exec(line)?.[1] ?? COPY_FROM_LINE.exec(line)?.[1];
      if (!ref) continue;
      const files = byRef.get(ref) ?? new Set<string>();
      files.add(path);
      byRef.set(ref, files);
    }
  }
  return [...byRef]
    .map(([ref, files]) => ({ ref, files: [...files].sort() }))
    .sort((a, b) => a.ref.localeCompare(b.ref));
}

function fixAgeDays(date: string, now: number): number | undefined {
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00Z` : date);
  return Number.isNaN(parsed) ? undefined : Math.floor((now - parsed) / MS_PER_DAY);
}

/** The fixable HIGH/CRITICAL findings in one image's report, each marked stale or recent. */
export function evaluateReport(image: string, report: GrypeReport, now: number): Finding[] {
  const findings: Finding[] = [];
  for (const { vulnerability: vuln, artifact } of report.matches) {
    if (!KNOWN_SEVERITIES.has(vuln.severity)) {
      throw new Error(`${image}: unknown Grype severity "${vuln.severity}" on ${vuln.id}`);
    }
    if (!FAIL_SEVERITIES.has(vuln.severity) || vuln.fix.state !== "fixed") continue;
    const paths = (artifact.locations ?? []).map((l) => l.path);
    if (paths.length > 0 && paths.every((p) => IGNORED_LOCATION_PREFIXES.some((prefix) => p.startsWith(prefix)))) {
      continue;
    }
    const fixVersions = vuln.fix.versions ?? [];
    const dated: Array<{ version: string | undefined; date: string; age: number }> = [];
    for (const entry of vuln.fix.available ?? []) {
      const age = entry.date === undefined ? undefined : fixAgeDays(entry.date, now);
      if (entry.date !== undefined && age !== undefined) dated.push({ version: entry.version, date: entry.date, age });
    }
    dated.sort((a, b) => b.age - a.age);
    // Grype leaves undated versions out of `available`; one of them cannot be shown to be recent,
    // so it fails rather than hide a stale pin.
    const undated = dated.length === 0 || fixVersions.some((v) => !dated.some((d) => d.version === v));
    const oldest = undated ? undefined : dated[0];
    findings.push({
      image,
      id: vuln.id,
      severity: vuln.severity,
      pkg: artifact.name,
      version: artifact.version,
      fixVersions,
      fixedSince: oldest?.date,
      ageDays: oldest?.age,
      stale: oldest === undefined || oldest.age >= STALE_FIX_DAYS,
    });
  }
  return findings;
}

function findingRows(findings: Finding[]): string[] {
  return findings.map(
    (f) =>
      `| \`${f.image}\` | ${f.pkg} ${f.version} | ${f.id} | ${f.severity} | ${f.fixVersions.join(", ") || "?"} | ${
        f.fixedSince ? `${f.fixedSince} (${f.ageDays} d)` : "unknown"
      } |`,
  );
}

/** The job summary: which images were scanned, and every finding split by whether it fails. */
export function renderSummary(images: PinnedImage[], findings: Finding[]): string {
  const stale = findings.filter((f) => f.stale);
  const recent = findings.filter((f) => !f.stale);
  const header = "| Image | Package | Vulnerability | Severity | Fixed in | Fix available since |\n|---|---|---|---|---|---|";
  const lines = [
    "## Image vulnerability scan",
    "",
    `Fails on a HIGH or CRITICAL vulnerability whose fix has been available for ${STALE_FIX_DAYS}+ days. ` +
      "Bump the image's digest pin to take the fix.",
    "",
    "| Image | Used in | Fails | Recent |",
    "|---|---|---|---|",
    ...images.map((img) => {
      const mine = findings.filter((f) => f.image === img.ref);
      const fails = mine.filter((f) => f.stale).length;
      return `| \`${img.ref}\` | ${img.files.join(", ")} | ${fails} | ${mine.length - fails} |`;
    }),
  ];
  if (stale.length > 0) lines.push("", `### Fails: fix available ${STALE_FIX_DAYS}+ days (${stale.length})`, "", header, ...findingRows(stale));
  if (recent.length > 0) lines.push("", `### Recent fixes, not failing yet (${recent.length})`, "", header, ...findingRows(recent));
  return lines.join("\n") + "\n";
}

export function grypeScanArgs(ref: string): string[] {
  return [`registry:${ref}`, "--platform", SCAN_PLATFORM, "--only-fixed", "-o", "json"];
}

export interface ScanDeps {
  dockerfiles: Array<{ path: string; text: string }>;
  updateDb: () => void;
  scanImage: (ref: string) => GrypeReport;
  now: number;
  writeSummary: (markdown: string) => void;
  log: (line: string) => void;
}

/** Scans every pinned image and returns the process exit code: 1 when any finding is stale. */
export function runScan(deps: ScanDeps): number {
  const images = pinnedImages(deps.dockerfiles);
  if (images.length === 0) throw new Error("no digest-pinned images found under docker/");
  deps.updateDb();
  const findings = images.flatMap((img) => evaluateReport(img.ref, deps.scanImage(img.ref), deps.now));
  deps.writeSummary(renderSummary(images, findings));
  const stale = findings.filter((f) => f.stale);
  for (const img of images) {
    const count = stale.filter((f) => f.image === img.ref).length;
    if (count > 0) {
      deps.log(
        `::error title=Stale image pin::${img.ref} (${img.files.join(", ")}) has ${count} HIGH/CRITICAL ` +
          `finding(s) whose fix is ${STALE_FIX_DAYS}+ days old. Bump its digest.`,
      );
    }
  }
  return stale.length > 0 ? 1 : 0;
}

function grype(args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync("grype", args, {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, GRYPE_CHECK_FOR_APP_UPDATE: "false", ...env },
  });
}

function main(): void {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const dockerfiles = readdirSync(join(repoRoot, "docker"))
    .filter((name) => name.startsWith("Dockerfile."))
    .map((name) => ({ path: `docker/${name}`, text: readFileSync(join(repoRoot, "docker", name), "utf8") }));
  process.exitCode = runScan({
    dockerfiles,
    // One explicit update fails the job on a network error; a scan's own update would warn and
    // carry on with whatever database is cached.
    updateDb: () => grype(["db", "update"]),
    scanImage: (ref) => {
      console.error(`Scanning ${ref}`);
      return JSON.parse(grype(grypeScanArgs(ref), { GRYPE_DB_AUTO_UPDATE: "false" })) as GrypeReport;
    },
    now: Date.now(),
    writeSummary: (markdown) => {
      process.stdout.write(markdown);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
    },
    log: (line) => console.log(line),
  });
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
