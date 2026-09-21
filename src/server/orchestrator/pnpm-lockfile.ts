import { parse as parseYaml } from "yaml";

/**
 * The shape of `pnpm-lock.yaml` the verified-base builder needs (docs/276 section 5).
 *
 * Only what the eligibility decision and the registry verification read: which packages the
 * lockfile pins, the digest it pins them to, and the entries that are not plain registry
 * downloads. Everything else pnpm itself consumes from the staged file.
 */

/** Why an entry cannot be verified against a registry digest. `registry` is the admitted kind. */
export type PnpmEntryKind =
  | "registry"
  | "git"
  | "directory"
  | "tarball"
  | "unknown";

export interface PnpmLockPackage {
  /** The lockfile key, peer suffix stripped: `@babel/core@7.24.0`. */
  key: string;
  name: string;
  version: string;
  kind: PnpmEntryKind;
  /** `sha512-<base64>`, present only for `registry` entries. */
  integrity: string | null;
}

/**
 * One dependency edge. `specifier` is what the manifest asked for and `resolved` is what pnpm
 * chose — both matter, because an ordinary semver specifier can resolve to a local link, which
 * is how a local edge escapes a check that only reads specifiers.
 */
export interface PnpmImporterSpecifier {
  importer: string;
  name: string;
  specifier: string;
  resolved: string;
}

export interface ParsedPnpmLock {
  lockfileVersion: string;
  packages: PnpmLockPackage[];
  importers: PnpmImporterSpecifier[];
  /** Keys of `patchedDependencies`; a patched entry is not verifiable from its tarball alone. */
  patchedDependencies: string[];
  /** Importer directories, so the builder stages every workspace manifest the lockfile names. */
  importerDirs: string[];
  /** Every `snapshots:` dependency edge target, which is where a transitive link shows up. */
  snapshotEdges: { from: string; name: string; resolved: string }[];
}

export class PnpmLockParseError extends Error {}

/**
 * Split a lockfile key into name and version. Peer-dependency suffixes (`(react@18.2.0)`) and
 * an appended `_patchHash` are part of the key pnpm writes, not of the published version.
 */
export function splitLockKey(key: string): { name: string; version: string } | null {
  const withoutPeers = key.replace(/\(.*\)$/, "");
  const at = withoutPeers.lastIndexOf("@");
  if (at <= 0) return null;
  const name = withoutPeers.slice(0, at);
  const version = withoutPeers.slice(at + 1);
  if (!name || !version) return null;
  return { name, version };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Classify a `packages:` entry from its `resolution` alone. A registry download is
 * `{integrity}` and nothing else — any `tarball`, `directory`, `repo` or `type` field means the
 * bytes come from somewhere the orchestrator's registry cannot vouch for. Reading the shape
 * rather than the key keeps an unfamiliar future form ineligible instead of silently admitted.
 */
function classifyResolution(resolution: unknown): { kind: PnpmEntryKind; integrity: string | null } {
  if (!isRecord(resolution)) return { kind: "unknown", integrity: null };
  if (typeof resolution.tarball === "string") return { kind: "tarball", integrity: null };
  if (typeof resolution.repo === "string" || resolution.type === "git") {
    return { kind: "git", integrity: null };
  }
  if (typeof resolution.directory === "string" || resolution.type === "directory") {
    return { kind: "directory", integrity: null };
  }
  if (typeof resolution.integrity === "string" && resolution.integrity.startsWith("sha512-")) {
    return { kind: "registry", integrity: resolution.integrity };
  }
  return { kind: "unknown", integrity: null };
}

export function parsePnpmLock(text: string): ParsedPnpmLock {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new PnpmLockParseError(
      `pnpm-lock.yaml is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isRecord(doc)) throw new PnpmLockParseError("pnpm-lock.yaml is not a mapping");

  // YAML quotes it (`'9.0'`) but an unquoted `9.0` parses as a number.
  const rawVersion = doc.lockfileVersion;
  const lockfileVersion =
    typeof rawVersion === "string" ? rawVersion : typeof rawVersion === "number" ? String(rawVersion) : "";
  if (!lockfileVersion) throw new PnpmLockParseError("pnpm-lock.yaml has no lockfileVersion");

  const packages: PnpmLockPackage[] = [];
  const seen = new Set<string>();
  if (isRecord(doc.packages)) {
    for (const [key, value] of Object.entries(doc.packages)) {
      const split = splitLockKey(key);
      if (!split) {
        packages.push({ key, name: key, version: "", kind: "unknown", integrity: null });
        continue;
      }
      const { kind, integrity } = classifyResolution(
        isRecord(value) ? value.resolution : undefined,
      );
      // Peer-suffixed keys collapse onto one published tarball; fetch it once.
      const canonical = `${split.name}@${split.version}`;
      if (seen.has(canonical) && kind === "registry") continue;
      seen.add(canonical);
      packages.push({ key: canonical, name: split.name, version: split.version, kind, integrity });
    }
  }

  const importers: PnpmImporterSpecifier[] = [];
  const importerDirs: string[] = [];
  if (isRecord(doc.importers)) {
    for (const [dir, value] of Object.entries(doc.importers)) {
      importerDirs.push(dir);
      if (!isRecord(value)) continue;
      for (const group of ["dependencies", "devDependencies", "optionalDependencies"]) {
        const deps = value[group];
        if (!isRecord(deps)) continue;
        for (const [name, entry] of Object.entries(deps)) {
          const specifier = isRecord(entry) ? entry.specifier : undefined;
          const resolved = isRecord(entry) ? entry.version : undefined;
          if (typeof specifier === "string") {
            importers.push({
              importer: dir,
              name,
              specifier,
              resolved: typeof resolved === "string" ? resolved : "",
            });
          }
        }
      }
    }
  }

  const snapshotEdges: ParsedPnpmLock["snapshotEdges"] = [];
  if (isRecord(doc.snapshots)) {
    for (const [from, value] of Object.entries(doc.snapshots)) {
      if (!isRecord(value)) continue;
      for (const group of ["dependencies", "optionalDependencies"]) {
        const deps = value[group];
        if (!isRecord(deps)) continue;
        for (const [name, resolved] of Object.entries(deps)) {
          if (typeof resolved === "string") snapshotEdges.push({ from, name, resolved });
        }
      }
    }
  }

  const patched = isRecord(doc.patchedDependencies) ? Object.keys(doc.patchedDependencies) : [];

  return {
    lockfileVersion,
    packages,
    importers,
    patchedDependencies: patched,
    importerDirs: importerDirs.length > 0 ? importerDirs : ["."],
    snapshotEdges,
  };
}
