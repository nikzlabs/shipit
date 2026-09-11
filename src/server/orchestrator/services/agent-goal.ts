import type { AgentGoal, AgentGoalCommand } from "../../shared/types/agent-types.js";
import type { SessionManager } from "../sessions.js";

export interface AgentGoalDeps {
  sessionManager: Pick<SessionManager, "setAgentGoal" | "list">;
  sseBroadcast: (event: string, data: unknown) => void;
}

/** docs/154 — the goal rides SessionInfo, so every viewer and a reload see the same chip. */
export function recordAgentGoal(deps: AgentGoalDeps, sessionId: string, goal: AgentGoal | null): void {
  if (deps.sessionManager.setAgentGoal(sessionId, goal)) {
    deps.sseBroadcast("session_list", { sessions: deps.sessionManager.list() });
  }
}

const STATUS_LABELS: Record<string, string> = {
  active: "active",
  paused: "paused",
  blocked: "blocked",
  usageLimited: "stopped at the usage limit",
  budgetLimited: "stopped at its token budget",
  complete: "complete",
};

export function goalStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function describeGoalResult(command: AgentGoalCommand, goal: AgentGoal | null): string {
  if (!goal) return command.action === "clear" ? "Goal cleared." : "No goal is set.";
  switch (command.action) {
    case "set":
      return `Goal set: ${goal.objective}`;
    case "pause":
      return `Goal paused: ${goal.objective}`;
    case "resume":
      return `Goal resumed: ${goal.objective}`;
    default: {
      const used = goal.tokensUsed > 0 ? ` — ${goal.tokensUsed.toLocaleString("en-US")} tokens used` : "";
      return `Goal (${goalStatusLabel(goal.status)}): ${goal.objective}${used}`;
    }
  }
}

export const GOAL_ACTION_VERBS: Record<AgentGoalCommand["action"], string> = {
  get: "read",
  set: "set",
  clear: "clear",
  pause: "pause",
  resume: "resume",
};
