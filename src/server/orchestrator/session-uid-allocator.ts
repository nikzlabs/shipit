/**
 * planning#405 / docs/268 — allocate a distinct uid per session.
 *
 * ## The range, and why these numbers
 *
 * `[SESSION_UID_MIN, SESSION_UID_MAX]` is a band nothing else uses, chosen
 * against the numbers that actually occur rather than against a hunch:
 *
 *   - distro system accounts stop at 999;
 *   - every account a project might name in a compose `user:` — `33` (www-data),
 *     `101`, `999` (postgres/redis in the common images), `1000`, `1001` — sits
 *     in the low thousands;
 *   - `nobody` is 65534, the 16-bit ceiling is 65535;
 *   - the rootless / userns `subuid` convention starts at 100000 and runs to
 *     about 165536.
 *
 * 2 000 000 is clear of all of them and far below the 32-bit `uid_t` ceiling, so
 * a session identity can never collide with a `user:` a real project declares
 * (docs/268 req 4a). `compose-generator.ts` refuses a declared `user:` inside the
 * range, which turns "cannot collide in practice" into "cannot collide".
 *
 * Two properties fall out of the range rather than being enforced by logic:
 *
 *   - **The reserved egress uids can never be allocated** (req 3). 911 and 912
 *     are exempted from the netns firewall by owner-match, so a workload holding
 *     either escapes egress containment (`session-worker-uid.ts`). They are not
 *     in this range. {@link assertSessionUidRange} still runs at boot, because
 *     the constants above are editable and the failure would be silent.
 *   - **An identity is never reused** (req 7). Allocation is a monotonic
 *     counter, so "a recycled uid must not reach the previous holder's
 *     leftovers" is satisfied vacuously instead of by a cleanup path that has to
 *     be correct. One million identities at 200 new sessions a day is ~13 years,
 *     and exhaustion throws at session creation naming the range (req 11) rather
 *     than wrapping into a uid someone already holds.
 *
 * ## Where the value lives afterwards
 *
 * This module's counter is an allocation ledger, not the record. Once a session
 * exists, **the owner of its session directory is the record** — see
 * `shared/session-identity.ts` for why that has to be a place the session cannot
 * write. If the two ever disagree, the directory wins; the counter's only job is
 * to never hand out the same number twice.
 */

import type Database from "better-sqlite3";
import { RESERVED_EGRESS_UIDS } from "./session-worker-uid.js";

/** First uid available to a session. See the module header for the choice. */
export const SESSION_UID_MIN = 2_000_000;
/** Last uid available to a session (inclusive). */
export const SESSION_UID_MAX = 2_999_999;

/** Is `uid` inside ShipIt's reserved per-session range? */
export function isSessionUid(uid: number): boolean {
  return Number.isInteger(uid) && uid >= SESSION_UID_MIN && uid <= SESSION_UID_MAX;
}

/** Thrown when the range is exhausted. Never degrades to sharing an identity. */
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

/**
 * Boot-time fail-fast: the range must not overlap a uid the netns firewall
 * exempts by owner-match, and must be a sane interval.
 *
 * Deliberately unconditional and independent of runtime mode, exactly like
 * `assertWorkerUidNotReserved`: the property is of the constants, not of the
 * deployment, and a refusal that fired only where containers exist would let a
 * local orchestrator carry a broken range until an unrelated path used it.
 */
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

/**
 * Take the next uid, atomically.
 *
 * The read and the bump are one SQLite transaction, so two sessions created
 * concurrently can never receive the same number (req 6). A crash between this
 * returning and the session directory being chowned burns one identity, which is
 * the correct trade against ever reusing one.
 */
export function allocateSessionUid(db: Database.Database): number {
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
