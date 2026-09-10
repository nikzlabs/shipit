import type { AgentId, AgentProcess } from "../shared/types.js";
import type { SessionRunnerInterface, SystemTurnDeps } from "./session-runner.js";
import { executeAgentTurn } from "./turn-executor.js";
import { buildTurnMessages } from "./chat-card-persistence.js";
import { startQueuedMessage, queuedMessageToDispatchOptions } from "./queue-drain.js";

export interface InFlightTurnInfo {
  agentId: AgentId;
  runToken?: string;
  deliveryId?: string;
  streaming: boolean;
}

/** Install the agent in the runner before adoption, and wire listeners before SSE replay. */
export async function adoptInFlightTurn(
  runner: SessionRunnerInterface,
  deps: SystemTurnDeps,
  agent: AgentProcess,
  info: InFlightTurnInfo,
): Promise<void> {
  const sessionId = runner.sessionId;

  // Adoption skips env prep; recover the live process's account before attributing events.
  if (runner.residentRoute === undefined) {
    const recovered = deps.recoverResidentRoute?.(sessionId, info.agentId);
    if (recovered) {
      runner.residentRoute = recovered;
      console.log(
        `[turn-adoption:${sessionId}] recovered resident route ${recovered.kind}:${recovered.id} from the account marker`,
      );
    }
  }

  const drainNext = async (): Promise<void> => {
    // A rebase flow releases the queue when it settles.
    if (runner.systemTurnInProgress) return;
    const next = runner.dequeue();
    if (!next) return;
    runner.emitMessage({ type: "queue_updated", queue: runner.getQueueSnapshot() });
    await startQueuedMessage(runner, next, (queued) => {
      // Startup adoption has no WS connection for interactive re-entry.
      runner.dispatch(queuedMessageToDispatchOptions(queued));
      return Promise.resolve();
    });
  };

  // Restore delivery settlement so the originating watch does not send a duplicate wake.
  const rebound = info.deliveryId !== undefined
    ? deps.rebindDelivery?.(info.deliveryId)
    : undefined;
  if (info.deliveryId !== undefined) {
    const verdict = rebound ? "settlement rebound" : "no live owner, running unsettled";
    console.log(
      `[turn-adoption:${sessionId}] adopted turn carries delivery ${info.deliveryId} — ${verdict}`,
    );
  }

  await executeAgentTurn(runner, deps, agent, {
    agentId: info.agentId,
    sessionId,
    adopt: true,
    ...(info.deliveryId !== undefined ? { deliveryId: info.deliveryId } : {}),
    ...(rebound ? { onTurnComplete: rebound } : {}),
    prompt: "",
    userText: "",
    emitUserEcho: false,
    persistUserMessage: () => { /* already persisted before the restart */ },
    isNewSession: false,
    fallbackTitle: "Agent",
    // The starting HEAD died with the previous process; use working-tree auto-commit.
    turnStartHeadHash: null,
    drainNext,
    emit: (m) => runner.emitMessage(m),
    ...(info.streaming ? { useStreaming: true } : {}),
    emitErrorOnNoResult: true,
    onInterruptedTurn: () => {
      // Finalize partial replay rows so the next turn cannot replace them.
      const partial = buildTurnMessages(
        runner.chatMessageGroups,
        runner.steeredMessages ?? [],
        runner.recordedCards ?? [],
        { inProgress: false },
      );
      if (partial.length > 0) {
        deps.listenerDeps.chatHistoryManager.replaceInProgress(sessionId, partial);
        deps.listenerDeps.chatHistoryManager.finalizeInProgress(sessionId);
      }
      runner.clearTurnEventBuffer();
    },
  });
}
