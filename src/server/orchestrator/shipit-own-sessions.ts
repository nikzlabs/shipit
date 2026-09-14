/**
 * Session ids ShipIt reserves for containers and directories it owns itself.
 * The session store holds no row for any of them by design, so a sweep that
 * infers abandonment from a missing row reads them as orphans: ask this too.
 * A sweep that verifies actual death — the egress reaper, which checks whether
 * a sidecar's parent is gone — needs no exemption and must not have one.
 * UUID-shaped because every path, label and credential subtree ShipIt keys by
 * session id expects that shape.
 *
 * Deliberately identical on every install, rather than derived per stack: the
 * directories and credential subtrees it keys live in per-stack volumes, so two
 * stacks sharing a daemon only ever collided in Docker's global namespaces —
 * scoped by `sessionContainerName` and the stack label filters instead. One
 * constant also lets `isShipItOwnSession` recognise *any* stack's reserved
 * container, which is what a sweep seeing the whole daemon needs.
 */
export const CLEANUP_CONTAINER_SESSION_ID = "00000000-0000-4000-8000-00000c1ea409";

const SHIPIT_OWN_SESSION_IDS: ReadonlySet<string> = new Set([CLEANUP_CONTAINER_SESSION_ID]);

export function isShipItOwnSession(sessionId: string): boolean {
  return SHIPIT_OWN_SESSION_IDS.has(sessionId);
}

/**
 * Container names are global per Docker daemon, and the reserved ids above are
 * the same on every install — so two stacks sharing a daemon would name one
 * container, and each stack's create force-removes whoever holds the name
 * (`removeStaleContainer`). Ordinary sessions are random UUIDs and keep the
 * unscoped name operators already type into `docker exec`.
 */
export function sessionContainerName(sessionId: string, stackName?: string): string {
  const name = `agent-${sessionId.slice(0, 12)}`;
  if (!isShipItOwnSession(sessionId) || !stackName) return name;
  return `${name}-${stackName.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
}
