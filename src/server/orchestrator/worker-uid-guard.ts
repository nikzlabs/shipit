/**
 * Startup fail-fast guard against `SHIPIT_SESSION_WORKER_UID` drift (docs/150
 * Rollout).
 *
 * The non-root migration is gated on `SHIPIT_SESSION_WORKER_UID`: set → the
 * worker drops to that UID and the orchestrator chowns its per-session writes to
 * it; unset → legacy root runtime. The hazard is a *silent config rollback*: a
 * deploy that ran with the var set (so existing sessions' mounts are owned by
 * that UID and were created by a non-root worker) followed by a deploy that
 * forgets the var.
 *
 * Note the gated entrypoint (`docker/session-worker/entrypoint.sh`) softens the
 * worst case — with the var unset the worker execs as *root* again, and root can
 * still read the UID-1000-owned mounts, so a session doesn't hard-break the way
 * it would under an always-drop entrypoint. But unsetting the var after a
 * non-root rollout is almost always unintended, and it is not free:
 *
 *   - The orchestrator stops chowning its post-boot writes, so new credential
 *     files land `root:root`. That is fine *while* the worker is root, but if
 *     the var is later re-set, the per-mount chown sentinel
 *     (`.shipit-uid-<uid>`) already exists, so the boot-time `chown -R` is
 *     skipped and those `root:root` files stay unreadable to the `shipit`
 *     worker — auth breaks one session at a time, exactly the drift this guard
 *     exists to catch, just deferred by one deploy.
 *
 * So we fail fast at startup when the marker shows a non-root UID was active,
 * sessions exist, and the var is now unset — surfacing the rollback immediately
 * instead of letting the fleet limp in a half-migrated state. An operator who
 * *intends* to downgrade sets `SHIPIT_SESSION_WORKER_UID_ALLOW_DOWNGRADE=1`
 * (or archives/resets the affected sessions first).
 *
 * The guard is a no-op in local/dogfood mode (no containers, no `shipit` user)
 * and in tests.
 */

import fs from "node:fs";
import path from "node:path";
import { sessionWorkerUid } from "./session-worker-uid.js";

/** Filename of the per-boot worker-UID marker under the orchestrator state dir. */
export const WORKER_UID_MARKER_FILE = ".shipit-worker-uid";

export interface WorkerUidGuardInput {
  /** Orchestrator state dir (where the marker is persisted). */
  stateDir: string;
  /** Current worker UID (null = unset). Defaults to {@link sessionWorkerUid}. */
  currentUid?: number | null;
  /** Whether any sessions are persisted (their mounts may carry stale owners). */
  hasPersistedSessions: boolean;
  /** Operator opt-out for a deliberate downgrade. Defaults to the env var. */
  allowDowngrade?: boolean;
}

/** Read the persisted marker. Returns the UID, or null when absent/invalid. */
function readMarker(markerPath: string): number | null {
  try {
    const raw = fs.readFileSync(markerPath, "utf-8").trim();
    if (!raw) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null; // absent — first boot, or fresh state
  }
}

/** Persist the current worker UID (0 = unset/root) best-effort. */
function writeMarker(markerPath: string, uid: number | null): void {
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, String(uid ?? 0), { mode: 0o600 });
  } catch (err) {
    console.warn(`[worker-uid-guard] failed to persist marker ${markerPath}:`, err);
  }
}

/**
 * Throw on dangerous `SHIPIT_SESSION_WORKER_UID` drift; otherwise persist the
 * current value and return. Pure (filesystem in/out) so it's unit-testable.
 */
export function assertWorkerUidConsistency(input: WorkerUidGuardInput): void {
  const current = input.currentUid !== undefined ? input.currentUid : sessionWorkerUid();
  const allowDowngrade =
    input.allowDowngrade ?? process.env.SHIPIT_SESSION_WORKER_UID_ALLOW_DOWNGRADE === "1";
  const markerPath = path.join(input.stateDir, WORKER_UID_MARKER_FILE);
  const previous = readMarker(markerPath);

  const wasNonRoot = previous !== null && previous > 0;
  const nowUnset = current === null;

  if (wasNonRoot && nowUnset && input.hasPersistedSessions && !allowDowngrade) {
    throw new Error(
      `[worker-uid-guard] Refusing to start: existing sessions were created under ` +
        `SHIPIT_SESSION_WORKER_UID=${previous}, but the variable is now unset. This is a ` +
        `config rollback that strands per-session mount ownership (and will break agent ` +
        `auth one session at a time if the variable is re-set later, because the chown ` +
        `sentinels block a re-chown). Re-set SHIPIT_SESSION_WORKER_UID=${previous}, or — if ` +
        `the downgrade is intentional — set SHIPIT_SESSION_WORKER_UID_ALLOW_DOWNGRADE=1 ` +
        `(archive/reset the affected sessions first so they re-provision cleanly).`,
    );
  }

  writeMarker(markerPath, current);
}
