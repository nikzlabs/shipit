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
  const model = getSavedModelId();
  const savedAgentId = getSavedAgentId();
  // docs/252 made "each model belongs to exactly one agent" false: a model
  // carrying both an Anthropic-messages and an OpenAI style — DeepSeek V4, GLM,
  // anything reached through OpenRouter or Vercel — is runnable on BOTH
  // harnesses, and {@link agentIdForModel} answers such a model with whichever
  // agent sorts first. That silently overrode the user's own harness pick: on a
  // shared model, picking Codex changed nothing at all.
  //
  // So the saved harness breaks the tie, and only the tie: it wins when it can
  // actually run the saved model, which is precisely the case where deriving an
  // owner is a coin flip. A model only one harness runs still overrides a stale
  // saved harness, which is what docs/142 (Problem C) is about.
  if (model && agents.find((a) => a.id === savedAgentId)?.models.includes(model)) {
    return savedAgentId;
  }
  return agentIdForModel(model, agents) ?? savedAgentId;
}
