/**
 * Egress sidecar orphan reaper (SHI-222).
 *
 * The Tier B resolver and Tier C SNI proxy (docs/172, SHI-90) are long-lived
 * sidecars launched with `NetworkMode: container:<agentContainerId>` — they have
 * no network stack of their own, they *borrow* the agent container's. That makes
 * the agent container their **netns parent**, and it makes their lifetime
 * strictly dependent on it: when the parent stops, the shared namespace is torn
 * down and the sidecar's process dies with it. Docker retries the start (their
 * `RestartPolicy` is `on-failure`, capped at 3), each retry fails to join a dead
 * namespace, and the container settles in `Exited` — inert, but *still there*.
 * Nothing self-removes it.
 *
 * On the orchestrator-initiated teardown paths that is handled:
 * `destroyContainer` stops the agent, runs `cleanupSessionDockerResources`'s
 * `shipit-parent-session` label sweep, then removes the agent last (ordering is
 * deliberate — sidecars must die before the namespace holder is removed).
 *
 * The path that was NOT handled, and which this module exists for, is the agent
 * container dying on its **own** — OOM, crash, host OOM-killer, an external
 * `docker rm`. The `die`/`oom` handler in `container-health.ts` deletes the
 * session's container-map entry, and that *latches* the leak: every later
 * `destroy()` for the session early-returns on `if (!sc) return`, so even
 * archiving the session afterwards never runs the sweep. The sidecars outlive
 * the session entirely.
 *
 * Two entry points, matching the two clocks the leak runs on:
 *
 *   - {@link reapSessionEgressSidecars} — **at the crash site.** Called from the
 *     `die`/`oom` handler for one session, scoped to the id of the agent
 *     container that just died. Deliberately targeted at the egress labels: an
 *     agent OOM must NOT take down the user's compose services, networks, or
 *     volumes, so this is emphatically *not* `cleanupSessionDockerResources`.
 *   - {@link reapOrphanEgressSidecars} — **crash-recovery backstop at boot.**
 *     A global parent-liveness sweep for the orphans a *previous* orchestrator
 *     process never got to reap (it died mid-cleanup, the Docker daemon
 *     restarted, someone `docker rm`'d the agent by hand). Boot-only, per
 *     CLAUDE.md's disk-cleanup rule: this leak grows on the crash clock, not the
 *     wall clock, so a periodic timer would mostly burn cycles finding nothing.
 *
 * **Every path here keys on the netns parent, never on the session label alone**,
 * and that is the load-bearing invariant of this module. The agent container's
 * name and the session id are both reused across recreations, so a label-only
 * match ("is this a sidecar for session X?") cannot tell this incarnation's
 * resolver from the corpse of the last one. It cuts both ways: the boot sweep
 * would SPARE a dead sidecar it should reap, and the crash-site reap — which is
 * fire-and-forget — would RACE the session's own recovery and delete the
 * replacement incarnation's live sidecars out from under a healthy agent.
 * "Is your netns parent the container I mean, and is it running?" is immune to
 * both. It's the same question `compose-cli.ts`'s stale-sweep keep-list has to
 * answer, for the same reason.
 *
 * Everything fails **safe toward keeping**. A false reap costs a *running*
 * session its DNS and HTTPS; a false keep costs one inert container that the next
 * boot sweep collects anyway. So an unreadable sidecar, a parent inspect that
 * fails with anything other than a 404, a structurally incomplete inspect, and a
 * network mode that borrows no namespace all resolve to "keep".
 *
 * Safety: the agent container is created with **no `RestartPolicy`** (see
 * `container-lifecycle.ts`), so it never legitimately transitions
 * running → stopped → running underneath a live sidecar. "Parent not running"
 * therefore always means "this sidecar is dead weight", never "wait a moment."
 */

import type Docker from "dockerode";
import { EGRESS_RESOLVER_LABEL } from "./egress-dns-install.js";
import { EGRESS_PROXY_LABEL } from "./egress-proxy-install.js";

/** The per-tier labels that identify a container as an egress sidecar. */
export const EGRESS_SIDECAR_LABELS = [EGRESS_RESOLVER_LABEL, EGRESS_PROXY_LABEL] as const;

const NETNS_PREFIX = "container:";

/**
 * Extract the netns parent's container id from a `HostConfig.NetworkMode`.
 *
 * Returns `null` for any other network mode (`bridge`, `host`, a named network,
 * …) — i.e. "this container does not borrow another's namespace, so it has no
 * parent to outlive."
 */
export function netnsParentId(networkMode: string | null | undefined): string | null {
  if (!networkMode?.startsWith(NETNS_PREFIX)) return null;
  return networkMode.slice(NETNS_PREFIX.length).trim() || null;
}

function statusCode(err: unknown): number {
  return err && typeof err === "object" && "statusCode" in err ? Number(err.statusCode) : 0;
}

/**
 * List every egress sidecar container, optionally scoped to one session.
 *
 * Docker's `--filter label=` has no OR, so we query once per tier label and
 * union by container id. Returns `[]` (never throws) if Docker is unavailable.
 */
async function listEgressSidecars(docker: Docker, sessionId?: string): Promise<string[]> {
  const ids = new Set<string>();
  for (const label of EGRESS_SIDECAR_LABELS) {
    const filter = sessionId ? `${label}=${sessionId}` : label;
    try {
      const list = await docker.listContainers({ all: true, filters: { label: [filter] } });
      for (const c of list) ids.add(c.Id);
    } catch {
      // Docker unavailable — nothing to reap, and definitely nothing to throw about.
    }
  }
  return [...ids];
}

/** Force-remove one container. Returns whether it's gone. Never throws. */
async function removeContainer(docker: Docker, id: string): Promise<boolean> {
  try {
    await docker.getContainer(id).remove({ force: true });
    return true;
  } catch (err) {
    // 404 = already gone (the outcome we wanted); 409 = removal already in flight.
    const code = statusCode(err);
    if (code === 404 || code === 409) return true;
    console.warn(`[egress-reaper] failed to remove sidecar ${id.slice(0, 12)}:`, err);
    return false;
  }
}

/**
 * Is this sidecar's netns parent gone or not running — i.e. is the sidecar
 * sharing a namespace that no longer exists?
 *
 * Fails **safe** in both directions that matter. If we can't inspect the sidecar
 * at all (daemon hiccup), we say "not orphaned" and leave it alone — a false
 * *keep* costs a stale container, a false *reap* costs a running session its DNS
 * and HTTPS. Likewise an inspect of the parent that fails with anything other
 * than a 404 is treated as "don't know" rather than "gone".
 */
export async function isOrphanedSidecar(docker: Docker, sidecarId: string): Promise<boolean> {
  let parentId: string | null;
  try {
    const info = await docker.getContainer(sidecarId).inspect();
    parentId = netnsParentId(info.HostConfig?.NetworkMode);
  } catch {
    return false; // can't tell → don't touch it
  }
  // Not a netns-sharing container. It carries an egress label but doesn't borrow
  // anyone's namespace, so parent-liveness says nothing about it — leave it be.
  if (!parentId) return false;

  try {
    const parent = await docker.getContainer(parentId).inspect();
    const running = parent.State?.Running;
    // A structurally incomplete inspect (no `State`) is UNCERTAIN, not "stopped".
    // Treating a missing field as a reap signal is how a schema surprise turns
    // into a live session losing its DNS.
    if (typeof running !== "boolean") return false;
    // Parent exists but isn't running (the crash case: the agent container is
    // still there, `Exited`, until the next create removes it by name). The
    // namespace died with the process — the sidecar is dead weight either way.
    return !running;
  } catch (err) {
    // Parent container no longer exists at all → definitively orphaned.
    if (statusCode(err) === 404) return true;
    return false; // any other error → don't know → fail safe
  }
}

/**
 * Reap the egress sidecars belonging to `sessionId` whose netns parent is
 * `deadParentId` **and whose namespace is genuinely dead**.
 *
 * This is the crash-site call (`container-health.ts`'s `die`/`oom` handler).
 * Three conditions, all of them load-bearing:
 *
 *   - **The egress labels**, so the session's compose services, networks, and
 *     volumes survive an agent crash untouched. (This is why the crash path does
 *     not reuse `cleanupSessionDockerResources` — that sweeps every
 *     `shipit-parent-session` child, the user's database volume included.)
 *   - **The dead parent's container id**, because the session id alone is NOT
 *     enough. It is stable across container recreations, so a label-only reap
 *     races the session's own recovery: this function is called fire-and-forget,
 *     and if the session gets reactivated while our `listContainers` is still in
 *     flight (a busy daemon during an OOM storm is exactly when that happens),
 *     the list comes back holding the REPLACEMENT incarnation's sidecars and we
 *     would force-remove them. Matching on the parent id makes the reap
 *     idempotent: the new sidecars have a new parent, so they can never match no
 *     matter how late we land.
 *   - **`isOrphanedSidecar` — the parent is actually not running.** We do NOT
 *     take the event's word for it, and that distinction is the whole point: a
 *     Docker **`oom` event does not mean the container died**. It fires when the
 *     cgroup's OOM killer kills *a process*, and if that process wasn't PID 1 —
 *     e.g. the agent CLI is killed but the session worker survives — the
 *     container keeps running. Reaping on the event alone would tear the resolver
 *     and proxy out from under a live worker, silently killing its DNS and HTTPS.
 *     Checking liveness also disarms the `Actor.ID`-less event shape (older
 *     daemons), where the incarnation guard cannot tell generations apart and
 *     `deadParentId` may resolve to the *current*, healthy container.
 *
 * So: the id says *which* namespace we mean; liveness says whether it's actually
 * gone. Never throws — it's called fire-and-forget from a Docker event handler.
 */
export async function reapSessionEgressSidecars(
  docker: Docker,
  sessionId: string,
  deadParentId: string,
): Promise<number> {
  if (!deadParentId) return 0; // can't scope safely → reap nothing (the boot sweep will)
  const ids = await listEgressSidecars(docker, sessionId);
  let removed = 0;
  for (const id of ids) {
    if (!(await hasNetnsParent(docker, id, deadParentId))) continue;
    // The event told us it died; confirm the namespace is actually gone before
    // destroying anything. `isOrphanedSidecar` fails safe toward keeping.
    if (!(await isOrphanedSidecar(docker, id))) continue;
    if (await removeContainer(docker, id)) removed++;
  }
  if (removed > 0) {
    console.log(
      `[egress-reaper] session ${sessionId}: removed ${removed} sidecar(s) of dead container ${deadParentId.slice(0, 12)}`,
    );
  }
  return removed;
}

/**
 * Does `sidecarId` borrow `parentId`'s network namespace?
 *
 * Fails **safe toward keeping** — an unreadable sidecar answers `false`, so a
 * daemon hiccup can never widen a scoped reap into an unscoped one.
 */
async function hasNetnsParent(docker: Docker, sidecarId: string, parentId: string): Promise<boolean> {
  try {
    const info = await docker.getContainer(sidecarId).inspect();
    return netnsParentId(info.HostConfig?.NetworkMode) === parentId;
  } catch {
    return false;
  }
}

/**
 * Global crash-recovery sweep: remove every egress sidecar whose netns parent is
 * gone or not running, across all sessions.
 *
 * Called once at boot from the disk janitor. This is the backstop for orphans a
 * previous orchestrator process never reaped — it died mid-cleanup, the Docker
 * daemon restarted, the agent container was removed out-of-band. Unlike the
 * boot sweeps keyed on `sessionManager.allIds()`, this one needs no DB
 * cross-reference: parent-liveness is the whole test, so it correctly reaps
 * orphans belonging to sessions that are still very much alive.
 *
 * Never throws. Returns the number of sidecars removed.
 */
export async function reapOrphanEgressSidecars(
  docker: Docker,
  opts: { paceMs?: number } = {},
): Promise<number> {
  const ids = await listEgressSidecars(docker);
  let removed = 0;
  for (const id of ids) {
    if (!(await isOrphanedSidecar(docker, id))) continue;
    if (await removeContainer(docker, id)) {
      removed++;
      console.log(`[egress-reaper] removed orphan sidecar ${id.slice(0, 12)} (netns parent gone)`);
    }
    if (opts.paceMs) await new Promise((r) => setTimeout(r, opts.paceMs));
  }
  return removed;
}
