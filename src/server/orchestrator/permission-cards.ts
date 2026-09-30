import type { ChatHistoryManager } from "./chat-history.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import { persistCardTransition } from "./chat-card-persistence.js";

export interface PermissionCardDeps {
  chatHistoryManager: ChatHistoryManager;
  sseBroadcast: (event: string, data: unknown) => void;
}

type PermissionCardRunner = Pick<
  SessionRunnerInterface,
  | "running"
  | "recordedCards"
  | "chatMessageGroups"
  | "steeredMessages"
  | "getTurnEventBuffer"
  | "lastPersistedBufferIndex"
  | "emitMessage"
  | "awaitingPermissionIds"
>;

export function settlePermissionCard(
  runner: PermissionCardRunner,
  sessionId: string,
  deps: PermissionCardDeps,
  requestId: string,
  phase: "approved" | "denied",
  remembered?: boolean,
): void {
  const patch = { phase, ...(remembered ? { remembered: true } : {}) };
  // Mid-turn the recorded card must change too, or the next rebuild restores it as pending (docs/193).
  persistCardTransition(
    runner,
    { chatHistoryManager: deps.chatHistoryManager, sessionId },
    (m) => m.permissionPrompt?.requestId === requestId,
    (m) => ({ ...m, permissionPrompt: { ...m.permissionPrompt!, ...patch } }),
    () => deps.chatHistoryManager.updatePermissionCard(sessionId, requestId, patch),
  );
  runner.emitMessage({ type: "permission_resolved", sessionId, requestId, ...patch });

  runner.awaitingPermissionIds.delete(requestId);
  if (runner.awaitingPermissionIds.size === 0) {
    deps.sseBroadcast("session_attention", { sessionId, awaitingPermission: false });
  }
}

// For when the worker cannot say so itself: it died, or it runs an image from before
// the broker denied abandoned requests.
export function denyAbandonedPermissionCards(
  runner: PermissionCardRunner,
  sessionId: string,
  deps: PermissionCardDeps,
): void {
  for (const requestId of [...runner.awaitingPermissionIds]) {
    settlePermissionCard(runner, sessionId, deps, requestId, "denied");
  }
}
