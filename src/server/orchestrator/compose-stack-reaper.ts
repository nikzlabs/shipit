/**
 * docs/290 — reap the per-session Compose stacks that outlived the orchestrator
 * process that started them.
 *
 * ## What was actually true
 *
 * Three places in this repository asserted that a clean shutdown takes every
 * stack down on the way out (`shutdown-manager.ts`, `restart-turn-reattach.ts`,
 * `deployment/vps/deploy.sh`). It does not. `disposeAll` fires each runner's
 * `disposed` handler, which calls `trackComposeStop` — *fire-and-forget* — and
 * the docs/284 sweep for runner-less stacks right below it is `void mgr.stop()`.
 * Nothing awaits `composeStopPromises`; the hook closes the DB and returns,
 * `process.exit(0)` follows, and the `docker compose up -d` that performs the
 * update removes the orchestrator container, killing every in-flight
 * `compose down` child with it. Net effect: **every stack survives every
 * update.** Production carried 23 such stacks across seven orchestrator
 * recreations, four of them spinning a `vite` dev server at 100% CPU for days.
 *
 * And nothing afterwards can see them. `serviceManagers` is process-local and is
 * never rebuilt from Docker, so the idle enforcer's tier 2, `reclaimToLight`'s
 * fallback and the shutdown sweep all key off a map that no longer mentions the
 * stack. It is unroutable too — `preview-proxy.ts:947` resolves a service port
 * through that same map — so it serves nobody while holding memory and CPU until
 * someone happens to reopen the session.
 *
 * This module is the reconciliation those paths assumed already existed: at
 * boot, enumerate what Docker actually has and take down every stack no live
 * session can route to (req 1).
 *
 * ## Why by Docker label, not `docker compose down`
 *
 * Two reasons, and the second is the sharp one.
 *
 *  - **The config files may be gone.** A `light → evicted` session's workspace
 *    is wiped, taking its `docker-compose.yml` with it, so no `-f` is available.
 *  - **`shipit-parent-session` is too wide a net.** The Tier B resolver and
 *    Tier C SNI proxy (docs/172) carry that label so destroy-time cleanup reaps
 *    them, and they share the *agent* container's network namespace. A session
 *    whose agent container survived the restart still needs them: reaping by
 *    parent-session would leave a live agent with no DNS and no HTTPS — the same
 *    mistake `ComposeCli.killStaleContainers` already has an incarnation-aware
 *    keep-list for. `com.docker.compose.project` is set by Compose itself and by
 *    nothing else here, so it names exactly the stack and nothing around it.
 *
 * **Volumes are never removed on this path.** A `light` session keeps its
 * overlay for a warm resume (docs/183); only the tier ladder decides a volume's
 * fate, and it does so with `removeVolumes` at its own rungs.
 */

import type Docker from "dockerode";
import type { SessionManager } from "./sessions.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import { holdsActiveReservation } from "./sessions.js";
import { getMessage, sleep } from "./disk-utils.js";

/** Compose's own project label. Set by `docker compose`, never by us. */
export const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";

/** The label every generated service carries (`compose-generator.ts`). */
export const PARENT_SESSION_LABEL = "shipit-parent-session";

/**
 * The compose project name for a session — the single source of truth, shared
 * with {@link ComposeCli.args}, which passes it as `-p`.
 *
 * It is derived from the session id rather than stored, which is what makes a
 * teardown possible for a stack this process never started: the name is
 * reproducible from the session row alone, with no compose file and no live
 * manager.
 */
export function composeProjectName(sessionId: string): string {
  return `shipit-${sessionId.slice(0, 12)}`;
}

/**
 * Take down one session's Compose stack by project label: stop and remove every
 * container in the project, then remove the project's networks. Volumes are
 * deliberately left alone (see the module docstring).
 *
 * Equivalent to `docker compose -p <project> down --remove-orphans` — matching
 * on the project label reaches every container in the project, so there are no
 * "orphans" to distinguish. Returns how many containers it removed.
 *
 * **It THROWS when it cannot establish that the containers are gone**, and that
 * is the whole contract: `light → evicted` calls this immediately before wiping
 * the workspace, and a best-effort teardown that swallowed a failure would hand
 * that rung a "done" it has no evidence for — recreating the very defect
 * (a wipe under a live, mounted service) this exists to prevent. Only container
 * teardown is load-bearing that way; a network that will not go is logged and
 * ignored, since a network holds no mount.
 */
export async function downComposeStackByProject(
  docker: Docker,
  sessionId: string,
): Promise<number> {
  const project = composeProjectName(sessionId);
  const label = `${COMPOSE_PROJECT_LABEL}=${project}`;
  let removed = 0;

  // Not wrapped: a listing we could not perform is "we don't know what is
  // running", which must reach the caller as a failure rather than as an empty
  // stack.
  const containers = await docker.listContainers({
    all: true,
    filters: { label: [label] },
  });
  for (const ci of containers) {
    try {
      const container = docker.getContainer(ci.Id);
      if (ci.State === "running") await container.stop({ t: 5 });
      await container.remove({ force: true });
      removed += 1;
    } catch (err) {
      const code = err && typeof err === "object" && "statusCode" in err
        ? (err as { statusCode: number }).statusCode
        : 0;
      // 304 already stopped, 409 removal in progress, 404 already gone — all
      // the outcome we wanted, and all routine when a concurrent teardown is
      // racing us for the same stack. Anything else means this container may
      // still be running with the workspace mounted.
      if (code !== 304 && code !== 409 && code !== 404) {
        throw new Error(
          `compose teardown of ${project} could not remove ${ci.Id.slice(0, 12)}: ${getMessage(err)}`,
          { cause: err },
        );
      }
    }
  }

  // After the containers, never before: a network with an attached container
  // cannot be removed, and the failure would be indistinguishable from "it was
  // already gone".
  try {
    const networks = await docker.listNetworks({ filters: { label: [label] } });
    for (const ni of networks ?? []) {
      try {
        await docker.getNetwork(ni.Id).remove();
      } catch (err) {
        console.warn(`[compose-reap] failed to remove network ${ni.Name} of ${project}:`, getMessage(err));
      }
    }
  } catch (err) {
    console.warn(`[compose-reap] network listing failed for ${project}:`, getMessage(err));
  }

  return removed;
}

export interface ComposeStackReapDeps {
  docker: Docker;
  sessionManager: SessionManager;
  runnerRegistry: SessionRunnerRegistry;
  /**
   * Live compose stacks this process owns, keyed by session id — the same map
   * the WS layer and `preview-proxy.ts` read. Membership is the whole test: a
   * stack in here is routable and owned, so it is not this sweep's business.
   */
  serviceManagers: Map<string, unknown>;
  /**
   * docs/288 — sessions whose `/agent/status` probe failed during the boot
   * adoption sweep. Their container is still running and may still hold a live
   * turn, so "no runner" does NOT mean "idle" for them, and a live turn's
   * preview must not be pulled out from under it.
   */
  unprobed?: ReadonlySet<string>;
  /**
   * Pause between teardowns, for the same reason every other boot sweep paces:
   * a burst of stop/remove calls contends with the Docker daemon a concurrent
   * agent start needs. Defaults to `0` so unit tests pay no wall-clock.
   */
  paceMs?: number;
}

/** Why a surviving stack is being kept, or `null` when it is reapable. */
function holdReason(sessionId: string, deps: ComposeStackReapDeps): string | null {
  // Untracked: the session row is gone, so this is an ORPHAN and
  // `cleanupOrphanComposeResources` (app-lifecycle.ts, earlier in the same
  // boot) owns it — including its volumes, which that path is allowed to reap
  // and this one is not.
  const session = deps.sessionManager.get(sessionId);
  if (!session) return "its session is no longer tracked (the orphan sweep owns it)";
  // This process started or adopted it, so it is routable and owned. The warm
  // pool's pre-started preview (docs/288) is the case that makes this necessary
  // rather than merely defensive: it has a manager and no runner.
  if (deps.serviceManagers.has(sessionId)) return "this process already owns its stack";
  // A runner means the boot adoption sweep took its turn, or a reserved preview
  // was restored, or a viewer is already attached. Any of those will drive the
  // stack through the ordinary paths.
  if (deps.runnerRegistry.get(sessionId)) return "its session has a live runner";
  if (deps.unprobed?.has(sessionId)) return "its worker never answered the boot probe, so it may hold a live turn";
  // docs/241 — an always-on reservation promises the preview stays up "across
  // viewer disconnects, idle cleanup, memory-pressure eviction, and orchestrator
  // restarts". `restoreReservedPreviews` is what makes good on the last of
  // those, and it runs by creating a runner that rebuilds the stack; reaping
  // here would only race it. `holdsActiveReservation`, not the raw flag — an
  // archived row carrying a stale flag holds nothing.
  //
  // Deliberately NOT extended to a PINNED session (docs/110). A pin protects a
  // session's disk from automatic reclaim; it says nothing about previews, and
  // an unroutable stack burning a CPU core is not something a pin promised to
  // keep.
  if (holdsActiveReservation(session)) return "its session holds an always-on preview reservation";
  return null;
}

/**
 * Boot reconciliation: take down every per-session Compose stack that survived
 * the previous orchestrator process and that no live session can route to
 * (docs/290 req 1).
 *
 * **Call it after the boot adoption sweep and after `restoreReservedPreviews`.**
 * Both create runners, and "has a runner" is this sweep's main keep signal — run
 * it earlier and it would reap the stack of a session that was about to get one.
 *
 * Never rejects. Returns the number of stacks taken down.
 */
export async function reapSurvivingComposeStacks(
  deps: ComposeStackReapDeps,
): Promise<number> {
  // Both labels, and the pairing is the point: `com.docker.compose.project`
  // says "this is a compose stack" (excluding the egress sidecars, which carry
  // only the parent label), and `shipit-parent-session` says WHOSE — the
  // project name holds a 12-char prefix, which cannot be turned back into a
  // session id.
  let containers;
  try {
    containers = await deps.docker.listContainers({
      all: true,
      filters: { label: [PARENT_SESSION_LABEL, COMPOSE_PROJECT_LABEL] },
    });
  } catch (err) {
    console.warn("[compose-reap] listing surviving compose stacks failed:", getMessage(err));
    return 0;
  }

  const sessionIds = new Set<string>();
  for (const ci of containers) {
    const sessionId = ci.Labels?.[PARENT_SESSION_LABEL];
    if (!sessionId) continue;
    // The two labels must agree. A repository's own compose file can set
    // `shipit-parent-session` on a service (Compose merges maps, and the
    // generated override cannot un-declare a key the project file wrote), so
    // this is what stops one session's stack naming another's as its parent and
    // getting it torn down.
    if (ci.Labels?.[COMPOSE_PROJECT_LABEL] !== composeProjectName(sessionId)) continue;
    sessionIds.add(sessionId);
  }
  if (sessionIds.size === 0) return 0;

  const paceMs = deps.paceMs ?? 0;
  let reaped = 0;
  for (const sessionId of sessionIds) {
    const hold = holdReason(sessionId, deps);
    if (hold) {
      console.log(`[compose-reap] Keeping the surviving stack for ${sessionId} — ${hold}`);
      continue;
    }
    await sleep(paceMs);
    // Re-check immediately before the teardown: the sweep is paced and
    // fire-and-forget, so a viewer can attach — creating a runner and a manager
    // — while we are working through the list.
    const late = holdReason(sessionId, deps);
    if (late) {
      console.log(`[compose-reap] Keeping the surviving stack for ${sessionId} — ${late}`);
      continue;
    }
    try {
      const removed = await downComposeStackByProject(deps.docker, sessionId);
      reaped += 1;
      console.log(
        `[compose-reap] Took down the surviving compose stack for ${sessionId}`
        + ` (${removed} container(s); it outlived the orchestrator that started it and`
        + ` nothing could route to it)`,
      );
    } catch (err) {
      // One stack we could not take down must not stop the rest — and the next
      // boot gets another go at it.
      console.warn(`[compose-reap] failed to take down the stack for ${sessionId}:`, getMessage(err));
    }
  }
  return reaped;
}
