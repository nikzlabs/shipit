/**
 * Session ids ShipIt reserves for containers and directories it owns itself.
 * The session store holds no row for any of them by design, so a sweep that
 * asks it what is live reads them as abandoned: ask this too before destroying
 * anything keyed by session id. UUID-shaped because every path, label and
 * credential subtree ShipIt keys by session id expects that shape.
 */
export const CLEANUP_CONTAINER_SESSION_ID = "00000000-0000-4000-8000-00000c1ea409";

const SHIPIT_OWN_SESSION_IDS: ReadonlySet<string> = new Set([CLEANUP_CONTAINER_SESSION_ID]);

export function isShipItOwnSession(sessionId: string): boolean {
  return SHIPIT_OWN_SESSION_IDS.has(sessionId);
}
