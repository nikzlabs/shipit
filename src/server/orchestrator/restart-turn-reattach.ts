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
 *  - **It does not touch the session's Compose stack.** That is the shutdown
 *    path's job, and it has already done it — see {@link reattachInFlightTurns}.
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
import { sleep } from "./disk-utils.js";

export interface ReattachDeps {
  containerManager: SessionContainerManager | null;
  runnerRegistry: SessionRunnerRegistry;
  sessionManager: SessionManager;
  defaultAgentId: AgentId;
  orchestratorBuildId?: string;
  /**
   * Delay before the reclaim's confirming probe. Defaults to
   * {@link RECLAIM_CONFIRM_DELAY_MS}; unit tests pass 0 so they never pay real
   * wall-clock.
   */
  confirmDelayMs?: number;
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
  // Live work in the container that the agent controller does not own. Both
  // survive the restart and are picked up again when the session is opened, so
  // destroying the container is a real loss rather than a tidy-up.
  if (status.installRunning === true) return "agent.install is still running";
  // Deliberately "a shell exists", not "a shell is doing something" — nothing
  // reports the latter. Erring toward keeping costs the memory of a session
  // where someone opened a terminal and left it; erring the other way kills the
  // build they left running in it. The over-hold is also bounded: a stale
  // container with an idle shell is still an ordinary idle-enforcer candidate
  // once ShipIt is over its memory budget, because `agentBusy` does not count
  // terminals.
  if (status.terminalActive === true) return "a terminal session is running in the container";
  return null;
}

/**
 * Re-probe delay before the destroy, and why a single probe is not enough.
 *
 * docs/235's wire trace has the CLI drain its background-task list at 14503 ms
 * and self-wake at 14504 ms — so for **one millisecond** a worker that is about
 * to start a turn reports no tasks and no self-wake. A probe landing in that gap
 * reads idle, and the reclaim would then kill the turn as it starts. The gap is
 * a property of the CLI's event ordering, not of our timing, so it cannot be
 * argued away.
 *
 * A second probe closes it: `selfWakeActive` stays set for the whole turn, so
 * anything that woke in the window is reporting it by the time this elapses.
 * Long enough to clear a 1 ms ordering gap by three orders of magnitude, short
 * enough that a boot sweep over dozens of containers (all probed in parallel)
 * pays it once.
 */
const RECLAIM_CONFIRM_DELAY_MS = 1000;

/**
 * Reattach every rediscovered container that still has a turn in flight, and
 * reclaim the stale idle ones. Returns the number of turns adopted. Never
 * throws — a failure on one session must not block boot or affect the others.
 *
 * **Why the Compose stack is not this sweep's business.** It reads as the
 * obvious other half of the memory, and it is already owned elsewhere: a clean
 * update takes every stack down on the way OUT (`shutdown-manager.ts` →
 * `disposeAll` → each runner's `disposed` handler → `compose down`, plus
 * docs/284's sweep for the stacks with no runner left), so by the time this
 * sweep runs there is usually no stack to reclaim. A stack that survives —
 * i.e. the orchestrator crashed — is unroutable regardless, because
 * `preview-proxy.ts` resolves a service port through the in-memory
 * `serviceManagers` map that died with the process, and the first attach that
 * rebuilds that map opens `ServiceManager.start()` with `killStaleContainers()`,
 * which force-removes every `shipit-parent-session` container before
 * `compose up`. So such a stack serves nobody and does not survive being
 * opened; it is not a preview being preserved.
 *
 * The narrow residual is a crashed orchestrator's surviving stack, which holds
 * its memory until its session is next opened. Taking it here would need a
 * teardown primitive this module does not have (`containerManager.destroy` is
 * the wrong one — it also reaps the volumes the session created through the
 * Docker API proxy), for the smaller share of the memory: the incident measured
 * 25.3 GiB in agent containers against 5.0 GiB in previews.
 */
export async function reattachInFlightTurns(deps: ReattachDeps): Promise<number> {
  const {
    containerManager, runnerRegistry, sessionManager, defaultAgentId,
    orchestratorBuildId = process.env.SHIPIT_BUILD_ID,
    confirmDelayMs = RECLAIM_CONFIRM_DELAY_MS,
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
          // Confirm before destroying — see RECLAIM_CONFIRM_DELAY_MS. A worker
          // that failed the second probe, or reported work on it, is kept: the
          // reclaim is optional and the next boot will get another chance.
          await sleep(confirmDelayMs);
          let confirm: WorkerAgentStatus;
          try {
            confirm = await workerGet(
              c.workerUrl, "/agent/status", { timeoutMs: PROBE_TIMEOUT_MS },
            ) as WorkerAgentStatus;
          } catch (err) {
            console.log(
              `[worker-reclaim] Keeping stale container for ${c.sessionId}`
              + ` — its confirming probe failed: ${getErrorMessage(err)}`,
            );
            return false;
          }
          if (confirm.turnActive === true) {
            // It woke between the two probes. Leave it: this sweep has already
            // decided not to adopt it, and a turn is never something to destroy.
            console.log(
              `[worker-reclaim] Keeping stale container for ${c.sessionId}`
              + ` — a turn started between the two probes`,
            );
            return false;
          }
          const confirmedHold = staleIdleHoldReason(confirm);
          if (confirmedHold) {
            console.log(
              `[worker-reclaim] Keeping stale container for ${c.sessionId} — ${confirmedHold}`
              + ` (reported on the confirming probe)`,
            );
            return false;
          }
          // A bootstrap subsystem may have materialized a runner already (a
          // delivery redispatch, an early viewer) — re-read it AFTER the delay
          // above, not before. planning#298's ordering applies: ask the runner
          // to dispose FIRST and treat a refusal as "leave this container
          // alone", so the runner-level guards and this sweep can never
          // disagree about whether the session is reclaimable.
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
          // session teardown, which also reaps every volume the SESSION created
          // through the Docker API proxy — data an agent made inside the
          // container, which a memory sweep must not delete. The Compose stack
          // is not this sweep's to take either: the shutdown path already
          // `compose down`s every stack on a clean update, and one that survives
          // a crash is unroutable anyway (`preview-proxy.ts` resolves a service
          // port through the in-memory `serviceManagers` map, which the restart
          // emptied). Reasoning in full:
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
