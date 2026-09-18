import type { AgentId, RoleView } from "../../shared/types.js";
import type { AgentInfo, AgentRegistry } from "../../shared/agent-registry.js";
import type { BillingMode } from "../../shared/catalogue/index.js";
import { reasoningOptionsFor } from "../../shared/catalogue/index.js";
import { isHarnessInstalled } from "../../shared/installed-harnesses.js";
import { buildRoleSettings, type RoleDeps } from "./roles.js";

export interface AgentRoleListing {
  name: string;
  description?: string;
  runsOn?: string;
  unavailable?: RoleView["unavailableReason"];
}

export interface SpawnParameterInventory {
  harnesses: {
    id: AgentId;
    name: string;
    reasoningLevels: string[];
    models: {
      serviceId: string;
      billingMode: BillingMode;
      modelId: string;
      label: string;
    }[];
  }[];
}

export function listRolesForAgent(deps: RoleDeps): AgentRoleListing[] {
  return buildRoleSettings(deps).map((role) => ({
    name: role.name,
    ...(role.description ? { description: role.description } : {}),
    ...(role.resolved
      ? {
          runsOn: [
            role.resolved.harnessName,
            role.resolved.label,
            role.resolved.reasoningLabel ?? role.resolved.reasoningEffort ?? "Default",
          ].join(" · "),
        }
      : {}),
    ...(role.unavailableReason ? { unavailable: role.unavailableReason } : {}),
  }));
}

// Completion precedes model selection, so union the eligible rows' levels while
// retaining the harness's declared order.
function honouredLevels(harness: AgentInfo): string[] {
  const vocabulary = harness.capabilities.reasoning?.options ?? [];
  if (vocabulary.length === 0) return [];
  const honoured = new Set(
    harness.eligibleModels.flatMap((model) =>
      reasoningOptionsFor(harness.id, {
        serviceId: model.serviceId,
        billingMode: model.billingMode,
        modelId: model.modelId,
      }).map((option) => option.value),
    ),
  );
  return vocabulary.map((option) => option.value).filter((value) => honoured.has(value));
}

// Inventory is install-wide; a consult provisions credentials absent from its caller's worker.
export function listSpawnParameters(agentRegistry: AgentRegistry): SpawnParameterInventory {
  return {
    harnesses: agentRegistry
      .list()
      .filter((harness) => isHarnessInstalled(harness.id))
      .map((harness) => ({
        id: harness.id,
        name: harness.name,
        reasoningLevels: honouredLevels(harness),
        models: harness.eligibleModels.map((model) => ({
          serviceId: model.serviceId,
          billingMode: model.billingMode,
          modelId: model.modelId,
          label: model.label,
        })),
      })),
  };
}
