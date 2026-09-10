import type { WsServerMessage } from "../../shared/types.js";
import type { AgentProcess } from "../../shared/types.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import { emitChatCard, persistTurnInProgress } from "../chat-card-persistence.js";
import {
  credentialFailurePolicyFor,
  credentialFailureStopMessage,
  credentialSetAsideMessage,
} from "../credential-failure-policy.js";
import { UNKNOWN_RESET_LOCKOUT_MS } from "./agent-rate-limits.js";
import type { AgentListenerDeps, WireListenersOpts } from "./agent-listeners.js";

export const AGENT_NOT_AUTHENTICATED_MESSAGE =
  "This agent is not authenticated. Open Settings → Agents to sign in, then resend your message.";

export function wireAuthRequiredHandler(
  agent: AgentProcess,
  runner: SessionRunnerInterface | null,
  deps: AgentListenerDeps,
  opts: WireListenersOpts,
  emitToViewers: (msg: WsServerMessage) => void,
): void {
  // Ignore duplicate events; re-checking recovery could show sign-in during a successful heal.
  let handledThisTurn = false;

  agent.on("auth_required", () => {
    if (handledThisTurn) return;
    handledThisTurn = true;

    const turnSession = opts.capturedSessionId
      ? deps.sessionManager.get(opts.capturedSessionId)
      : null;
    const failingAgentId = turnSession?.agentId;
    const turnSessionId = opts.capturedSessionId;

    const failurePolicy =
      opts.getCapturedRoutePolicy?.() ?? credentialFailurePolicyFor(turnSession ?? undefined);
    const setAsideCredential =
      !failurePolicy.stopsOnFailure
      && !failurePolicy.vendorOwnedRecovery
      && opts.getCapturedRouteKind?.() === "reserved"
      && !!turnSessionId;

    // Set the executor's recovery decision before kill can trigger its done handler.
    const willRecover =
      failurePolicy.stopsOnFailure || !failurePolicy.vendorOwnedRecovery
        ? false
        : opts.willRecoverAuth?.() ?? false;

    const message = failurePolicy.stopsOnFailure
      ? credentialFailureStopMessage(failurePolicy)
      : setAsideCredential
        ? credentialSetAsideMessage(failurePolicy)
        : AGENT_NOT_AUTHENTICATED_MESSAGE;

    const persistAuthErrorRow = (): void => {
      if (!runner || !turnSessionId) {
        emitToViewers({ type: "error", message });
        return;
      }
      // Flush partial output before the error; the executor skips auth-path finalization.
      persistTurnInProgress(deps.chatHistoryManager, runner, turnSessionId);
      emitChatCard(
        runner,
        { type: "error", message, sessionId: turnSessionId },
        { role: "assistant", text: `Error: ${message}`, isError: true },
        { chatHistoryManager: deps.chatHistoryManager, sessionId: turnSessionId },
      );
      deps.chatHistoryManager.finalizeInProgress(turnSessionId);
    };

    const surfaceReauth = (): void => {
      console.log(
        failurePolicy.stopsOnFailure
          ? `[server] key-authenticated turn failed auth (${failurePolicy.serviceId ?? "unknown service"}); `
            + "stopping without re-auth (docs/252 req 12)"
          : setAsideCredential
            ? `[server] ${failurePolicy.serviceId ?? "service"} credential refused the turn; `
              + "setting it aside so the next turn fails over (docs/252 req 12)"
            : "[server] Agent CLI requires authentication; prompting re-auth via Settings",
      );
      if (setAsideCredential && turnSessionId) {
        deps.markSessionAccountExhausted?.(
          turnSessionId,
          Date.now() + UNKNOWN_RESET_LOCKOUT_MS,
          opts.getCapturedRouteId?.(),
        );
      }
      const failedRouteId = opts.getCapturedRouteId?.();
      if (failedRouteId && opts.getCapturedRouteKind?.() === "reserved") {
        deps.markCredentialRouteAuthFailed?.(failedRouteId);
      }
      persistAuthErrorRow();
      // A vendor's OAuth refresher cannot repair another service's key or subscription.
      if (failingAgentId && !failurePolicy.stopsOnFailure && failurePolicy.vendorOwnedRecovery) {
        deps.onAgentAuthRequired?.(failingAgentId);
      }
      if (runner && turnSessionId) {
        emitToViewers({
          type: "session_status",
          sessionId: turnSessionId,
          running: false,
          queueLength: runner.queueLength,
        });
      }
      if (turnSessionId) {
        deps.sseBroadcast("session_agent_finished", { sessionId: turnSessionId });
      }
    };

    // Persistent CLIs can remain alive after failed results and block the next spawn.
    agent.kill();
    if (runner) {
      if (runner.getAgent() === agent) {
        runner.setAgent(null);
        runner.isStreamingActive = false;
        // Recovery makes the executor skip its usual background-task cleanup.
        runner.clearBackgroundTasks();
      }
      // Keep recovery visibly busy until re-dispatch.
      if (!willRecover) runner.running = false;
    }

    if (willRecover && opts.recoverAuth) {
      // eslint-disable-next-line no-restricted-syntax -- intentional fire-and-forget in a sync event handler
      void opts.recoverAuth().then(
        (handled) => {
          if (!handled) surfaceReauth();
        },
        (err: unknown) => {
          console.error("[server] docs/179 auth recovery rejected unexpectedly:", err);
          surfaceReauth();
        },
      );
      return;
    }
    surfaceReauth();
  });
}
