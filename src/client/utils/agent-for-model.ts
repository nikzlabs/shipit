import type { AgentId } from "../../server/shared/types.js";
import type { AgentOption } from "../agent-types.js";

/**
 * Derive the agent that owns a given model.
 *
 * The model dropdown is the only model/agent control in the UI — there is no
 * standalone agent switcher — so picking a model implicitly selects its agent.
 * The model is therefore the single source of truth and the agent must be
 * derived from it, never tracked independently. Each model belongs to exactly
 * one agent, and `agentList` (populated from the server's `agent_list`) carries
 * the mapping.
 *
 * Returns `undefined` when the model is empty/unknown or the agent list hasn't
 * loaded yet — callers fall back to a sane default in that case. See
 * docs/142-agent-auth-recovery-and-model-source-of-truth (Problem C).
 */
export function agentIdForModel(
  model: string | undefined,
  agents: AgentOption[],
): AgentId | undefined {
  if (!model) return undefined;
  const owner = agents.find((a) => a.models.includes(model));
  return owner?.id as AgentId | undefined;
}
