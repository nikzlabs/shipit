import fs from "node:fs";
import path from "node:path";
import { sessionWorkerUid } from "./session-worker-uid.js";

export const WORKER_UID_MARKER_FILE = ".shipit-worker-uid";

export interface WorkerUidGuardInput {
  stateDir: string;
  /** Null means unset; omission uses sessionWorkerUid(). */
  currentUid?: number | null;
  hasPersistedSessions: boolean;
  allowDowngrade?: boolean;
}

function readMarker(markerPath: string): number | null {
  try {
    const raw = fs.readFileSync(markerPath, "utf-8").trim();
    if (!raw) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

function writeMarker(markerPath: string, uid: number | null): void {
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, String(uid ?? 0), { mode: 0o600 });
  } catch (err) {
    console.warn(`[worker-uid-guard] failed to persist marker ${markerPath}:`, err);
  }
}

// A return to root can create files that existing chown sentinels later leave unreadable.
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
