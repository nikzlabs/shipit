import { recordSteeredMessage, persistTurnInProgress } from "./ws-handlers/agent-listeners.js";
import type {
  SessionRunnerInterface,
  AgentDispatchOptions,
  SystemTurnDeps,
} from "./session-runner.js";
import { formatAgentInterfacePrompt } from "../shared/agent-interface-sdk/protocol.js";
import { formatSessionMessagePrompt } from "./session-message-origin.js";

// Callers must check that a turn is running and a resident agent exists.
export interface SteerDecisionInputs {
  steeringCapable: boolean;
  liveSteering: boolean;
  streamingActive: boolean;
  systemTurnInProgress: boolean;
}

export function shouldSteerMessage(i: SteerDecisionInputs): boolean {
  return (
    i.steeringCapable &&
    i.liveSteering &&
    i.streamingActive &&
    !i.systemTurnInProgress
  );
}

// Steering has no separate teardown to fire an incoming turn's completion callback.
export function isSteerableDispatch(opts: AgentDispatchOptions): boolean {
  return !opts.systemTurn && !opts.onTurnComplete;
}

/** Returns false when the caller must enqueue the message. */
export function trySteerDispatch(
  runner: SessionRunnerInterface,
  opts: AgentDispatchOptions,
  deps: SystemTurnDeps,
): boolean {
  if (!isSteerableDispatch(opts)) return false;
  if (!deps.steerInputs) return false;
  const { liveSteering, steeringCapable } = deps.steerInputs();

  if (
    !shouldSteerMessage({
      steeringCapable,
      liveSteering,
      streamingActive: runner.isStreamingActive,
      systemTurnInProgress: runner.systemTurnInProgress,
    })
  ) {
    return false;
  }

  const agent = runner.getAgent();
  if (!agent) return false;

  // A resident CLI retains its spawn-time permission mode until explicitly updated.
  if (runner.appliedPermissionMode !== opts.permissionMode && agent.setPermissionMode) {
    agent.setPermissionMode(opts.permissionMode);
    runner.appliedPermissionMode = opts.permissionMode;
  }

  const surfacedText = opts.agentInterface
    ? formatAgentInterfacePrompt(opts.text, opts.agentInterface)
    : opts.text;
  const agentText = opts.messageOrigin
    ? formatSessionMessagePrompt(surfacedText, opts.messageOrigin)
    : surfacedText;
  agent.sendUserMessage(agentText);

  // Acknowledgement and retry matching need the exact text sent to the CLI.
  recordSteeredMessage(runner, opts.text, {
    assembledPrompt: agentText,
    ...(opts.agentInterface ? { agentInterface: opts.agentInterface } : {}),
    ...(opts.messageOrigin ? { messageOrigin: opts.messageOrigin } : {}),
  });
  persistTurnInProgress(deps.listenerDeps.chatHistoryManager, runner, runner.sessionId);
  runner.emitMessage({
    type: "message_steered",
    text: opts.text,
    sessionId: runner.sessionId,
    ...(opts.agentInterface ? { agentInterface: opts.agentInterface } : {}),
    ...(opts.messageOrigin ? { messageOrigin: opts.messageOrigin } : {}),
  });
  return true;
}
