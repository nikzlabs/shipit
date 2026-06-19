/**
 * Release version-source detection + next-version (semver) computation
 * (docs/171). Pure, dependency-free helpers — the project pins exact versions
 * and enforces a dependency age policy, so rather than add `semver` we
 * implement the small slice we need (parse, compare-free bump, format).
 *
 * Detects package.json (Node), Cargo.toml (Rust), pyproject.toml (Python),
 * and VERSION files. Tag-only detection (no version file) is signalled by an
 * empty detectAllVersionSources() result — the caller falls back to git tags.
 */

import fs from "node:fs";
import path from "node:path";
import type { ReleaseBumpType } from "../shared/types/release-types.js";

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers, e.g. ["rc", "2"]. Empty when none. */
  prerelease: string[];
}

/**
 * Parse a semver string. Accepts an optional leading `v`. Ignores build
 * metadata (`+…`). Returns null when the core `major.minor.patch` isn't a
 * clean numeric triple — the caller surfaces "couldn't detect a version"
 * rather than guessing.
 */
export function parseSemVer(input: string): SemVer | null {
  const trimmed = input.trim().replace(/^v/, "");
  // Strip build metadata.
  const noBuild = trimmed.split("+")[0] ?? trimmed;
  const [core, pre] = noBuild.split("-", 2);
  const parts = core.split(".");
  if (parts.length !== 3) return null;
  const [major, minor, patch] = parts.map((p) => Number(p));
  if (![major, minor, patch].every((n) => Number.isInteger(n) && n >= 0)) return null;
  return {
    major,
    minor,
    patch,
    prerelease: pre ? pre.split(".") : [],
  };
}

/** Format a SemVer back to a canonical string (no leading `v`). */
export function formatSemVer(v: SemVer): string {
  const core = `${v.major}.${v.minor}.${v.patch}`;
  return v.prerelease.length > 0 ? `${core}-${v.prerelease.join(".")}` : core;
}

/**
 * Compute the next version string for the requested bump.
 *
 * - `major` / `minor` / `patch` — standard increments; any existing prerelease
 *   tail is dropped (a real release supersedes its rc lane).
 * - `prerelease` — bumps the numeric rc counter when the current version is
 *   already a prerelease (e.g. `0.3.0-rc.1` → `0.3.0-rc.2`); otherwise it
 *   starts an rc lane off the next patch (`0.3.0` → `0.3.1-rc.1`). The richer
 *   `prerelease-pattern` config is Phase 2 — this is the zero-config default.
 *
 * Returns null when `current` isn't parseable.
 */
export function computeNextVersion(current: string, bump: ReleaseBumpType): string | null {
  const v = parseSemVer(current);
  if (!v) return null;
  switch (bump) {
    case "major":
      return formatSemVer({ major: v.major + 1, minor: 0, patch: 0, prerelease: [] });
    case "minor":
      return formatSemVer({ major: v.major, minor: v.minor + 1, patch: 0, prerelease: [] });
    case "patch":
      return formatSemVer({ major: v.major, minor: v.minor, patch: v.patch + 1, prerelease: [] });
    case "prerelease": {
      if (v.prerelease.length > 0) {
        // Bump the last numeric identifier; if none is numeric, append `.1`.
        const tail = [...v.prerelease];
        const lastIdx = tail.length - 1;
        const lastNum = Number(tail[lastIdx]);
        if (Number.isInteger(lastNum)) {
          tail[lastIdx] = String(lastNum + 1);
        } else {
          tail.push("1");
        }
        return formatSemVer({ ...v, prerelease: tail });
      }
      return formatSemVer({ major: v.major, minor: v.minor, patch: v.patch + 1, prerelease: ["rc", "1"] });
    }
  }
}

export type VersionSourceType = "package.json" | "Cargo.toml" | "pyproject.toml" | "VERSION" | "tag";

export interface DetectedVersionSource {
  /** The type of file the version was read from. "tag" = no version file, inferred from git. */
  source: VersionSourceType;
  /** Absolute path to the version-source file. Undefined for the "tag" scheme. */
  path?: string;
  /** The current version read from the source. */
  version: string;
}

// The read-from-disk helpers below split into a `parse*(raw)` core + a thin
// `read*(dir)` wrapper. The parse cores let a caller resolve a version from file
// content it already has in hand — e.g. a version file read at a git ref via
// `git show <ref>:<path>` (docs/214 bugfix: the release-branch mechanism anchors
// the current version to the maintenance branch, not the working tree) — while
// keeping the on-disk readers as the single source of the parsing regexes.

/** Parse the `version` field from raw `package.json` content, or null. */
export function parsePackageJsonVersion(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : null;
  } catch {
    return null;
  }
}

/** Read the `version` field from a workspace's `package.json`, or null. */
export function readPackageJsonVersion(dir: string): string | null {
  try {
    return parsePackageJsonVersion(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Parse the version from a Cargo.toml `[package]` section via regex.
 * Returns null when there's no `version` in `[package]`.
 */
export function parseCargoTomlVersion(raw: string): string | null {
  const packageSection = /\[package\]([\s\S]*?)(?=\n\[|\s*$)/.exec(raw);
  if (!packageSection) return null;
  const m = /^\s*version\s*=\s*"([^"]+)"/m.exec(packageSection[1] ?? "");
  return m ? (m[1]?.trim() ?? null) : null;
}

/**
 * Read the version from a Cargo.toml `[package]` section.
 * Returns null when the file is absent or has no `version` in `[package]`.
 */
export function readCargoTomlVersion(dir: string): string | null {
  try {
    return parseCargoTomlVersion(fs.readFileSync(path.join(dir, "Cargo.toml"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Parse the version from pyproject.toml content.
 * Tries the PEP 621 `[project]` section first, then Poetry's `[tool.poetry]`.
 */
export function parsePyprojectVersion(raw: string): string | null {
  for (const sectionRe of [/\[project\]([\s\S]*?)(?=\n\[|\s*$)/, /\[tool\.poetry\]([\s\S]*?)(?=\n\[|\s*$)/]) {
    const section = sectionRe.exec(raw);
    if (!section) continue;
    const m = /^\s*version\s*=\s*"([^"]+)"/m.exec(section[1] ?? "");
    if (m) return m[1]?.trim() ?? null;
  }
  return null;
}

/**
 * Read the version from a pyproject.toml file.
 * Tries the PEP 621 `[project]` section first, then Poetry's `[tool.poetry]`.
 */
export function readPyprojectVersion(dir: string): string | null {
  try {
    return parsePyprojectVersion(fs.readFileSync(path.join(dir, "pyproject.toml"), "utf8"));
  } catch {
    return null;
  }
}

/** Parse the version from a `VERSION` file's content (plain semver, first line). */
export function parseVersionFile(raw: string): string | null {
  const line = raw.split("\n")[0]?.trim() ?? "";
  return line || null;
}

/**
 * Read the version from a top-level `VERSION` file (plain semver, first line).
 */
export function readVersionFile(dir: string): string | null {
  try {
    return parseVersionFile(fs.readFileSync(path.join(dir, "VERSION"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Parse a version out of raw version-source content, dispatched by source type.
 * The string-level counterpart of `detectVersionSource` — used to read the
 * current version from a file fetched at a git ref. Returns null for the
 * "tag" scheme (no file content) or when the field can't be located.
 */
export function parseVersionFromContent(source: VersionSourceType, raw: string): string | null {
  switch (source) {
    case "package.json":
      return parsePackageJsonVersion(raw);
    case "Cargo.toml":
      return parseCargoTomlVersion(raw);
    case "pyproject.toml":
      return parsePyprojectVersion(raw);
    case "VERSION":
      return parseVersionFile(raw);
    case "tag":
      return null;
  }
}

/**
 * Detect ALL version sources present in a workspace directory, in priority order:
 * package.json → Cargo.toml → pyproject.toml → VERSION.
 *
 * Multiple results indicate an ambiguous/monorepo situation — callers should
 * surface the ambiguity to the user rather than guessing (docs/171 Phase 2).
 * An empty result means no version file was found (tag-only scheme).
 */
export function detectAllVersionSources(dir: string): DetectedVersionSource[] {
  const sources: DetectedVersionSource[] = [];

  const pkgVersion = readPackageJsonVersion(dir);
  if (pkgVersion) {
    sources.push({ source: "package.json", path: path.join(dir, "package.json"), version: pkgVersion });
  }

  const cargoVersion = readCargoTomlVersion(dir);
  if (cargoVersion) {
    sources.push({ source: "Cargo.toml", path: path.join(dir, "Cargo.toml"), version: cargoVersion });
  }

  const pyVersion = readPyprojectVersion(dir);
  if (pyVersion) {
    sources.push({ source: "pyproject.toml", path: path.join(dir, "pyproject.toml"), version: pyVersion });
  }

  const vfVersion = readVersionFile(dir);
  if (vfVersion) {
    sources.push({ source: "VERSION", path: path.join(dir, "VERSION"), version: vfVersion });
  }

  return sources;
}

/**
 * Detect the primary version source for a workspace.
 * Returns the highest-priority source found (package.json > Cargo.toml >
 * pyproject.toml > VERSION), or null when the workspace has no version file.
 * Use `detectAllVersionSources` when you need to detect ambiguity.
 */
export function detectVersionSource(dir: string): DetectedVersionSource | null {
  return detectAllVersionSources(dir)[0] ?? null;
}

// ---------------------------------------------------------------------------
// Write side (docs/214 Phase 2)
// ---------------------------------------------------------------------------

/**
 * Detect the indentation unit a JSON file uses, so a rewrite preserves the
 * file's existing formatting instead of reflowing it. Returns the whitespace of
 * the first indented line (`"  "`, `"\t"`, …), defaulting to two spaces.
 */
function detectJsonIndent(raw: string): string {
  const m = /\n([ \t]+)\S/.exec(raw);
  return m?.[1] ?? "  ";
}

/**
 * Rewrite the top-level `version` field of a `package.json`-shaped file,
 * preserving the file's indentation and trailing newline. Parsing (rather than
 * a blind regex) guarantees we touch the authoritative top-level field and not,
 * say, a nested dependency's `version`. Returns the new file text.
 */
function rewritePackageJson(raw: string, newVersion: string): string {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  parsed.version = newVersion;
  const indent = detectJsonIndent(raw);
  const out = JSON.stringify(parsed, null, indent);
  return raw.endsWith("\n") ? `${out}\n` : out;
}

/**
 * Replace the `version = "…"` line inside the first matching TOML section. The
 * section regexes mirror the readers above so the write side targets exactly the
 * field the read side parses (write/read symmetry — docs/214). Returns the new
 * file text, or null when no `version` line was found in any candidate section.
 */
function rewriteTomlVersion(raw: string, sectionRes: RegExp[], newVersion: string): string | null {
  for (const sectionRe of sectionRes) {
    const section = sectionRe.exec(raw);
    if (!section) continue;
    const body = section[1] ?? "";
    const versionRe = /^(\s*version\s*=\s*")([^"]+)(")/m;
    if (!versionRe.test(body)) continue;
    const newBody = body.replace(versionRe, `$1${newVersion}$3`);
    return raw.slice(0, section.index) + raw.slice(section.index).replace(body, newBody);
  }
  return null;
}

/**
 * Best-effort root-version bump of a Node lockfile (`package-lock.json`) next to
 * the rewritten `package.json`. npm records the package's own version at the
 * lockfile root AND under `packages[""]`; leaving them stale makes the lockfile
 * disagree with `package.json` (and `npm ci` warn). We do NOT run the package
 * manager — a string-level edit is deterministic and offline (docs/214 "Lean
 * best-effort"). Silent no-op when the lockfile is absent or unparseable.
 */
function bumpNodeLockfile(pkgPath: string, newVersion: string): void {
  const lockPath = path.join(path.dirname(pkgPath), "package-lock.json");
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch {
    return; // no lockfile — nothing to bump
  }
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; packages?: Record<string, { version?: unknown }> };
    if (typeof parsed.version === "string") parsed.version = newVersion;
    const rootPkg = parsed.packages?.[""];
    if (rootPkg && typeof rootPkg.version === "string") rootPkg.version = newVersion;
    const indent = detectJsonIndent(raw);
    const out = JSON.stringify(parsed, null, indent);
    fs.writeFileSync(lockPath, raw.endsWith("\n") ? `${out}\n` : out, "utf8");
  } catch {
    // Malformed lockfile — leave it untouched rather than risk corrupting it.
  }
}

/**
 * Rewrite the version in a previously-detected version source to `newVersion`
 * (docs/214 Phase 2). The write side mirrors the read side exactly — same files,
 * same fields — so the version the release CI later reads back equals the one we
 * wrote. For a Node `package.json` it also bumps `package-lock.json`'s root
 * version best-effort (see `bumpNodeLockfile`).
 *
 * Throws when:
 *   - `detected.source` is `"tag"` (no file to write — the `release-branch`
 *     mechanism requires an authoritative file source; docs/214).
 *   - the source has no `path`.
 *   - the expected version field can't be located in the file (so we never write
 *     a file we didn't actually update).
 */
export function writeVersionToSource(detected: DetectedVersionSource, newVersion: string): void {
  if (detected.source === "tag") {
    throw new Error("Cannot write a version to a tag-only source — release-branch needs a version file.");
  }
  if (!detected.path) {
    throw new Error(`Version source ${detected.source} has no file path to write to.`);
  }
  const raw = fs.readFileSync(detected.path, "utf8");

  let next: string | null;
  switch (detected.source) {
    case "package.json":
      next = rewritePackageJson(raw, newVersion);
      break;
    case "Cargo.toml":
      next = rewriteTomlVersion(raw, [/\[package\]([\s\S]*?)(?=\n\[|\s*$)/], newVersion);
      break;
    case "pyproject.toml":
      next = rewriteTomlVersion(
        raw,
        [/\[project\]([\s\S]*?)(?=\n\[|\s*$)/, /\[tool\.poetry\]([\s\S]*?)(?=\n\[|\s*$)/],
        newVersion,
      );
      break;
    case "VERSION": {
      const lines = raw.split("\n");
      lines[0] = newVersion;
      next = lines.join("\n");
      break;
    }
  }

  if (next === null) {
    throw new Error(`Could not locate the version field in ${detected.path} to rewrite.`);
  }
  fs.writeFileSync(detected.path, next, "utf8");

  if (detected.source === "package.json") {
    bumpNodeLockfile(detected.path, newVersion);
  }
}
