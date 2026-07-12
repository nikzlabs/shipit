/**
 * Egress sidecar orphan reaper (SHI-222).
 *
 * The Tier B resolver and Tier C SNI proxy (docs/172, SHI-90) are long-lived
 * sidecars launched with `NetworkMode: container:<agentContainerId>` — they have
 * no network stack of their own, they *borrow* the agent container's. That makes
 * the agent container their **netns parent**, and it makes them useless the moment
 * it dies: there is no longer anyone in that namespace to resolve DNS for or proxy
 * TLS on behalf of.
 *
 * What Docker leaves behind is not one tidy state. A sidecar whose process dies
 * with the namespace gets restarted (`RestartPolicy: on-failure`, capped at 3),
 * fails to join a dead namespace each time, and settles in `Exited`. But Docker
 * does **not** stop a `container:`-mode joiner just because its parent stopped, so
 * a sidecar can equally strand `Running`, listening on a namespace nobody is in.
 * Either way it is **inert** — no agent remains to send it traffic, so this is a
 * resource leak, not a containment hole — and either way nothing self-removes it.
 * Which is why every reap path here is gated on the **parent's** state and never
 * on the sidecar's own, and why `listEgressSidecars` passes `all: true`.
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
 * **Parent liveness — not the session label, and not the event — is the load-
 * bearing invariant of this module.** Two independent things conspire to make
 * that so:
 *
 *   1. The agent container's name and the session id are both reused across
 *      recreations, so a label-only match ("is this a sidecar for session X?")
 *      cannot tell this incarnation's resolver from the corpse of the last one.
 *      The boot sweep would SPARE a dead sidecar it should reap; a fire-and-forget
 *      crash reap would RACE the session's recovery and delete the REPLACEMENT's
 *      live sidecars out from under a healthy agent.
 *   2. A Docker event is not proof of what it looks like. An `oom` fires when the
 *      cgroup killer kills *a process* — not necessarily PID 1, not necessarily
 *      the container. Trusting it reaps the resolver and proxy out from under a
 *      worker that survived just fine.
 *
 * "Is the namespace I mean actually gone?" is immune to both, and it's the same
 * question `compose-cli.ts`'s stale-sweep keep-list has to answer. The netns
 * parent id names *which* namespace; liveness answers *whether it's gone*. Both
 * appear in every path here, and neither is redundant.
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
 * Docker's `--filter label=` has no OR, so we query once per tier label and union
 * by container id.
 *
 * **`all: true` is load-bearing.** `listContainers` defaults to *running only*,
 * and the orphans we are hunting are by definition the ones whose parent is gone —
 * many of which have already given up and exited (their `RestartPolicy` is
 * `on-failure`, capped at 3, and every retry fails to join a dead namespace).
 * Drop `all` and this module silently finds nothing, forever.
 *
 * **Throws** if Docker is unavailable, and that is deliberate: an empty list and a
 * failed query are the same value but opposite meanings, and conflating them is
 * how a transient blip turns into a permanently leaked container. Callers decide —
 * the crash site retries, the boot sweep gives up until next boot.
 */
async function listEgressSidecars(docker: Docker, sessionId?: string): Promise<string[]> {
  const ids = new Set<string>();
  for (const label of EGRESS_SIDECAR_LABELS) {
    const filter = sessionId ? `${label}=${sessionId}` : label;
    const list = await docker.listContainers({ all: true, filters: { label: [filter] } });
    for (const c of list) ids.add(c.Id);
  }
  return [...ids];
}

/**
 * Force-remove one container. Returns whether it is **confirmed gone**. Never
 * throws.
 *
 * A 404 is confirmation — the container does not exist, which is the postcondition
 * we wanted, however it got there. A **409 is not**: Docker returns it for a
 * removal *conflict* ("removal already in progress"), which says someone else
 * started the job, not that they finished it. If that other removal then fails,
 * counting the 409 as success would retire a sidecar that is still very much
 * there. So 409 is reported as unconfirmed, which makes the crash-site caller
 * retry — and the retry either finds it gone (404 → confirmed) or removes it.
 */
async function removeContainer(docker: Docker, id: string): Promise<boolean> {
  try {
    await docker.getContainer(id).remove({ force: true });
    return true;
  } catch (err) {
    const code = statusCode(err);
    if (code === 404) return true; // already gone — the outcome we wanted
    if (code !== 409) console.warn(`[egress-reaper] failed to remove sidecar ${id.slice(0, 12)}:`, err);
    return false; // 409 = in flight elsewhere, unconfirmed. Anything else = failed.
  }
}

/**
 * The id of the container whose network namespace `sidecarId` borrows, or `null`
 * if it borrows none (`bridge`, a named network, …).
 *
 * **Throws** if the sidecar can't be inspected — "no parent" and "couldn't ask"
 * are different facts and the callers act on them differently.
 */
async function sidecarNetnsParent(docker: Docker, sidecarId: string): Promise<string | null> {
  const info = await docker.getContainer(sidecarId).inspect();
  return netnsParentId(info.HostConfig?.NetworkMode);
}

/**
 * Is `parentId` gone, or present but not running — i.e. is its network namespace
 * dead?
 *
 * The two *answers* fail safe toward keeping: a structurally incomplete inspect
 * (no `State`) is UNCERTAIN, not "stopped". A 404 is the one unambiguous "gone".
 * Anything else **throws** — a transient 500 is not evidence of death, and the
 * caller must not be able to mistake it for one.
 */
async function isParentDead(docker: Docker, parentId: string): Promise<boolean> {
  try {
    const parent = await docker.getContainer(parentId).inspect();
    const running = parent.State?.Running;
    if (typeof running !== "boolean") return false;
    // Parent exists but isn't running (the crash case: the agent container is
    // still there, `Exited`, until the next create removes it by name). The
    // namespace died with the process — the sidecar is dead weight either way.
    // Note a PAUSED container reports `Running: true` — correctly, since it still
    // holds its namespace. See `compose-cli.ts` for the CLI-side counterpart.
    return !running;
  } catch (err) {
    // Parent container no longer exists at all → definitively orphaned.
    if (statusCode(err) === 404) return true;
    throw err; // any other error → we don't know → let the caller decide
  }
}

/**
 * Is this sidecar sharing a namespace that no longer exists?
 *
 * A sidecar that borrows nobody's namespace answers `false` — it carries an
 * egress label but parent-liveness says nothing about it, so leave it be.
 *
 * This is the **per-sidecar fail-safe boundary** used by the boot sweep: any
 * Docker error while deciding answers "not orphaned", so one unreadable container
 * neither reaps something live nor aborts the sweep over the others. A false keep
 * costs an inert container the next boot collects; a false reap costs a running
 * session its DNS and HTTPS.
 */
export async function isOrphanedSidecar(docker: Docker, sidecarId: string): Promise<boolean> {
  try {
    const parentId = await sidecarNetnsParent(docker, sidecarId);
    if (!parentId) return false;
    return await isParentDead(docker, parentId);
  } catch {
    return false; // can't tell → don't touch it
  }
}

/**
 * Reap the egress sidecars belonging to `sessionId` whose netns parent is
 * `deadParentId` — **once we've confirmed that parent is genuinely down**.
 *
 * This is the crash-site call (`container-health.ts`'s `die`/`oom` handler), and
 * it is called **fire-and-forget on every agent `die`/`oom` event**, before that
 * handler decides whether the event is one it wants to act on. Three conditions,
 * each doing a different job:
 *
 *   - **The egress labels** bound the blast radius, so the session's compose
 *     services, networks, and volumes survive an agent crash untouched. (This is
 *     why the crash path does not reuse `cleanupSessionDockerResources` — that
 *     sweeps every `shipit-parent-session` child, the user's database volume
 *     included. An agent OOM must not cost them their data.)
 *
 *   - **Parent liveness is the safety guard** — the one thing standing between
 *     this function and a live session losing its DNS and HTTPS. We do NOT take
 *     the event's word for it, because a Docker **`oom` event does not mean the
 *     container died**: it fires when the cgroup's OOM killer kills *a process*,
 *     and if that process wasn't PID 1 — the agent CLI is killed, the session
 *     worker survives — the container keeps running with a perfectly healthy
 *     namespace. The same check disarms the `Actor.ID`-less event shape (older
 *     daemons), where `deadParentId` falls back to the tracked `sc.id` and may
 *     name the *current*, healthy container.
 *
 *     It is also what lets the caller invoke this unconditionally, which it must:
 *     a PID-1 OOM emits `oom` (parent still `Running` → we decline) and then
 *     `die` (parent down → we reap). Only the second event is proof, and by then
 *     the session's container-map entry is gone — so the reap cannot live behind
 *     the handler's `if (!sc) return`.
 *
 *   - **The dead parent's container id** scopes *which* namespace we mean.
 *     Belt-and-braces rather than the primary guard — liveness alone would spare
 *     a replacement incarnation, since its parent is running — but it makes the
 *     reap idempotent by construction instead of by timing: the session id is
 *     stable across recreations, so a label-only reap that lands late (a busy
 *     daemon during an OOM storm) would come back holding the REPLACEMENT's
 *     sidecars and have to *reason* its way to sparing them. Matching the parent
 *     id means they never enter the candidate set at all. Don't remove it because
 *     a test still passes without it.
 *
 * So: the id says *which* namespace we mean; liveness says whether it's actually
 * gone. Never throws — it's called fire-and-forget from a Docker event handler.
 *
 * **Retries on a Docker error**, because this is the crash path's only shot. The
 * same handler pass that fires this reap deletes the session's container-map
 * entry, which LATCHES the leak — after that, no `destroyContainer` will ever
 * sweep. So a transient daemon blip here (an OOM storm is exactly when the daemon
 * is least responsive) would strand the sidecars until the next orchestrator boot,
 * which on a manually-deployed box may be a very long time. Retrying is safe
 * precisely because the reap is id-scoped and liveness-gated: however late an
 * attempt lands, it can only ever match the dead parent's own sidecars.
 */
const REAP_ATTEMPTS = 3;
const REAP_BACKOFF_MS = 2_000;

export async function reapSessionEgressSidecars(
  docker: Docker,
  sessionId: string,
  deadParentId: string,
  opts: { attempts?: number; backoffMs?: number } = {},
): Promise<number> {
  if (!deadParentId) return 0; // can't scope safely → reap nothing (the boot sweep will)

  const attempts = opts.attempts ?? REAP_ATTEMPTS;
  const backoffMs = opts.backoffMs ?? REAP_BACKOFF_MS;

  let removed = 0;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let unresolved: number;
    try {
      const pass = await reapOnce(docker, sessionId, deadParentId);
      removed += pass.removed;
      unresolved = pass.unresolved;
      if (unresolved === 0) return removed; // everything accounted for
      lastErr = undefined; // this pass DID answer — attempt 1's error must not outlive it
    } catch (err) {
      // Couldn't even list, or couldn't decide whether the parent is dead. We know
      // nothing this pass — which is not the same as "there is nothing".
      lastErr = err;
      unresolved = -1;
    }

    if (attempt === attempts) {
      console.warn(
        `[egress-reaper] session ${sessionId}: gave up after ${attempt} attempts with sidecars of ${deadParentId.slice(0, 12)} unaccounted for; the boot sweep will collect them:`,
        lastErr ?? `${unresolved} unresolved`,
      );
      return removed;
    }
    // unref'd, like this codebase's other timers: a pending backoff must not hold
    // the process open through shutdown. Racing a teardown is already safe
    // (id-scoped, liveness-gated, 404/409-tolerant) — this is exit hygiene only.
    await new Promise((r) => {
      setTimeout(r, backoffMs * attempt).unref?.();
    });
  }
  return removed;
}

/**
 * One reap pass.
 *
 * Reports what it removed and how many sidecars it could NOT account for, rather
 * than aborting on the first bad one. That matters: if inspecting the resolver
 * 500s while the proxy is a clean orphan, an abort-on-first-error would bail
 * before ever reaching the proxy — and since every retry re-lists in the same
 * order, it would hit the same wall each time and remove *nothing*. One sick
 * container must not starve its siblings.
 *
 * `unresolved > 0` is the caller's cue to retry. It throws only when it learned
 * nothing at all (the list failed, or the parent's liveness is unknowable), which
 * is different from "there is nothing here".
 */
async function reapOnce(
  docker: Docker,
  sessionId: string,
  deadParentId: string,
): Promise<{ removed: number; unresolved: number }> {
  const ids = await listEgressSidecars(docker, sessionId); // throws → we know nothing → retry
  const ours: string[] = [];
  let unresolved = 0;

  for (const id of ids) {
    try {
      if ((await sidecarNetnsParent(docker, id)) === deadParentId) ours.push(id);
    } catch {
      unresolved++; // can't tell whose namespace it borrows — look again next pass
    }
  }
  if (ours.length === 0) return { removed: 0, unresolved };

  // Every candidate shares one parent, so this is a single probe. The event told us
  // it died; confirm the namespace is actually gone before destroying anything. A
  // throw here means "don't know" — never "dead".
  if (!(await isParentDead(docker, deadParentId))) return { removed: 0, unresolved };

  let removed = 0;
  for (const id of ours) {
    if (await removeContainer(docker, id)) removed++;
    else unresolved++; // genuinely failed, or a 409 we can't confirm
  }
  if (removed > 0) {
    console.log(
      `[egress-reaper] session ${sessionId}: removed ${removed} sidecar(s) of dead container ${deadParentId.slice(0, 12)}`,
    );
  }
  return { removed, unresolved };
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
  let ids: string[];
  try {
    ids = await listEgressSidecars(docker);
  } catch (err) {
    // Docker unavailable. Nothing to reap and nothing to panic about — this is the
    // backstop, so the worst case is that the orphans wait for the next boot.
    console.warn("[egress-reaper] could not list egress sidecars:", err);
    return 0;
  }
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
