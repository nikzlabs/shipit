import { projectToolResult } from "../transcript-projection.js";
import {
  buildRetiredSubagentResult,
  retireInCarriers,
  toTerminalStatus,
} from "../subagent-completion.js";
import type { BackgroundSubagentCompletion, RetiredSubagentHit } from "../subagent-completion.js";
import type { ChatHistoryManager } from "../chat-history.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import type { WsServerMessage } from "../../shared/types.js";

export interface FinishedBackgroundSubagent extends Omit<BackgroundSubagentCompletion, "status"> {
  sessionId: string;
  status?: string;
}

export function retireFinishedBackgroundSubagent(
  chatHistory: ChatHistoryManager,
  runner: SessionRunnerInterface | null,
  emit: (msg: WsServerMessage) => void,
  finished: FinishedBackgroundSubagent,
): void {
  const status = toTerminalStatus(finished.status);
  if (!status) return;

  const completion: BackgroundSubagentCompletion = {
    toolUseId: finished.toolUseId,
    status,
    ...(finished.summary !== undefined ? { summary: finished.summary } : {}),
    ...(finished.usage ? { usage: finished.usage } : {}),
  };
  const built = buildRetiredSubagentResult(completion);

  let hit: RetiredSubagentHit | null = null;
  try {
    // Patch both: an open turn rebuilds from memory; a finished turn exists only in history.
    if (runner) hit = retireInCarriers(runner.chatMessageGroups, completion, built);
    hit = chatHistory.retireBackgroundSubagentResult(finished.sessionId, completion, built) ?? hit;
  } catch (err) {
    console.error(
      `[subagent-retire] session=${finished.sessionId} tool=${finished.toolUseId}: ${String(err)}`,
    );
    return;
  }
  if (!hit) return;

  emit({
    type: "subagent_report_update",
    sessionId: finished.sessionId,
    toolUseId: finished.toolUseId,
    result: projectToolResult(
      finished.sessionId,
      { toolUseId: finished.toolUseId, content: hit.slot.content, ...(hit.slot.isError ? { isError: true } : {}) },
      hit.toolName,
    ),
  });
}
