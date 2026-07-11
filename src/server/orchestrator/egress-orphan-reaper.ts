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
 *     `die`/`oom` handler for one session. Deliberately targeted at the egress
 *     labels: an agent OOM must NOT take down the user's compose services,
 *     networks, or volumes, so this is emphatically *not*
 *     `cleanupSessionDockerResources`.
 *   - {@link reapOrphanEgressSidecars} — **crash-recovery backstop at boot.**
 *     A global parent-liveness sweep for the orphans a *previous* orchestrator
 *     process never got to reap (it died mid-cleanup, the Docker daemon
 *     restarted, someone `docker rm`'d the agent by hand). Boot-only, per
 *     CLAUDE.md's disk-cleanup rule: this leak grows on the crash clock, not the
 *     wall clock, so a periodic timer would mostly burn cycles finding nothing.
 *
 * The liveness test is what makes the sweep **incarnation-aware**, and that
 * matters beyond the crash path: the agent container's name and labels are
 * reused across recreations, so a label-only match ("is this a sidecar for
 * session X?") cannot tell this incarnation's resolver from the corpse of the
 * last one. Asking "is your netns parent actually running?" can. That's the same
 * question `compose-cli.ts`'s stale-sweep keep-list has to answer to avoid
 * sparing a dead sidecar it should be reaping.
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
    // Parent exists but isn't running (the crash case: the agent container is
    // still there, `Exited`, until the next create removes it by name). The
    // namespace died with the process — the sidecar is dead weight either way.
    return !parent.State?.Running;
  } catch (err) {
    // Parent container no longer exists at all → definitively orphaned.
    if (statusCode(err) === 404) return true;
    return false; // any other error → don't know → fail safe
  }
}

/**
 * Reap **every** egress sidecar belonging to `sessionId`, without asking about
 * parent liveness — the caller already knows the parent is dead.
 *
 * This is the crash-site call (`container-health.ts`'s `die`/`oom` handler),
 * where the agent container we're being told about *is* the netns parent. It's
 * scoped to the egress labels on purpose: the session's compose services,
 * networks, and volumes must survive an agent crash untouched.
 *
 * Never throws — it's called fire-and-forget from a Docker event handler.
 */
export async function reapSessionEgressSidecars(docker: Docker, sessionId: string): Promise<number> {
  const ids = await listEgressSidecars(docker, sessionId);
  let removed = 0;
  for (const id of ids) {
    if (await removeContainer(docker, id)) removed++;
  }
  if (removed > 0) {
    console.log(`[egress-reaper] session ${sessionId}: removed ${removed} sidecar(s) after container exit`);
  }
  return removed;
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
