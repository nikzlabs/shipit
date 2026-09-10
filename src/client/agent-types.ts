import type { PermissionMode } from "../server/shared/types.js";

export interface ModelChoice {
  serviceId: string;
  serviceName: string;
  billingMode: "sub" | "key";
  modelId: string;
  label: string;
}

export interface EligibleModelOption extends ModelChoice {
  /** Shared across services that offer the same model. */
  canonicalModelKey: string;
}

export interface AgentOption {
  id: string;
  name: string;
  installed: boolean;
  hasRunnableModels: boolean;
  models: string[];
  eligibleModels?: EligibleModelOption[];
  supportsReview: boolean;
  supportedPermissionModes?: PermissionMode[];
  supportsSteering?: boolean;
  supportsCompaction?: boolean;
  skillInvocationPrefix?: string;
  reasoning?: {
    label: string;
    options: { value: string; label: string }[];
  };
}

export function isSelectionEligibleForAgent(
  agents: AgentOption[],
  agentId: string,
  selection: { serviceId: string; billingMode: "sub" | "key"; modelId: string } | undefined,
): boolean {
  if (!selection) return false;
  const agent = agents.find((a) => a.id === agentId);
  if (!agent?.eligibleModels) return true;
  return agent.eligibleModels.some(
    (m) =>
      m.serviceId === selection.serviceId
      && m.billingMode === selection.billingMode
      && m.modelId === selection.modelId,
  );
}
