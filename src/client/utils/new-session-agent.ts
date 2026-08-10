import { getSavedAgentId, getSavedModelId } from "./local-storage.js";
import { agentIdForModel } from "./agent-for-model.js";
import type { AgentId } from "../../server/shared/types.js";
import type { AgentOption } from "../agent-types.js";

/**
 * The harness a **brand-new** session will actually be created on.
 *
 * This is the rule the creation path applies, in one place instead of three:
 * `useSessionWebSocket` puts it on the connect URL, Quick Capture sends it with
 * the creation params, and the composer's {@link HarnessSelector} /
 * {@link ModelSelector} display it. All three have to agree — a picker naming a
 * harness the new session will not be created on is the display lying about the
 * single most consequential, and irreversible, fact about the session.
 *
 * The model is the single source of truth and the agent is derived from it, so
 * a stale `vibe-agent-id` can't override the user's model pick — the server
 * would otherwise treat the agent as authoritative and rewrite the model (opus
 * → gpt-5.5). The saved agent is the fallback for when the model is unknown or
 * the agent list has not loaded yet. See docs/142 (Problem C) and
 * docs/166-quick-capture-agent-pin.
 *
 * Deliberately NOT the ui-store's `activeAgentId`: that field is synced to
 * whichever session is connected (`useConnectionSync`), on purpose, so it
 * answers "what is the session I am looking at running on" — a different
 * question, and the wrong one when there is no session yet.
 */
export function newSessionAgentId(agents: AgentOption[]): AgentId {
  return agentIdForModel(getSavedModelId(), agents) ?? getSavedAgentId();
}
