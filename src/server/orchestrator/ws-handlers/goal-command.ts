import type { AgentGoalCommand } from "../../shared/types/agent-types.js";
import type { ConnectionCtx, RunnerCtx, AppCtx } from "./types.js";
import { resolveRunner } from "./resolve-runner.js";
import { getErrorMessage } from "../../shared/utils.js";
import { describeGoalResult, GOAL_ACTION_VERBS, recordAgentGoal } from "../services/agent-goal.js";

type FullCtx = ConnectionCtx & RunnerCtx & AppCtx;

/** docs/154 (req 4) — answer `/goal …` from the CLI's goal store; no turn starts. */
export async function handleGoalCommand(
  ctx: FullCtx,
  command: AgentGoalCommand,
  sessionId: string | undefined,
): Promise<void> {
  if (!sessionId) return;
  const runner = resolveRunner(ctx);
  const notice = (message: string, level: "info" | "warn" = "info"): void => {
    const frame = { type: "system_notice" as const, sessionId, message, level };
    if (runner) runner.emitMessage(frame);
    else ctx.send(frame);
  };

  const threadId = ctx.sessionManager.get(sessionId)?.agentSessionId;
  if (!threadId) {
    notice(command.action === "set"
      ? "Send a first message to start the conversation, then set the goal."
      : "No goal is set.");
    return;
  }

  const agentId = ctx.getActiveAgentId();
  const live = runner?.getAgent();
  const agent = live?.agentId === agentId && live.goalCommand ? live : ctx.agentFactory(agentId);
  if (!agent.goalCommand) {
    notice("This agent does not support goals.", "warn");
    return;
  }

  try {
    const { goal } = await agent.goalCommand(threadId, command);
    recordAgentGoal(ctx, sessionId, goal);
    notice(describeGoalResult(command, goal));
  } catch (err) {
    notice(`Couldn't ${GOAL_ACTION_VERBS[command.action]} the goal: ${getErrorMessage(err)}`, "warn");
  }
}
