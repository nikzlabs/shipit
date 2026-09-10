import type Docker from "dockerode";
import type { SessionManager } from "./sessions.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import { holdsActiveReservation } from "./sessions.js";
import { getMessage, sleep } from "./disk-utils.js";
import { serializeStackOp } from "./stack-op-queue.js";

export const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";
export const PARENT_SESSION_LABEL = "shipit-parent-session";

export function composeProjectName(sessionId: string): string {
  return `shipit-${sessionId.slice(0, 12)}`;
}

/** Caller must hold the session's stack queue. Preserves volumes. */
export async function downComposeStackByProject(
  docker: Docker,
  sessionId: string,
): Promise<number> {
  const project = composeProjectName(sessionId);
  const label = `${COMPOSE_PROJECT_LABEL}=${project}`;
  const list = (): Promise<{ Id: string; State?: string }[]> =>
    docker.listContainers({ all: true, filters: { label: [label] } });
  let removed = 0;

  const containers = await list();
  for (const ci of containers) {
    const container = docker.getContainer(ci.Id);
    if (ci.State === "running") {
      try {
        await container.stop({ t: 5 });
      } catch {
        // Still attempt removal if stop fails or reports an already stopped container.
      }
    }
    try {
      await container.remove({ force: true });
      removed += 1;
    } catch (err) {
      const code = err && typeof err === "object" && "statusCode" in err
        ? (err as { statusCode: number }).statusCode
        : 0;
      if (code !== 404 && code !== 409) {
        throw new Error(
          `compose teardown of ${project} could not remove ${ci.Id.slice(0, 12)}: ${getMessage(err)}`,
          { cause: err },
        );
      }
    }
  }

  // A 409 means removal is in progress; confirm absence before allowing a workspace wipe.
  if (containers.length > 0) {
    const left = await list();
    if (left.length > 0) {
      throw new Error(
        `compose teardown of ${project} left ${left.length} container(s) in place `
        + `(${left.map((c) => c.Id.slice(0, 12)).join(", ")})`,
      );
    }
  }

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
  serviceManagers: Map<string, unknown>;
  // Missing runners do not prove these workers are idle.
  unprobed?: ReadonlySet<string>;
  liveWork?: ReadonlySet<string>;
  paceMs?: number;
}

function holdReason(sessionId: string, deps: ComposeStackReapDeps): string | null {
  const session = deps.sessionManager.get(sessionId);
  if (!session) return "its session is no longer tracked (the orphan sweep owns it)";
  if (deps.serviceManagers.has(sessionId)) return "this process already owns its stack";
  if (deps.runnerRegistry.get(sessionId)) return "its session has a live runner";
  if (deps.unprobed?.has(sessionId)) return "its worker never answered the boot probe, so it may hold a live turn";
  if (deps.liveWork?.has(sessionId)) return "the boot adoption sweep kept its worker for live work it did not adopt";
  if (holdsActiveReservation(session)) return "its session holds an always-on preview reservation";
  return null;
}

/** Run after boot adoption and reserved preview restoration have created their runners. */
export async function reapSurvivingComposeStacks(
  deps: ComposeStackReapDeps,
): Promise<number> {
  // Both labels exclude agent egress sidecars and identify the full session ID.
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
    // A repository can supply a parent label; require it to match the Compose project.
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
    try {
      // Recheck inside the queue so activation cannot create a stack between the check and removal.
      const outcome = await serializeStackOp(sessionId, async () => {
        const late = holdReason(sessionId, deps);
        if (late) return late;
        return await downComposeStackByProject(deps.docker, sessionId);
      });
      if (typeof outcome === "string") {
        console.log(`[compose-reap] Keeping the surviving stack for ${sessionId} — ${outcome}`);
        continue;
      }
      reaped += 1;
      console.log(
        `[compose-reap] Took down the surviving compose stack for ${sessionId}`
        + ` (${outcome} container(s); it outlived the orchestrator that started it and`
        + ` nothing could route to it)`,
      );
    } catch (err) {
      console.warn(`[compose-reap] failed to take down the stack for ${sessionId}:`, getMessage(err));
    }
  }
  return reaped;
}
