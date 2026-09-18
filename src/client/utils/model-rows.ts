import { formatModelName } from "./format-model.js";
import type { AgentOption, ModelChoice } from "../agent-types.js";

/**
 * A model row, as the picker groups and renders it.
 *
 * Lives in `utils/` rather than beside the picker that renders it because the
 * rows are also what decides a **seed**: which model the global `vibe-model-id`
 * slot moves to when the user picks a harness (`harness-seed.ts`), and which one
 * an auth redirect restores. Those callers are a plain module and a hook, and
 * neither can reach into a `.tsx` component for the answer without dragging the
 * picker's React tree along with it.
 */
export interface ModelRow extends ModelChoice {

  groupKey: string;
}

export function modelRowsFor(agent: AgentOption | undefined): ModelRow[] {
  if (!agent) return [];
  if (agent.eligibleModels && agent.eligibleModels.length > 0) {
    return agent.eligibleModels.map((m) => ({ ...m, groupKey: `${m.serviceId}:${m.billingMode}` }));
  }
  return agent.models.map((modelId) => ({
    modelId,
    label: formatModelName(modelId),
    serviceId: "",
    serviceName: "",
    billingMode: "key" as const,
    groupKey: "",
  }));
}
