import type { AgentId } from "../../shared/types.js";
import type { SessionContainerManager } from "../session-container.js";
import type { EgressAllowlistStore } from "../egress-allowlist-store.js";
import type { SessionOomCircuitBreaker } from "../oom-circuit-breaker.js";
import { restartContainer, type RecoveryDeps } from "./recovery.js";

export interface ReconcileEgressDeps {
  containerManager: SessionContainerManager | null;
  egressAllowlistStore: EgressAllowlistStore | undefined;
  oomBreaker?: SessionOomCircuitBreaker;
  recovery: RecoveryDeps;
}

export type ReconcileEgressOutcome =
  | { action: "none"; reason: "matches" }
  | { action: "restarted" }
  | { action: "aborted"; message: string; offerRescue: boolean };

// Use the creation-time resolver: sandbox policy can override the store's network setting.
export function resolveSessionContainment(
  deps: Pick<ReconcileEgressDeps, "containerManager" | "egressAllowlistStore">,
  sessionId: string,
): boolean | null {
  const resolved = deps.containerManager?.resolveEgress(sessionId);
  if (resolved) return resolved.contained;
  return deps.egressAllowlistStore?.resolveContained(sessionId) ?? null;
}

export function containerDisagreesWithEgressPolicy(
  deps: Pick<ReconcileEgressDeps, "containerManager" | "egressAllowlistStore">,
  sessionId: string,
): boolean {
  const store = deps.egressAllowlistStore;
  if (!store) return false;
  const container = deps.containerManager?.get(sessionId);
  if (!container) return false;
  if (container.status !== "running") return true;
  // isEgressContained() substitutes current policy for an unknown boot mode.
  const bootedContained = container.egressContainedAtStart;
  if (bootedContained === undefined || bootedContained === null) return true;
  const target = resolveSessionContainment(deps, sessionId);
  if (target === null) return false;
  return bootedContained !== target;
}

export async function reconcileSessionEgress(
  deps: ReconcileEgressDeps,
  sessionId: string,
  opts: { agentSeed?: AgentId } = {},
): Promise<ReconcileEgressOutcome> {
  if (!containerDisagreesWithEgressPolicy(deps, sessionId)) {
    return { action: "none", reason: "matches" };
  }

  // A settings change must not grant the OOM retry reserved for Rescue.
  if (deps.oomBreaker?.isTripped(sessionId)) {
    return {
      action: "aborted",
      offerRescue: true,
      message:
        "This session's container can't be rebuilt right now — it has been stopped "
        + "repeatedly, so automatic restarts are paused. Rescue the session to try again, "
        + "then change the network mode.",
    };
  }

  const result = await restartContainer(deps.recovery, sessionId, {
    resetBreakers: false,
    ...(opts.agentSeed ? { agentSeed: opts.agentSeed } : {}),
  });

  // restartContainer returns ok:true even when replacement creation fails.
  if (result.newContainerState === "missing") {
    return {
      action: "aborted",
      offerRescue: false,
      message: `Couldn't rebuild this session's container for the network mode you chose${
        result.error ? `: ${result.error}` : "."
      } The mode was not applied.`,
    };
  }

  // The first turn separately waits for the replacement worker to be ready.
  return { action: "restarted" };
}
