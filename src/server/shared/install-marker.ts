export const INSTALL_MARKER_VERSION = 2 as const;

export interface InstallMarkerStamp {
  sourceCommit: string | null;
  runtimeKey: string;
  installCommands: string[];
  /** Null disables matching by dependency content. */
  depsHash: string | null;
}

export interface InstallMarker extends InstallMarkerStamp {
  version: typeof INSTALL_MARKER_VERSION;
  completedAt: string;
}

export function serializeMarker(marker: InstallMarker): string {
  return JSON.stringify(marker);
}

// Unknown or invalid markers cause a reinstall.
export function parseMarker(raw: string): InstallMarker | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const m = parsed as Record<string, unknown>;
  if (m.version !== INSTALL_MARKER_VERSION) return null;
  if (!(typeof m.sourceCommit === "string" || m.sourceCommit === null)) return null;
  if (typeof m.runtimeKey !== "string") return null;
  if (!Array.isArray(m.installCommands) || !m.installCommands.every((c) => typeof c === "string")) {
    return null;
  }
  if (!(typeof m.depsHash === "string" || m.depsHash === null)) return null;
  if (typeof m.completedAt !== "string") return null;
  return {
    version: INSTALL_MARKER_VERSION,
    sourceCommit: m.sourceCommit,
    runtimeKey: m.runtimeKey,
    installCommands: m.installCommands,
    depsHash: m.depsHash,
    completedAt: m.completedAt,
  };
}

export interface MarkerMatchOptions {
  /**
   * Requires the dependency content hash to match, rather than accepting a same-commit marker.
   * Set for pnpm: the verified base is published UNBUILT and every session runs its own install to
   * build what it approves, so a same-commit change to the approval file (`pnpm-workspace.yaml`)
   * must reinstall rather than skip — commit alone cannot see it
   * (docs/276-shared-package-cache-integrity section 5). A repo whose install commands yield no
   * content hash therefore reinstalls on every start, which is the safe direction.
   */
  requireDepsHash?: boolean;
}

export function markerMatches(
  marker: InstallMarker,
  current: InstallMarkerStamp,
  opts: MarkerMatchOptions = {},
): boolean {
  if (marker.runtimeKey !== current.runtimeKey) return false;
  if (!sameCommands(marker.installCommands, current.installCommands)) return false;
  if (opts.requireDepsHash) return depsHashMatches(marker.depsHash, current.depsHash);
  return (
    marker.sourceCommit === current.sourceCommit ||
    depsHashMatches(marker.depsHash, current.depsHash)
  );
}

function depsHashMatches(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a === b;
}

export function sameCommands(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((cmd, i) => cmd === b[i]);
}

export function makeMarker(stamp: InstallMarkerStamp, completedAt: string): InstallMarker {
  return {
    version: INSTALL_MARKER_VERSION,
    sourceCommit: stamp.sourceCommit,
    runtimeKey: stamp.runtimeKey,
    installCommands: stamp.installCommands,
    depsHash: stamp.depsHash,
    completedAt,
  };
}
