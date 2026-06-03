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

/** Read the `version` field from a workspace's `package.json`, or null. */
export function readPackageJsonVersion(dir: string): string | null {
  try {
    const pkgPath = path.join(dir, "package.json");
    const raw = fs.readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Read the version from a Cargo.toml `[package]` section via regex.
 * Returns null when the file is absent or has no `version` in `[package]`.
 */
export function readCargoTomlVersion(dir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(dir, "Cargo.toml"), "utf8");
    const packageSection = /\[package\]([\s\S]*?)(?=\n\[|\s*$)/.exec(raw);
    if (!packageSection) return null;
    const m = /^\s*version\s*=\s*"([^"]+)"/m.exec(packageSection[1] ?? "");
    return m ? (m[1]?.trim() ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Read the version from a pyproject.toml file.
 * Tries the PEP 621 `[project]` section first, then Poetry's `[tool.poetry]`.
 */
export function readPyprojectVersion(dir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(dir, "pyproject.toml"), "utf8");
    for (const sectionRe of [/\[project\]([\s\S]*?)(?=\n\[|\s*$)/, /\[tool\.poetry\]([\s\S]*?)(?=\n\[|\s*$)/]) {
      const section = sectionRe.exec(raw);
      if (!section) continue;
      const m = /^\s*version\s*=\s*"([^"]+)"/m.exec(section[1] ?? "");
      if (m) return m[1]?.trim() ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read the version from a top-level `VERSION` file (plain semver, first line).
 */
export function readVersionFile(dir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(dir, "VERSION"), "utf8");
    const line = raw.split("\n")[0]?.trim() ?? "";
    return line || null;
  } catch {
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
