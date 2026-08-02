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
 * the runner immediately. It also rotates a stale worker whose agent process
 * is stopped, so an update does not require a manual "Restart agent" click.
 * Runner creation runs the identical path a viewer attach would.
 *
 * Current idle workers are left alone. A stale idle worker is the one exception:
 * it is replaced from the newly built image, while Compose services remain
 * untouched. Workers with a live turn are always adopted, never rotated.
 */

import type { SessionContainerManager } from "./session-container.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { SessionManager } from "./sessions.js";
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
 * Reattach every rediscovered container that still has a turn in flight.
 * Returns the number of turns adopted. Never throws — a failure to reattach one
 * session must not block boot or affect the others.
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
    // A runner already exists (nothing to rebuild — it owns its own turn state).
    if (runnerRegistry.get(c.sessionId)) return false;
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
        // `running` describes the resident agent CLI, not the Docker container.
        // Rotate only an authoritatively stopped agent on an older worker. An
        // unknown/legacy status or an idle resident process remains untouched.
        if (status.running || freshness.state !== "stale") return false;
        try {
          await containerManager.destroy(c.sessionId);
          runnerRegistry.getOrCreate(
            c.sessionId,
            session.workspaceDir,
            session.agentId ?? defaultAgentId,
          );
          console.log(`[worker-rotate] Restarting stale idle agent container for ${c.sessionId}`);
        } catch (err) {
          console.error(
            `[worker-rotate] failed to restart stale idle container for ${c.sessionId}: ${getErrorMessage(err)}`,
          );
        }
        return false;
      }

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
