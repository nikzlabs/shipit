import type { AgentGoal, AgentGoalCommand, AgentId, AgentProcess } from "../../shared/types/agent-types.js";
import { getAgentCapabilities } from "../../shared/agent-registry.js";
import type { SessionManager } from "../sessions.js";

export interface AgentGoalDeps {
  sessionManager: Pick<SessionManager, "setAgentGoal" | "list" | "get">;
  sseBroadcast: (event: string, data: unknown) => void;
}

/** docs/154 — the goal rides SessionInfo, so every viewer and a reload see the same chip. */
export function recordAgentGoal(deps: AgentGoalDeps, sessionId: string, goal: AgentGoal | null): void {
  if (deps.sessionManager.setAgentGoal(sessionId, goal)) {
    deps.sseBroadcast("session_list", { sessions: deps.sessionManager.list() });
  }
}

/** An answer about a thread the session no longer uses (conversation reset meanwhile) is dropped. */
export function recordGoalForThread(
  deps: AgentGoalDeps,
  sessionId: string,
  threadId: string,
  goal: AgentGoal | null,
): void {
  if (deps.sessionManager.get(sessionId)?.agentSessionId !== threadId) return;
  recordAgentGoal(deps, sessionId, goal);
}

const goalChains = new Map<string, Promise<unknown>>();

/** One goal operation per session at a time, so a slow answer cannot overwrite a newer one. */
export function runGoalExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  // The stored tail never rejects, so awaiting it cannot fail.
  const previous = goalChains.get(sessionId) ?? Promise.resolve();
  const next = (async () => {
    await previous;
    return fn();
  })();
  const tail = next.catch(() => undefined);
  goalChains.set(sessionId, tail);
  void (async () => {
    await tail;
    if (goalChains.get(sessionId) === tail) goalChains.delete(sessionId);
  })();
  return next;
}

/**
 * docs/154 req 6 — read a goal that was never read, without a turn. Best
 * effort: a container that is not up yet leaves it for the next turn.
 */
export async function reconcileAgentGoal(
  deps: AgentGoalDeps & { sessionManager: Pick<SessionManager, "agentGoalChecked"> },
  sessionId: string,
  agentId: AgentId,
  createAgent: (agentId: AgentId) => AgentProcess,
): Promise<void> {
  if (!(getAgentCapabilities(agentId)?.supportsGoals ?? false)) return;
  const threadId = deps.sessionManager.get(sessionId)?.agentSessionId;
  if (!threadId || deps.sessionManager.agentGoalChecked(sessionId)) return;
  const agent = createAgent(agentId);
  if (!agent.goalCommand) return;
  const goalCommand = agent.goalCommand.bind(agent);
  await runGoalExclusive(sessionId, async () => {
    const { goal } = await goalCommand(threadId, { action: "get" });
    recordGoalForThread(deps, sessionId, threadId, goal);
  });
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

export function describeGoalResult(
  command: AgentGoalCommand,
  goal: AgentGoal | null,
  opts: { turnRunning?: boolean } = {},
): string {
  if (!goal) return command.action === "clear" ? "Goal cleared." : "No goal is set.";
  switch (command.action) {
    case "set":
      return `Goal set: ${goal.objective}`;
    case "pause":
      // Measured on 0.154.0: a pause does not interrupt the turn in progress.
      return opts.turnRunning
        ? `Goal paused: ${goal.objective}. The running turn continues; the pause applies from the next turn.`
        : `Goal paused: ${goal.objective}`;
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
