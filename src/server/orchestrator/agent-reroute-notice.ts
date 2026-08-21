import { getAgentDisplayName } from "../shared/agent-registry.js";
import { catalogueModelLabels } from "../shared/catalogue/index.js";
import type { AgentId } from "../shared/types.js";

/**
 * planning#389 — the sentence a session gets on its FIRST turn when the WS
 * connect handler moved it off the harness the browser asked for.
 *
 * A harness pick is write-once from the first turn onward, so a reroute the user
 * is not told about is unrecoverable by the time they could notice it: the
 * composer keeps naming the harness they chose (the client derives its own,
 * already-correct answer in `newSessionAgentId`) while the session runs — and
 * bills — on another one. planning#389 measured exactly that on the headless
 * path: Codex asked for, Claude delivered, $0.14 spent, `pending_agent_notice`
 * left NULL.
 *
 * That path can refuse with a 400 because it is an HTTP request. A WS upgrade
 * cannot without taking the session's whole channel down, so this path keeps the
 * reroute — the stale `vibe-agent-id` case docs/142 Problem C is written for is
 * the majority of this input, and rerouting is the right answer for it — and
 * pays for it with a notice instead.
 *
 * Addressed to the agent, because that is what the slot delivers to
 * (`agent-execution.ts` prefixes it to the turn's prompt). Hence the explicit
 * instruction to relay it: the agent is the only thing between this sentence and
 * the user, and a notice it reads and says nothing about is the silence this
 * exists to end. Both remedies are named in plain words rather than as the name
 * of a setting, since the user reads it as prose in the transcript.
 */
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
