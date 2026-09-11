import type { AgentGoalCommand } from "../../shared/types/agent-types.js";
import type { ConnectionCtx, RunnerCtx, AppCtx } from "./types.js";
import { resolveRunner } from "./resolve-runner.js";
import { getErrorMessage } from "../../shared/utils.js";
import { emitNoticeInTurn, emitNoticePostTurn } from "../chat-card-persistence.js";
import {
  describeGoalResult,
  GOAL_ACTION_VERBS,
  recordGoalForThread,
  runGoalExclusive,
} from "../services/agent-goal.js";

type FullCtx = ConnectionCtx & RunnerCtx & AppCtx;

/** docs/154 (req 4) — answer `/goal …` from the CLI's goal store; no turn starts. */
export async function handleGoalCommand(
  ctx: FullCtx,
  command: AgentGoalCommand,
  sessionId: string | undefined,
): Promise<void> {
  if (!sessionId) return;
  const runner = resolveRunner(ctx);
  // Persisted: the command has no bubble, so the notice is its only trace in the transcript.
  const notice = (message: string, level: "info" | "warn" = "info"): void => {
    if (runner) emitNoticeInTurn(runner, sessionId, message, ctx.chatHistoryManager, level);
    else emitNoticePostTurn((m) => { ctx.send(m); }, ctx.chatHistoryManager, sessionId, message, level);
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
  const goalCommand = agent.goalCommand.bind(agent);

  try {
    const goal = await runGoalExclusive(sessionId, async () => {
      const result = await goalCommand(threadId, command);
      recordGoalForThread(ctx, sessionId, threadId, result.goal);
      return result.goal;
    });
    notice(describeGoalResult(command, goal, { turnRunning: runner?.running ?? false }));
  } catch (err) {
    notice(`Couldn't ${GOAL_ACTION_VERBS[command.action]} the goal: ${getErrorMessage(err)}`, "warn");
  }
}
