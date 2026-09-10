import type { AgentId } from "../shared/types.js";

// Existing runners can retain a rescue or warm-pool default; leave active processes unchanged.
export function reconcileRunnerAgent(
  runner: { agentId: AgentId; running: boolean },
  persistedAgentId: AgentId | null | undefined,
): AgentId {
  if (!persistedAgentId) return runner.agentId;
  if (runner.running) return runner.agentId;
  if (runner.agentId !== persistedAgentId) {
    console.log(
      `[runner-agent] reconciling ${runner.agentId} -> ${persistedAgentId} from the session's persisted agent`,
    );
    runner.agentId = persistedAgentId;
  }
  return persistedAgentId;
}
