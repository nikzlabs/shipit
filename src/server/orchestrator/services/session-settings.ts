import { randomUUID } from "node:crypto";
import type { SessionManager } from "../sessions.js";
import type { SessionContainerManager } from "../session-container.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { ChatHistoryManager } from "../chat-history.js";
import { emitChatCard } from "../chat-card-persistence.js";
import { ServiceError } from "./types.js";
import {
  capabilitiesPendingRestart,
  describeCapabilityChanges,
} from "../sandbox-capabilities.js";
import {
  normalizeCapabilities,
  type SandboxCapabilitiesView,
  type SessionCapabilities,
  type SessionSettingsChangeCard,
  type SessionSettingsChangeEntry,
} from "../../shared/types.js";

export interface SessionSettingsDeps {
  sessionManager: SessionManager;
  runnerRegistry: SessionRunnerRegistry;
  chatHistoryManager: ChatHistoryManager;
  containerManager?: SessionContainerManager;
  sseBroadcast: (event: string, data: unknown) => void;
}

export function emitSessionSettingsChangeCard(
  deps: Pick<SessionSettingsDeps, "runnerRegistry" | "chatHistoryManager">,
  sessionId: string,
  scope: SessionSettingsChangeCard["scope"],
  changes: SessionSettingsChangeEntry[],
  pendingRestart: boolean,
): void {
  if (changes.length === 0) return;
  const card: SessionSettingsChangeCard = {
    cardId: `session-settings-${randomUUID()}`,
    scope,
    changes,
    pendingRestart,
    createdAt: new Date().toISOString(),
  };
  const persisted = { role: "assistant" as const, text: "", sessionSettingsChange: card };
  const runner = deps.runnerRegistry.get(sessionId);
  if (!runner) {
    deps.chatHistoryManager.append(sessionId, persisted);
    return;
  }
  emitChatCard(
    runner,
    { type: "session_settings_change_card", sessionId, card },
    persisted,
    { chatHistoryManager: deps.chatHistoryManager, sessionId },
  );
}

function requireSandbox(
  sessionManager: SessionManager,
  sessionId: string,
): SessionCapabilities {
  const session = sessionManager.get(sessionId);
  if (!session) throw new ServiceError(404, "Session not found");
  if (session.kind !== "sandbox") {
    throw new ServiceError(400, "Only a sandbox session has capabilities");
  }
  return session.capabilities ?? normalizeCapabilities(undefined);
}

export function readSandboxCapabilities(
  deps: Pick<SessionSettingsDeps, "sessionManager" | "containerManager">,
  sessionId: string,
): SandboxCapabilitiesView {
  const capabilities = requireSandbox(deps.sessionManager, sessionId);
  const capabilitiesAtStart = deps.containerManager?.capabilitiesAtStart(sessionId) ?? null;
  return {
    sessionId,
    capabilities,
    capabilitiesAtStart,
    pendingRestart: capabilitiesPendingRestart(capabilitiesAtStart, capabilities),
  };
}

/** Browser-only: never expose capability grants through a container route. */
export function updateSandboxCapabilities(
  deps: SessionSettingsDeps,
  sessionId: string,
  input: unknown,
): SandboxCapabilitiesView {
  const previous = requireSandbox(deps.sessionManager, sessionId);
  const patch = input && typeof input === "object" ? input : {};
  // Merge first so omitted grants retain their current values, not creation defaults.
  const next = normalizeCapabilities({ ...previous, ...patch });
  const changes = describeCapabilityChanges(previous, next);

  const capabilitiesAtStart = deps.containerManager?.capabilitiesAtStart(sessionId) ?? null;
  const pendingRestart = capabilitiesPendingRestart(capabilitiesAtStart, next);

  if (changes.length === 0) {
    return { sessionId, capabilities: previous, capabilitiesAtStart, pendingRestart };
  }

  deps.sessionManager.setCapabilities(sessionId, next);
  deps.sseBroadcast("session_list", { sessions: deps.sessionManager.list() });
  emitSessionSettingsChangeCard(deps, sessionId, "sandbox-capabilities", changes, pendingRestart);

  return { sessionId, capabilities: next, capabilitiesAtStart, pendingRestart };
}
