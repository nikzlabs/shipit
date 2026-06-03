#!/usr/bin/env tsx
/**
 * Release version bump.
 *
 * Bumps package.json (and the lockfile) to the requested version, then creates
 * the `Release vX.Y.Z` commit and the annotated `vX.Y.Z` tag in lockstep. It
 * deliberately does NOT push: pushing the tag is what triggers
 * `.github/workflows/release.yml`, so that stays a separate, deliberate human
 * act (see RELEASING.md).
 *
 * Keeping the tag and package.json version in lockstep here is what makes the
 * release workflow's `version-guard` job pass — that job re-checks the two
 * match and fails the release if a tag is ever pushed without a matching bump.
 *
 * Usage:
 *   npm run release -- 0.2.0          # normal release
 *   npm run release -- v0.2.0         # leading "v" is tolerated
 *   npm run release -- 0.2.0-rc.1     # prerelease (published as a GitHub prerelease)
 *
 * Android versions (versionCode / versionName in android/app/build.gradle.kts)
 * are intentionally NOT touched here yet — that sync is tracked in SHI-66.
 *
 * Exits non-zero on any precondition failure so a botched bump never half-applies.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const pkgPath = resolve(repoRoot, "package.json");

// Matches a semver core with optional prerelease/build metadata — same shape
// the dependency-age check accepts for pinned versions.
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function fail(message: string): never {
  console.error(`release: ${message}`);
  process.exit(1);
}

function git(args: string[], opts: { capture?: boolean } = {}): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: opts.capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
}

/** [major, minor, patch] of a version's core, ignoring prerelease/build. */
function core(version: string): [number, number, number] {
  const [maj, min, patch] = version.split("+")[0].split("-")[0].split(".").map(Number);
  return [maj, min, patch];
}

/** True if `next` is strictly older than `current` (a downgrade we refuse). */
function isDowngrade(current: string, next: string): boolean {
  const [a, b, c] = core(current);
  const [x, y, z] = core(next);
  if (x !== a) return x < a;
  if (y !== b) return y < b;
  if (z !== c) return z < c;
  // Same core: a prerelease (e.g. 0.2.0-rc.1) is older than the final (0.2.0).
  const curPre = current.includes("-");
  const nextPre = next.includes("-");
  return !curPre && nextPre;
}

const rawArg = process.argv[2];
if (!rawArg) {
  fail("usage: npm run release -- <version>   (e.g. 0.2.0 or 0.2.0-rc.1)");
}

const version = rawArg.replace(/^v/, "");
if (!SEMVER.test(version)) {
  fail(`"${rawArg}" is not a valid semver version (expected X.Y.Z[-prerelease]).`);
}

const tag = `v${version}`;

const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
const current = pkg.version;

if (version === current) {
  fail(`package.json is already at ${current}.`);
}
if (isDowngrade(current, version)) {
  fail(`${version} is older than the current ${current} — refusing to downgrade.`);
}

// Working tree must be clean so the release commit contains only the bump.
const dirty = git(["status", "--porcelain"], { capture: true }).trim();
if (dirty) {
  fail("working tree is not clean — commit or stash changes before bumping.");
}

// Tag must not already exist.
try {
  execFileSync("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  fail(`tag ${tag} already exists.`);
} catch {
  // Expected: rev-parse exits non-zero when the tag is absent.
}

const prerelease = version.includes("-");

console.log(`Bumping ${current} → ${version}${prerelease ? " (prerelease)" : ""}`);

// `npm version --no-git-tag-version` rewrites package.json AND package-lock.json
// without doing any git work, so we own the commit/tag below.
execFileSync("npm", ["version", version, "--no-git-tag-version", "--allow-same-version"], {
  cwd: repoRoot,
  stdio: "inherit",
});

git(["add", "package.json", "package-lock.json"]);
git(["commit", "-m", `Release ${tag}`]);
git(["tag", "-a", tag, "-m", tag]);

console.log(`
Created commit "Release ${tag}" and annotated tag ${tag}.

Next — push both (the tag push triggers .github/workflows/release.yml):

  git push origin HEAD
  git push origin ${tag}
`);

if (prerelease) {
  console.log(
    "This is a prerelease: the workflow publishes it as a GitHub prerelease and does NOT fast-forward `stable`.",
  );
}
