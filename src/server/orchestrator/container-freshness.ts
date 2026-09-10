import type { ContainerFreshness } from "../shared/types.js";

export function getContainerFreshness(
  workerBuildId: string | undefined,
  orchestratorBuildId: string | undefined,
): ContainerFreshness {
  const worker = workerBuildId?.trim() || undefined;
  const orchestrator = orchestratorBuildId?.trim() || undefined;
  if (!worker || !orchestrator) {
    return {
      state: "unknown",
      ...(worker ? { workerBuildId: worker } : {}),
      ...(orchestrator ? { orchestratorBuildId: orchestrator } : {}),
    };
  }
  return {
    state: worker === orchestrator ? "current" : "stale",
    workerBuildId: worker,
    orchestratorBuildId: orchestrator,
  };
}
