import { getAgentDisplayName } from "../shared/agent-registry.js";
import { catalogueModelLabels } from "../shared/catalogue/index.js";
import type { AgentId } from "../shared/types.js";

export function buildAgentRerouteNotice(
  requested: AgentId,
  actual: AgentId,
  model: string,
): string {
  const requestedName = getAgentDisplayName(requested);
  const actualName = getAgentDisplayName(actual);
  const modelLabel = catalogueModelLabels()[model] ?? model;
  return (
    `[ShipIt] This session was started on ${actualName}, not ${requestedName}: `
    + `${requestedName} and ${modelLabel} share no API style, so ${requestedName} `
    + `cannot run it. The harness is fixed for the rest of this session once this `
    + `turn starts. Tell the user this before you do anything else, and that their `
    + `options are to keep going on ${actualName}, or to start a new session and `
    + `either pick a model ${requestedName} can run or leave the model on `
    + `${modelLabel} and let ShipIt choose the harness.`
  );
}
