/**
 * docs/279-mutable-sandbox-capabilities — editing a session's settings after it
 * exists.
 *
 * Two writers live here because they share one transcript card (requirements 7 +
 * 8): a sandbox's capability grants, and — via {@link emitSessionSettingsChangeCard},
 * called from the egress route — a regular session's network containment mode.
 *
 * The capability write is deliberately NOT reachable from inside a container.
 * docs/211 made `capabilities` server-authoritative by making it immutable; once
 * it is writable, "the route is browser-only" is the whole of that guarantee
 * (requirement 4), so this service is registered only on browser-facing routes
 * and takes no agent-supplied identity.
 */

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
  /** Absent in local/dogfood mode and in tests without containers. */
  containerManager?: SessionContainerManager;
  sseBroadcast: (event: string, data: unknown) => void;
}

/**
 * Emit + persist the "session settings changed" transcript card.
 *
 * Goes through `emitChatCard`, which emits, records in-band at its true
 * transcript position and persists in one call — and picks the post-turn
 * `append` path itself when no turn is running, which is the common case here
 * (the user changes a setting while nothing is executing).
 *
 * When the session has no runner at all the row is appended directly rather than
 * dropped. `renameSessionByAgent` drops its card in that situation because a
 * rename with nobody attached is cosmetic; this one is the durable record of a
 * trust boundary moving, so "nobody is watching right now" is precisely the case
 * requirement 7 exists for.
 *
 * A no-op change writes nothing: an empty `changes` list would render a card
 * claiming something happened.
 */
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

/** The sandbox session behind an id, or the right error for what it isn't. */
function requireSandbox(
  sessionManager: SessionManager,
  sessionId: string,
): SessionCapabilities {
  const session = sessionManager.get(sessionId);
  if (!session) throw new ServiceError(404, "Session not found");
  if (session.kind !== "sandbox") {
    // Not 403: this isn't a permission the caller could be granted. An ordinary
    // or ops session has no capability set at all, and inventing one here would
    // be a second, undeclared way into the privileged container wiring.
    throw new ServiceError(400, "Only a sandbox session has capabilities");
  }
  // `fromRow` runs every sandbox row through `normalizeCapabilities`, so this is
  // always populated; the fallback keeps the type honest rather than guarding a
  // reachable case.
  return session.capabilities ?? normalizeCapabilities(undefined);
}

/** The current grants + what the live container started with + the pending diff. */
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

/**
 * Write a sandbox session's capability grants (requirement 1).
 *
 * The write always succeeds — what varies is whether it has already taken effect
 * (`git`/`dangerousGitHubOps`, read per request by the orchestrator's brokers) or
 * applies at the next container start (`docker`/`network`, plumbed into the
 * container). See `capabilitiesPendingRestart` for why that split is a fact about
 * the read sites rather than a policy.
 *
 * `input` is untrusted and partial: it goes through `normalizeCapabilities`,
 * which fills every missing flag from the defaults and enforces docs/224's
 * sub-grant rule. Callers that mean "change one toggle" must therefore send the
 * whole set — which the dialog does, because it holds it.
 */
export function updateSandboxCapabilities(
  deps: SessionSettingsDeps,
  sessionId: string,
  input: unknown,
): SandboxCapabilitiesView {
  const previous = requireSandbox(deps.sessionManager, sessionId);
  const next = normalizeCapabilities(input);
  const changes = describeCapabilityChanges(previous, next);

  const capabilitiesAtStart = deps.containerManager?.capabilitiesAtStart(sessionId) ?? null;
  const pendingRestart = capabilitiesPendingRestart(capabilitiesAtStart, next);

  if (changes.length === 0) {
    // Selecting the state the session already has is a success, not a write:
    // no durable churn, no SSE, no card claiming a change (same rule
    // `renameSessionByAgent` follows for a rename to the current title).
    return { sessionId, capabilities: previous, capabilitiesAtStart, pendingRestart };
  }

  deps.sessionManager.setCapabilities(sessionId, next);
  // The sidebar badge and the sandbox banner both render from the session list,
  // and neither is driven by the responding client alone (other tabs, and the
  // banner is rendered from `sessions`), so the list is rebroadcast.
  deps.sseBroadcast("session_list", { sessions: deps.sessionManager.list() });
  emitSessionSettingsChangeCard(deps, sessionId, "sandbox-capabilities", changes, pendingRestart);

  return { sessionId, capabilities: next, capabilitiesAtStart, pendingRestart };
}
