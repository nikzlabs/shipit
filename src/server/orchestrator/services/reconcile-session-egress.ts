/**
 * docs/285 — make the network mode the user picked before the first message the
 * mode that message's turn actually runs under.
 *
 * Egress containment is a **creation-time topology**: the Tier A firewall, the
 * Tier B resolver and the Tier C proxy are plumbed into the agent's network
 * namespace when the container is created (`container-lifecycle.ts`), and a
 * running container cannot be re-plumbed. Meanwhile `/new` claims a session on
 * arrival, so by the time the user picks a mode a container usually exists —
 * built under whatever the workspace default was.
 *
 * So the first Send reconciles: compare what the session resolves to now against
 * what the live container actually booted with, and on a disagreement destroy
 * and rebuild it before the turn goes out. Every later message skips this
 * entirely — a mode changed after the first turn shows the ordinary "applies on
 * next container start" pending state, exactly as it does today.
 *
 * Two properties are load-bearing and easy to lose:
 *
 *  - **It reads the raw boot record**, never `isEgressContained()`. That helper
 *    re-derives the *current policy* when the boot state is unknown, which is
 *    precisely how "unknown" would come to read as "matching" and run the first
 *    turn under the wrong mode.
 *  - **It is not Rescue.** It reuses Rescue's teardown/recreate path but not its
 *    privilege of clearing the OOM breaker: toggling a setting must not buy a
 *    retry that an unchanged first Send is refused.
 */

import type { AgentId } from "../../shared/types.js";
import type { SessionContainerManager } from "../session-container.js";
import type { EgressAllowlistStore } from "../egress-allowlist-store.js";
import type { SessionOomCircuitBreaker } from "../oom-circuit-breaker.js";
import { restartContainer, type RecoveryDeps } from "./recovery.js";

export interface ReconcileEgressDeps {
  containerManager: SessionContainerManager | null;
  egressAllowlistStore: EgressAllowlistStore | undefined;
  oomBreaker?: SessionOomCircuitBreaker;
  /** Everything `restartContainer` needs, when a restart turns out to be required. */
  recovery: RecoveryDeps;
}

export type ReconcileEgressOutcome =
  /** The container already matches, or there is nothing to reconcile. Send as normal. */
  | { action: "none"; reason: "matches" }
  /**
   * The container was destroyed and a replacement created. The caller proceeds
   * through the NEW runner's own worker-readiness gate — `restartContainer`
   * bounds its wait at 8s and can return with the replacement still `starting`.
   */
  | { action: "restarted" }
  /**
   * The Send must not go out. `message` is user-facing; `offerRescue` marks the
   * one case the user can act on directly.
   */
  | { action: "aborted"; message: string; offerRescue: boolean };

/**
 * Does the live container disagree with the mode this session resolves to?
 *
 * "Running, and the recorded boot mode matches" is the only agreeing answer.
 * Mismatching, still `starting`, and unknown all count as disagreement: each
 * costs an unnecessary restart in a rare case, and none of them can silently run
 * the first turn under the wrong mode. `restartContainer` handles `starting`
 * too, since its destroy cancels a creation that has published no record yet.
 *
 * Keyed on the **container record**, never the standby marker, which lags it.
 */
export function containerDisagreesWithEgressPolicy(
  deps: Pick<ReconcileEgressDeps, "containerManager" | "egressAllowlistStore">,
  sessionId: string,
): boolean {
  const store = deps.egressAllowlistStore;
  // No store means no per-session override can have been written, so there is
  // nothing this feature could have changed.
  if (!store) return false;
  // No container record — nothing plumbed yet, so the next create resolves the
  // mode fresh and there is nothing to rebuild.
  //
  // This also answers `RUNTIME_MODE=local`, where there is no container manager
  // at all: `restartContainer` throws a 503 there, and the first Send must
  // proceed (the override is persisted; there is simply no topology). No
  // separate branch for it, because "no manager" and "no container" are the same
  // question asked twice, and a second check would be unreachable code that
  // reads like a guarantee.
  const container = deps.containerManager?.get(sessionId);
  if (!container) return false;
  if (container.status !== "running") return true; // `starting`/`stopped` — rebuild rather than guess.
  const bootedContained = container.egressContainedAtStart;
  if (bootedContained === undefined || bootedContained === null) return true; // unknown ≠ matching.
  return bootedContained !== store.resolveContained(sessionId);
}

/**
 * Bring the session's container in line with its resolved network mode, if the
 * two disagree. Safe to call on every first Send: the common case (nobody
 * touched the mode) returns `none` without doing any work.
 */
export async function reconcileSessionEgress(
  deps: ReconcileEgressDeps,
  sessionId: string,
  opts: { agentSeed?: AgentId } = {},
): Promise<ReconcileEgressOutcome> {
  if (!containerDisagreesWithEgressPolicy(deps, sessionId)) {
    return { action: "none", reason: "matches" };
  }

  // A tripped breaker is the one case where restarting is refused, and the
  // refusal has to be honoured HERE rather than laundered away: Rescue clears
  // the breaker because the user explicitly asked to retry, and a network-mode
  // change is not that request. Letting it through would mean a session that has
  // been OOM-killed repeatedly gets a free attempt by toggling a setting, while
  // an unchanged first Send on that same session stays blocked.
  if (deps.oomBreaker?.isTripped(sessionId)) {
    return {
      action: "aborted",
      offerRescue: true,
      message:
        "This session's container can't be rebuilt right now — it has been stopped "
        + "repeatedly, so automatic restarts are paused. Rescue the session to try again, "
        + "then send your message.",
    };
  }

  const result = await restartContainer(deps.recovery, sessionId, {
    // NOT Rescue: see the breaker check above.
    resetBreakers: false,
    // The CALLER announces, after it has attached to the replacement. Announcing
    // from inside would reach the sending tab mid-handler, and a tab that
    // reconnects there closes the very socket the handler goes on to attach.
    announceReplacement: false,
    ...(opts.agentSeed ? { agentSeed: opts.agentSeed } : {}),
  });

  // `ok` is always true — restart is idempotent and reports success even when
  // creating the replacement errored. `newContainerState` and `error` are the
  // values that mean anything, so dispatching on `ok` here would send the first
  // turn into a container that does not exist.
  if (result.newContainerState === "missing") {
    return {
      action: "aborted",
      offerRescue: false,
      message: `Couldn't rebuild this session's container for the network mode you chose${
        result.error ? `: ${result.error}` : "."
      } Your message was not sent.`,
    };
  }

  // `running`, `starting` and `pending` all continue: the replacement exists (or
  // is being created), and the caller waits on the NEW runner's readiness gate
  // rather than on this call having returned.
  return { action: "restarted" };
}
