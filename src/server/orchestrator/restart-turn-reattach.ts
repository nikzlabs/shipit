/**
 * Post-restart turn reattach (docs/240).
 *
 * Session containers outlive the orchestrator process. When the orchestrator
 * crashes or is redeployed while agents are mid-turn, `rediscoverContainers`
 * brings the containers back into the map — but nothing brings the *turns*
 * back: a runner is only created lazily, when a viewer attaches. Until someone
 * opens the session, the CLI keeps working inside the container with no
 * orchestrator listening, and every event it emits ages out of the worker's
 * bounded SSE ring buffer unread. The turn's transcript tail is lost and the
 * post-turn commit / auto-push / PR card never fire.
 *
 * This sweep closes that window at boot: it asks each rediscovered container
 * whether it still has a turn in flight and, for those that do, materializes
 * the runner immediately. Runner creation runs the identical path a viewer
 * attach would.
 *
 * It has a second job (docs/242): **reclaim** a stale idle worker, so an update
 * actually frees the memory its predecessors were holding and the user stops
 * meeting the "Update available for this session" banner on sessions they open
 * afterwards. Current (and unknown-build) workers are never touched, and a
 * worker with a live turn is always adopted, never reclaimed.
 *
 * Two things this sweep deliberately does NOT do:
 *
 *  - **It does not recreate the container.** Nobody is attached at boot, so
 *    spending the RAM straight back on a session no viewer has opened defeats
 *    the point. The lazy viewer-attach path (`activateSession` →
 *    `materializeRunner` → `getOrCreate`) cold-starts a fresh container on the
 *    current image the moment the user opens the session, and
 *    `container_started` then re-sends `session_container_freshness` as
 *    `current`, so the banner never appears.
 *  - **It does not touch the session's Compose stack** — see
 *    {@link reattachInFlightTurns} for why.
 *
 * It is NOT the steady-state reclaim path. `idle-enforcer.ts` owns that, driven
 * by the docs/284 memory budget; this one fires once per boot and is driven by
 * worker staleness alone.
 */

import type { SessionContainerManager } from "./session-container.js";
import type { SessionRunnerInterface, SessionRunnerRegistry } from "./session-runner.js";
import type { SessionManager } from "./sessions.js";
import { holdsActiveReservation } from "./sessions.js";
import type { AgentId, WorkerAgentStatus } from "../shared/types.js";
import { workerGet } from "./worker-http.js";
import { getErrorMessage } from "./validation.js";
import { getContainerFreshness } from "./container-freshness.js";

export interface ReattachDeps {
  containerManager: SessionContainerManager | null;
  runnerRegistry: SessionRunnerRegistry;
  sessionManager: SessionManager;
  defaultAgentId: AgentId;
  orchestratorBuildId?: string;
}

/**
 * Probe timeout per container. Short: a worker that can't answer in a couple of
 * seconds at boot is either wedged or gone, and either way the lazy
 * viewer-attach path will retry the same probe later.
 */
const PROBE_TIMEOUT_MS = 3000;

/**
 * Why this stale worker must be kept, or `null` when it is idle and reclaimable.
 *
 * A reason rather than a boolean because the incident this sweep answers cost a
 * day of diagnosis: the logs said 35 containers were stale and 4 were rotated,
 * and nothing said what held the other 31 — the cause (`status.running === true`)
 * had to be established by elimination. Every hold is now named in the log.
 *
 * Every clause reads a POSITIVE report from the worker, never an absence — an
 * image that predates a field says nothing about it, so silence must not be read
 * as "idle" for the field that gates a live turn.
 *
 * `status.running` is deliberately not consulted. It means "a backend process
 * occupies the single agent slot", which for a Claude worker under live steering
 * is the steady state *between* turns — and reading it as "busy" is exactly what
 * held those 31 containers (25.3 GiB) through a production update on 2026-09-02.
 * `turnActive` is the field that means work in flight.
 */
function staleIdleHoldReason(status: WorkerAgentStatus): string | null {
  // `=== false`, not `!== true`: a legacy worker predating docs/240 omits the
  // field entirely, and "unknown" has to keep the conservative answer or a turn
  // running on such an image would be destroyed mid-flight.
  if (status.turnActive !== false) {
    return "the worker predates docs/240 and does not report turn liveness";
  }
  // docs/235 — the two ways a worker is busy WITHOUT an orchestrator-started
  // turn. Both are absent from a worker built before docs/242, where they
  // degrade to `0`/`false`: that is the same blindness this sweep already had,
  // and it lasts exactly one deploy per container. Treating their absence as
  // "unknown" instead would deadlock the fix — every container in flight today
  // predates the fields, so nothing would ever be reclaimable again.
  if (status.selfWakeActive === true) return "a self-woken turn is in flight";
  const tasks = status.backgroundTaskCount ?? 0;
  if (tasks > 0) return `${tasks} background task(s) still outstanding`;
  return null;
}

/**
 * Reattach every rediscovered container that still has a turn in flight, and
 * reclaim the stale idle ones. Returns the number of turns adopted. Never
 * throws — a failure on one session must not block boot or affect the others.
 *
 * **Why the Compose stack survives the reclaim.** The staleness this sweep acts
 * on belongs to ShipIt's own worker image; a project's Compose services run the
 * user's images and an update does not make them old. Keeping them is also the
 * only safe option: the full teardown (`containerManager.destroy`) removes the
 * session's `shipit-parent-session` volumes along with its containers, so a
 * boot-time memory sweep that used it would delete a session's database on every
 * deploy. That leaves docs/284 tier 1's split — drop the agent container, keep
 * the preview — which is the same trade this sweep wants, and it means a session
 * the user opens right after an update still has its preview.
 *
 * Known limit, carried deliberately: a stack orphaned here is not a docs/284
 * **tier 2** candidate, because tier 2 only considers stacks *tier 1* orphaned
 * (`tier1At`). So a preview left running by this sweep holds its memory until
 * the user next opens the session, which makes it tier-1 eligible again. That is
 * still a large net win — agent containers were 25.3 GiB of the 30.5 GiB
 * measured in the incident, previews 5.0 GiB — and closing it means teaching the
 * enforcer about a second source of orphans, which is its own change.
 */
export async function reattachInFlightTurns(deps: ReattachDeps): Promise<number> {
  const {
    containerManager, runnerRegistry, sessionManager, defaultAgentId,
    orchestratorBuildId = process.env.SHIPIT_BUILD_ID,
  } = deps;
  if (!containerManager) return 0;

  const candidates = containerManager.getAll().filter((c) => {
    if (c.status !== "running") return false;
    // A standby container has never been claimed by a session, so it cannot
    // have a user turn in flight.
    if (containerManager.isStandby(c.sessionId)) return false;
    const session = sessionManager.get(c.sessionId);
    return !!session?.workspaceDir && !session.archived;
  });
  if (candidates.length === 0) return 0;

  const results = await Promise.all(
    candidates.map(async (c) => {
      let status: WorkerAgentStatus;
      try {
        status = await workerGet(c.workerUrl, "/agent/status", { timeoutMs: PROBE_TIMEOUT_MS }) as WorkerAgentStatus;
      } catch (err) {
        console.warn(
          `[turn-reattach] /agent/status probe failed for ${c.sessionId}: ${getErrorMessage(err)}`,
        );
        return false;
      }
      const session = sessionManager.get(c.sessionId);
      if (!session?.workspaceDir) return false;
      if (status.turnActive !== true) {
        const freshness = getContainerFreshness(c.workerBuildId, orchestratorBuildId);
        // docs/242 — never touch a worker that matches this build, and never one
        // whose build cannot be established (a custom/unlabeled image must not
        // be reclaimed on every boot forever). Silent: this is the common case.
        if (freshness.state !== "stale") return false;
        // docs/241-keep-preview-running — an always-on reservation is a
        // user-facing guarantee, so it wins over reclaim, exactly as it does in
        // the idle enforcer. `holdsActiveReservation`, not the raw flag.
        const hold = holdsActiveReservation(session)
          ? "the session holds an always-on preview reservation"
          : staleIdleHoldReason(status);
        if (hold) {
          console.log(`[worker-reclaim] Keeping stale container for ${c.sessionId} — ${hold}`);
          return false;
        }
        try {
          // A bootstrap subsystem may have materialized a runner already (a
          // delivery redispatch, an early viewer). planning#298's ordering
          // applies: ask the runner to dispose FIRST and treat a refusal as
          // "leave this container alone", so the runner-level guards and this
          // sweep can never disagree about whether the session is reclaimable.
          const existingRunner = runnerRegistry.get(c.sessionId);
          if (existingRunner) {
            if (existingRunner.agentBusy || existingRunner.viewerCount > 0) return false;
            const preserving = existingRunner as SessionRunnerInterface
              & { preserveComposeOnDispose: boolean };
            preserving.preserveComposeOnDispose = true;
            runnerRegistry.dispose(c.sessionId);
            if (!existingRunner.disposed) {
              // Do not leave a stale preserve flag on a runner that survived:
              // the next, unrelated dispose would skip its compose teardown.
              preserving.preserveComposeOnDispose = false;
              console.log(
                `[worker-reclaim] Keeping stale container for ${c.sessionId}`
                + ` — its runner declined disposal (still holds live work)`,
              );
              return false;
            }
          }
          // `destroyAgentContainer`, never `destroy`: the latter is the full
          // session teardown and sweeps every `shipit-parent-session` child —
          // including the session's Compose **volumes**, i.e. a project's
          // database. A memory sweep must never delete user data, so the stack
          // is preserved and stays serving. Reasoning in full:
          // docs/242-stale-session-container-indicator/plan.md.
          await containerManager.destroyAgentContainer(c.sessionId);
          console.log(
            `[worker-reclaim] Destroyed stale idle agent container for ${c.sessionId}`
            + ` (no viewer at boot; a fresh one starts on the current image when the session is opened)`,
          );
        } catch (err) {
          console.error(
            `[worker-reclaim] failed to reclaim stale idle container for ${c.sessionId}: ${getErrorMessage(err)}`,
          );
        }
        return false;
      }

      // A bootstrap subsystem may already have materialized the runner. It
      // already owns the live turn, so there is nothing for this sweep to adopt.
      if (runnerRegistry.get(c.sessionId)) return false;
      try {
        const runner = runnerRegistry.getOrCreate(
          c.sessionId,
          session.workspaceDir,
          session.agentId ?? defaultAgentId,
        );
        // Container runners adopt the live turn inside this call; an in-process
        // runner has no `resumeInFlightTurn` (it cannot outlive the process).
        return (await runner.resumeInFlightTurn?.()) ?? false;
      } catch (err) {
        console.error(
          `[turn-reattach] failed to reattach ${c.sessionId}: ${getErrorMessage(err)}`,
        );
        return false;
      }
    }),
  );

  const adopted = results.filter(Boolean).length;
  if (adopted > 0) {
    console.log(`[turn-reattach] Reattached ${adopted} in-flight agent turn(s) from the previous run`);
  }
  return adopted;
}
