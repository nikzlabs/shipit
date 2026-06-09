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

/** Current marker schema version. Bump if the shape changes incompatibly. */
export const INSTALL_MARKER_VERSION = 1 as const;

/** Fields a fresh install run is stamped with, and compared against on skip. */
export interface InstallMarkerStamp {
  /** git HEAD the install ran against, or `null` for a non-git workspace. */
  sourceCommit: string | null;
  /** Runtime ABI fingerprint from `install-runtime.ts:runtimeKey()`. */
  runtimeKey: string;
  /** The exact `agent.install` command list (raw, as received by `/install`). */
  installCommands: string[];
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
  if (typeof m.completedAt !== "string") return null;
  return {
    version: INSTALL_MARKER_VERSION,
    sourceCommit: m.sourceCommit,
    runtimeKey: m.runtimeKey,
    installCommands: m.installCommands,
    completedAt: m.completedAt,
  };
}

/**
 * Whether a parsed marker exactly matches the current install context. All
 * three stamped fields must agree; any difference is a miss that forces a
 * reinstall (and the caller whiteouts the stale marker first).
 */
export function markerMatches(marker: InstallMarker, current: InstallMarkerStamp): boolean {
  return (
    marker.sourceCommit === current.sourceCommit &&
    marker.runtimeKey === current.runtimeKey &&
    sameCommands(marker.installCommands, current.installCommands)
  );
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
    completedAt,
  };
}
