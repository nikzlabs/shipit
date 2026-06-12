/**
 * Stamped install marker — `.shipit/.install-done` (docs/183 Phase 3).
 *
 * Phase 1 left the install gate as "marker present → skip". That is too coarse
 * for the overlay rolling base: a session mounts a shared base captured after
 * *some* prior install, so presence alone cannot tell whether the base's
 * dependencies still match *this* session's checkout, runtime, or install
 * command. The marker is therefore upgraded from a bare timestamp into a
 * **stamped** record, and the gate skips only on an **exact** match of:
 *
 *   - `sourceCommit` — the git HEAD the install ran against. A non-default
 *     checkout, a force-push, or any HEAD move since the base was built yields a
 *     different commit, so the stamp mismatches and `agent.install` re-runs
 *     (validating the new checkout's manifests against the shared base). `null`
 *     for a non-git workspace, where the field simply drops out of the decision.
 *   - `runtimeKey` — the ABI-compatibility fingerprint (`install-runtime.ts`).
 *     A base with compiled native addons must not be skipped into from an
 *     incompatible runtime.
 *   - `installCommands` — the exact `agent.install` command list. Editing the
 *     install command in `shipit.yaml` must force a reinstall.
 *
 * The marker is plain JSON written into `.shipit/`, which (unlike `.git`) is
 * captured into the overlay base — so a fresh session over an unchanged-`main`
 * base reads a valid stamp from the lowerdir and skips at ~0. A legacy
 * timestamp marker (pre-upgrade) fails {@link parseMarker} and is treated as a
 * miss: one slow install after the upgrade, then the stamped marker takes over.
 */

/**
 * Current marker schema version. Bump if the shape changes incompatibly.
 *
 * v2 (docs/197) added `depsHash`. The bump matters: a v1 marker (no `depsHash`)
 * parses to `null` here, so it cleanly misses rather than being read as a v2
 * marker with an absent hash. One reinstall after the upgrade, then v2 takes over.
 */
export const INSTALL_MARKER_VERSION = 2 as const;

/** Fields a fresh install run is stamped with, and compared against on skip. */
export interface InstallMarkerStamp {
  /** git HEAD the install ran against, or `null` for a non-git workspace. */
  sourceCommit: string | null;
  /** Runtime ABI fingerprint from `install-runtime.ts:runtimeKey()`. */
  runtimeKey: string;
  /** The exact `agent.install` command list (raw, as received by `/install`). */
  installCommands: string[];
  /**
   * Content hash of the dependency input files (`deps-hash.ts`, docs/197), or
   * `null` when content-keying is off (the install isn't a recognized pure
   * dependency install and no `install-inputs` override is set, or no input file
   * exists). When non-`null` it widens the skip: a different commit whose dep
   * files hash identically still matches. A `null` hash never matches via the
   * content path, so a missing/stale hash can only ever cause a reinstall.
   */
  depsHash: string | null;
}

/** The on-disk marker: a stamp plus bookkeeping. */
export interface InstallMarker extends InstallMarkerStamp {
  version: typeof INSTALL_MARKER_VERSION;
  /** ISO timestamp the install finished — diagnostics only, never compared. */
  completedAt: string;
}

/** Serialize a marker for writing to `.shipit/.install-done`. */
export function serializeMarker(marker: InstallMarker): string {
  return JSON.stringify(marker);
}

/**
 * Parse a marker file's contents. Returns `null` for anything that is not a
 * current-version stamped marker — including the legacy bare-timestamp format,
 * a truncated/corrupt file, or a future schema version. A `null` is always a
 * skip-miss, so an unrecognized marker errs toward a (safe, one-time) reinstall.
 */
export function parseMarker(raw: string): InstallMarker | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // legacy timestamp marker or corrupt file
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

/**
 * Whether a parsed marker matches the current install context closely enough to
 * skip `agent.install`. The runtime fingerprint and the install command list
 * must always agree. Given those, the deps are current when **either**:
 *
 *   - the source commit matches (the original exact-commit skip), OR
 *   - the content hash of the dependency input files matches (docs/197) — a
 *     different commit whose dep files are byte-identical has the same deps.
 *
 * The content path is guarded so it can only ever *widen* the skip safely: a
 * `null` hash on either side never matches (see {@link depsHashMatches}), so a
 * missing or content-keying-disabled install simply falls back to commit-only.
 * Any non-match is a miss that forces a reinstall (the caller whiteouts the
 * stale marker first).
 */
export function markerMatches(marker: InstallMarker, current: InstallMarkerStamp): boolean {
  if (marker.runtimeKey !== current.runtimeKey) return false;
  if (!sameCommands(marker.installCommands, current.installCommands)) return false;
  return (
    marker.sourceCommit === current.sourceCommit ||
    depsHashMatches(marker.depsHash, current.depsHash)
  );
}

/**
 * The dependency-content skip path. Both sides must carry a real hash and they
 * must be equal — a `null` (content-keying off, or no input files) never
 * matches, so a wrong/missing hash can only cause a reinstall, never a wrong skip.
 */
function depsHashMatches(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a === b;
}

function sameCommands(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((cmd, i) => cmd === b[i]);
}

/** Build a fresh marker for a just-completed install. */
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
