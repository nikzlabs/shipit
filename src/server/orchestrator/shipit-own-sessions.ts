/**
 * Session ids ShipIt reserves for containers and directories it owns itself.
 * The session store holds no row for any of them by design, so a sweep that
 * infers abandonment from a missing row reads them as orphans: ask this too.
 * A sweep that verifies actual death — the egress reaper, which checks whether
 * a sidecar's parent is gone — needs no exemption and must not have one.
 * UUID-shaped because every path, label and credential subtree ShipIt keys by
 * session id expects that shape.
 */
export const CLEANUP_CONTAINER_SESSION_ID = "00000000-0000-4000-8000-00000c1ea409";

const SHIPIT_OWN_SESSION_IDS: ReadonlySet<string> = new Set([CLEANUP_CONTAINER_SESSION_ID]);

export function isShipItOwnSession(sessionId: string): boolean {
  return SHIPIT_OWN_SESSION_IDS.has(sessionId);
}
