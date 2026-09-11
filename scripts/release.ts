#!/usr/bin/env tsx
/** Bump package versions and create the matching release commit and tag. */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const pkgPath = resolve(repoRoot, "package.json");

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

function core(version: string): [number, number, number] {
  const [maj, min, patch] = version.split("+")[0].split("-")[0].split(".").map(Number);
  return [maj, min, patch];
}

function isDowngrade(current: string, next: string): boolean {
  const [a, b, c] = core(current);
  const [x, y, z] = core(next);
  if (x !== a) return x < a;
  if (y !== b) return y < b;
  if (z !== c) return z < c;
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

const dirty = git(["status", "--porcelain"], { capture: true }).trim();
if (dirty) {
  fail("working tree is not clean — commit or stash changes before bumping.");
}

try {
  execFileSync("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  fail(`tag ${tag} already exists.`);
} catch {
}

const prerelease = version.includes("-");

console.log(`Bumping ${current} → ${version}${prerelease ? " (prerelease)" : ""}`);

execFileSync("npm", ["version", version, "--no-git-tag-version", "--allow-same-version"], {
  cwd: repoRoot,
  stdio: "inherit",
});

git(["add", "package.json", "package-lock.json"]);
git(["commit", "-m", `Release ${tag}`]);
git(["tag", "-a", tag, "-m", tag]);

console.log(`
Created commit "Release ${tag}" and annotated tag ${tag}.

Next — push the current branch and the tag (the tag push triggers
.github/workflows/release.yml). Cut releases from \`stable\` (see RELEASING.md):

  git push origin HEAD
  git push origin ${tag}
`);

if (prerelease) {
  console.log(
    "This is a prerelease: the workflow publishes it as a GitHub prerelease. CI never moves `stable`.",
  );
}
