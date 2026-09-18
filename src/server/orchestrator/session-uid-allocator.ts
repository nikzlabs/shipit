import type Database from "better-sqlite3";
import { RESERVED_EGRESS_UIDS, sealSessionDir, sessionWorkerGid } from "./session-worker-uid.js";
import type { SessionIdentity } from "../shared/session-identity.js";

// Outside common system and subuid ranges; Compose rejects project users in this band.
export const SESSION_UID_MIN = 2_000_000;
export const SESSION_UID_MAX = 2_999_999;

export function isSessionUid(uid: number): boolean {
  return Number.isInteger(uid) && uid >= SESSION_UID_MIN && uid <= SESSION_UID_MAX;
}

export class SessionUidExhaustedError extends Error {
  constructor() {
    super(
      `[session-uid] Refusing to create a session: every uid in ShipIt's per-session range ` +
        `${SESSION_UID_MIN}-${SESSION_UID_MAX} has been allocated. Identities are never reused, ` +
        `so this is exhaustion of the range rather than contention for it. Widen ` +
        `SESSION_UID_MAX (uid_t is 32-bit, so there is room) and restart.`,
    );
    this.name = "SessionUidExhaustedError";
  }
}

export function assertSessionUidRange(): void {
  if (!Number.isInteger(SESSION_UID_MIN) || !Number.isInteger(SESSION_UID_MAX)
    || SESSION_UID_MIN <= 0 || SESSION_UID_MAX < SESSION_UID_MIN) {
    throw new Error(
      `[session-uid] Refusing to start: the per-session uid range ` +
        `${SESSION_UID_MIN}-${SESSION_UID_MAX} is not a valid non-root interval.`,
    );
  }
  const reserved = RESERVED_EGRESS_UIDS.filter(isSessionUid);
  if (reserved.length > 0) {
    throw new Error(
      `[session-uid] Refusing to start: the per-session uid range ` +
        `${SESSION_UID_MIN}-${SESSION_UID_MAX} contains reserved egress UID(s) ` +
        `${reserved.join("/")}. The netns firewall exempts those UIDs from the controls that ` +
        `name them, so a session allocated one would silently escape egress containment. ` +
        `Move the range clear of ${RESERVED_EGRESS_UIDS.join("/")}.`,
    );
  }
}

// Never reuse an identity, even if creation fails after allocation.
export function allocateSessionUid(db: Database.Database): number {
  return takeNextUid(db);
}

let ledger: Database.Database | null = null;

export function configureSessionUidLedger(db: Database.Database | null): void {
  ledger = db;
}

// Seal before git runs: git derives its identity from directory ownership.
export function allocateAndSealSessionDir(sessionDir: string): SessionIdentity | null {
  const gid = sessionWorkerGid();
  if (ledger === null || gid === null) return null;
  const identity: SessionIdentity = { uid: allocateSessionUid(ledger), gid };
  // Directory ownership is authoritative; allocation alone does not establish identity.
  if (!sealSessionDir(sessionDir, identity)) {
    console.error(
      `[session-uid] seal failed for ${sessionDir}; refusing to report an identity it does not have`,
    );
    return null;
  }
  return identity;
}

function takeNextUid(db: Database.Database): number {
  const take = db.transaction((): number => {
    const row = db
      .prepare("SELECT next_uid FROM session_uid_allocation WHERE id = 1")
      .get() as { next_uid: number } | undefined;
    const next = row?.next_uid ?? SESSION_UID_MIN;
    if (next > SESSION_UID_MAX) throw new SessionUidExhaustedError();
    db.prepare(
      "INSERT INTO session_uid_allocation (id, next_uid) VALUES (1, ?) " +
        "ON CONFLICT(id) DO UPDATE SET next_uid = excluded.next_uid",
    ).run(next + 1);
    return next;
  });
  return take();
}
