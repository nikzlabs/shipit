import { getSavedAgentId, getSavedModelId } from "./local-storage.js";
import { agentIdForModel } from "./agent-for-model.js";
import type { AgentId } from "../../server/shared/types.js";
import type { AgentOption } from "../agent-types.js";

export function newSessionAgentId(agents: AgentOption[]): AgentId {
  const model = getSavedModelId();
  const savedAgentId = getSavedAgentId();

  // turn cannot start.
  const saved = agents.find((a) => a.id === savedAgentId);
  if (model && saved?.installed && saved.hasRunnableModels && saved.models.includes(model)) {
    return savedAgentId;
  }
  return agentIdForModel(model, agents) ?? savedAgentId;
}
