/**
 * Release version-source detection + next-version (semver) computation
 * (docs/171 Phase 1). Pure, dependency-free helpers — the project pins exact
 * versions and enforces a dependency age policy, so rather than add `semver`
 * we implement the small slice we need (parse, compare-free bump, format).
 *
 * Phase 1 detects only `package.json` `version`. Cargo.toml / pyproject.toml /
 * VERSION / tag-only schemes are Phase 2.
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

export interface DetectedVersionSource {
  /** Phase 1: always "package.json". */
  source: "package.json";
  /** Absolute path to the version-source file. */
  path: string;
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
 * Detect the version source for a workspace. Phase 1 only inspects
 * `package.json`; returns null when there is no usable version field (the
 * caller falls back to the tag-only scheme or asks the user — Phase 2).
 */
export function detectVersionSource(dir: string): DetectedVersionSource | null {
  const version = readPackageJsonVersion(dir);
  if (!version) return null;
  return { source: "package.json", path: path.join(dir, "package.json"), version };
}
