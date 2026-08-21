import type { AgentId } from "../shared/types.js";

/**
 * Bring a runner's agent id in line with its session's persisted one, and
 * return the id the caller should actually use for this turn.
 *
 * **Why this exists.** `SessionRunnerRegistry.getOrCreate` uses its
 * `defaultAgentId` argument ONLY when it constructs a runner — an existing,
 * non-disposed runner is returned as-is (`session-runner.ts`). So a caller that
 * correctly passes `session.agentId ?? defaultAgentId` still gets a runner
 * carrying the *global default* whenever one was already in the registry,
 * seeded by a path that had no session agent to hand: container rescue
 * (`services/recovery.ts`) and the warm pool both seed with
 * `deps.defaultAgentId`.
 *
 * The WS path already corrects this on connect — `activateSession` in
 * `route-registry.ts` assigns `existingRunner.agentId = sessionAgentId` for
 * exactly this reason, and its comment is the original write-up of the failure
 * (`claude --model gpt-5.5`, rejected by the CLI). What it does not cover is
 * the turn paths that never involve a WS connect at all: a child session's
 * follow-up message (`services/child-sessions.ts`), a wake turn
 * (`wake-session.ts`), a CI-fix turn. Those read `runner.agentId` and pass it
 * into `prepareSessionAgentEnvironment` and then into the turn itself, so a
 * Codex child whose container had been rescued ran Claude — with Claude's
 * credentials provisioned to match, which is what made it look deliberate.
 *
 * docs/150-multiple-provider-subscriptions req 18 is the requirement this protects: a child session picks its
 * own account through the normal priority order, which is meaningless if the
 * turn runs on the wrong *provider* to begin with.
 *
 * **Only the agent id is runner-held.** The provider route is not — it is read
 * from the session record inside `prepareSessionAgentEnvironment`
 * (`routedSession.providerRouteKind` / `providerRouteId`), so it cannot go
 * stale this way and needs no equivalent reconciliation.
 *
 * A running turn is never disturbed, for the same reason `activateSession`
 * leaves one alone: the agent process is already spawned, and its id is what
 * the in-flight turn is using. Reassigning underneath it would desynchronize
 * the runner from its own process. In that case the runner's current id is
 * returned unchanged.
 */
export function reconcileRunnerAgent(
  runner: { agentId: AgentId; running: boolean },
  persistedAgentId: AgentId | null | undefined,
): AgentId {
  if (!persistedAgentId) return runner.agentId;
  if (runner.running) return runner.agentId;
  if (runner.agentId !== persistedAgentId) {
    console.log(
      `[runner-agent] reconciling ${runner.agentId} -> ${persistedAgentId} from the session's persisted agent`,
    );
    runner.agentId = persistedAgentId;
  }
  return persistedAgentId;
}
