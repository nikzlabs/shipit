import fs from "node:fs";
import path from "node:path";
import type { ReleaseBumpType } from "../shared/types/release-types.js";

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export function parseSemVer(input: string): SemVer | null {
  const trimmed = input.trim().replace(/^v/, "");
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

export function formatSemVer(v: SemVer): string {
  const core = `${v.major}.${v.minor}.${v.patch}`;
  return v.prerelease.length > 0 ? `${core}-${v.prerelease.join(".")}` : core;
}

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
  source: VersionSourceType;
  /** Absolute; absent for tag-only sources. */
  path?: string;
  version: string;
}

export function parsePackageJsonVersion(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : null;
  } catch {
    return null;
  }
}

export function readPackageJsonVersion(dir: string): string | null {
  try {
    return parsePackageJsonVersion(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

export function parseCargoTomlVersion(raw: string): string | null {
  const packageSection = /\[package\]([\s\S]*?)(?=\n\[|\s*$)/.exec(raw);
  if (!packageSection) return null;
  const m = /^\s*version\s*=\s*"([^"]+)"/m.exec(packageSection[1] ?? "");
  return m ? (m[1]?.trim() ?? null) : null;
}

export function readCargoTomlVersion(dir: string): string | null {
  try {
    return parseCargoTomlVersion(fs.readFileSync(path.join(dir, "Cargo.toml"), "utf8"));
  } catch {
    return null;
  }
}

export function parsePyprojectVersion(raw: string): string | null {
  for (const sectionRe of [/\[project\]([\s\S]*?)(?=\n\[|\s*$)/, /\[tool\.poetry\]([\s\S]*?)(?=\n\[|\s*$)/]) {
    const section = sectionRe.exec(raw);
    if (!section) continue;
    const m = /^\s*version\s*=\s*"([^"]+)"/m.exec(section[1] ?? "");
    if (m) return m[1]?.trim() ?? null;
  }
  return null;
}

export function readPyprojectVersion(dir: string): string | null {
  try {
    return parsePyprojectVersion(fs.readFileSync(path.join(dir, "pyproject.toml"), "utf8"));
  } catch {
    return null;
  }
}

export function parseVersionFile(raw: string): string | null {
  const line = raw.split("\n")[0]?.trim() ?? "";
  return line || null;
}

export function readVersionFile(dir: string): string | null {
  try {
    return parseVersionFile(fs.readFileSync(path.join(dir, "VERSION"), "utf8"));
  } catch {
    return null;
  }
}

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

// Use detectAllVersionSources when the caller must detect ambiguity.
export function detectVersionSource(dir: string): DetectedVersionSource | null {
  return detectAllVersionSources(dir)[0] ?? null;
}

function detectJsonIndent(raw: string): string {
  const m = /\n([ \t]+)\S/.exec(raw);
  return m?.[1] ?? "  ";
}

function rewritePackageJson(raw: string, newVersion: string): string {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  parsed.version = newVersion;
  const indent = detectJsonIndent(raw);
  const out = JSON.stringify(parsed, null, indent);
  return raw.endsWith("\n") ? `${out}\n` : out;
}

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

function bumpNodeLockfile(pkgPath: string, newVersion: string): void {
  const lockPath = path.join(path.dirname(pkgPath), "package-lock.json");
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch {
    return;
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
    // Leave unreadable lockfiles unchanged.
  }
}

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
