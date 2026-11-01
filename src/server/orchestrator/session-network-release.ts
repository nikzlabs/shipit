import os from "node:os";
import { getMessage } from "./disk-utils.js";
import { serializeStackOp } from "./stack-op-queue.js";

interface Bounded {
  abortSignal?: AbortSignal;
}

interface SessionNetworkHandle {
  connect(options: { Container: string } & Bounded): Promise<unknown>;
  disconnect(options: { Container: string; Force?: boolean } & Bounded): Promise<unknown>;
  remove(options?: Bounded): Promise<unknown>;
}

export interface SessionNetworkDocker {
  getNetwork(idOrName: string): SessionNetworkHandle;
  listContainers(
    options: { all: boolean; filters: { network: string[] } } & Bounded,
  ): Promise<{ Id: string; Names?: string[] }[]>;
}

export type SessionNetworkRelease = "removed" | "absent" | "in-use" | "failed";

// The stack queue has no timeout of its own, so a daemon that never answers would hold every
// later start of the session.
const DOCKER_CALL_TIMEOUT_MS = 30_000;

function statusCodeOf(err: unknown): number {
  return err && typeof err === "object" && "statusCode" in err ? Number(err.statusCode) : 0;
}

// Docker's default hostname. Only this form may match an id by prefix: a short name could be the
// start of another container's id.
const CONTAINER_ID_HOSTNAME = /^[0-9a-f]{12,64}$/;

/**
 * Remove a session network that no container but the orchestrator names (docs/091).
 *
 * Compose's `down` leaves a network that has any endpoint ("Resource is still in use", exit 0),
 * and the orchestrator's own endpoint — joined to route previews — is one Compose does not own.
 * So a stopped stack kept its network, and with it a subnet of Docker's address pool, until the
 * pool was empty.
 *
 * A container in ANY state keeps the network: Docker lets a network go while a created or
 * stopped container still names it, and that container can then never start. Hold the session's
 * stack queue around this (`releaseSessionNetworkQueued`): `up` finds the network before it
 * creates its first container, and no listing shows that interval.
 *
 * `names` are the network's other identities: a container that has not started names its
 * network by name, never by id.
 */
export async function releaseSessionNetwork(
  docker: SessionNetworkDocker,
  network: string,
  opts: { orchestratorId?: string; names?: string[] } = {},
): Promise<SessionNetworkRelease> {
  const self = opts.orchestratorId ?? os.hostname();
  const selfIsId = CONTAINER_ID_HOSTNAME.test(self);
  const isSelf = (c: { Id: string; Names?: string[] }): boolean =>
    (selfIsId && c.Id.startsWith(self)) || (self !== "" && (c.Names ?? []).includes(`/${self}`));
  const bounded = (): Bounded => ({ abortSignal: AbortSignal.timeout(DOCKER_CALL_TIMEOUT_MS) });

  try {
    const named = await docker.listContainers({
      all: true,
      filters: { network: [network, ...(opts.names ?? [])] },
      ...bounded(),
    });
    if (named.some((c) => !isSelf(c))) return "in-use";

    const handle = docker.getNetwork(network);
    let detached = false;
    let detachError: unknown;
    if (named.length > 0) {
      try {
        await handle.disconnect({ Container: self, Force: true, ...bounded() });
        detached = true;
      } catch (err) {
        if (statusCodeOf(err) === 404) return "absent";
        // A concurrent release can have detached it already; the removal below decides.
        detachError = err;
      }
    }

    try {
      await handle.remove(bounded());
      return "removed";
    } catch (err) {
      if (statusCodeOf(err) === 404) return "absent";
      // Nothing else puts the orchestrator back before the next `up`.
      if (detached) await handle.connect({ Container: self, ...bounded() });
      // 403 is Docker's "has active endpoints": a container attached after the listing.
      if (!detachError && statusCodeOf(err) === 403) return "in-use";
      throw detachError ?? err;
    }
  } catch (err) {
    console.warn(`[network] could not release ${network}:`, getMessage(err));
    return "failed";
  }
}

/**
 * The release as its own stack operation, which the teardown that asks for it does not await.
 *
 * `stackOwned` says whether a ServiceManager is registered for the session, and is read inside
 * the queue. A registered manager owns the network, with or without containers: some of its
 * starts run outside the queue, and `refreshSecrets` starts services without joining the
 * orchestrator again. A manager that registers later runs its first `up` behind this operation.
 */
export function releaseSessionNetworkQueued(
  docker: SessionNetworkDocker,
  sessionId: string,
  stackOwned: () => boolean,
): void {
  void serializeStackOp(sessionId, async () => {
    if (stackOwned()) return;
    await releaseSessionNetwork(docker, `shipit-session-${sessionId}`);
  });
}
