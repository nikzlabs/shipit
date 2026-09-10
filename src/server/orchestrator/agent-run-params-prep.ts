import type { AgentId, AgentRunParams } from "../shared/types.js";

export interface PrepareRunParamsInput {
  autoCreatePrActive: boolean;
  sandboxActive?: boolean;
  guardDestructiveGitActive?: boolean;
}

/** Return the agent-specific parameters without mutating the input. */
export type PrepareRunParamsFn = (
  params: AgentRunParams,
  input: PrepareRunParamsInput,
) => AgentRunParams;

export { prepareClaudeRunParams } from "./agents/claude/run-params-prep.js";
export { prepareCodexRunParams } from "./agents/codex/run-params-prep.js";

export const identityPrepareRunParams: PrepareRunParamsFn = (params) => params;

export function getPrepareRunParams(
  preps: Map<AgentId, PrepareRunParamsFn> | undefined,
  agentId: AgentId,
): PrepareRunParamsFn {
  return preps?.get(agentId) ?? identityPrepareRunParams;
}
