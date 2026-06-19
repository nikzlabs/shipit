import type { AgentId } from "../../server/shared/types.js";
import type { AgentOption } from "../agent-types.js";

/**
 * Decide whether the picker's selection must be redirected to an authed agent,
 * and what to persist when it must.
 *
 * On a fresh install the picker hydrates from localStorage, which defaults to
 * `agent = "claude"` / no model. On a Codex-only (or otherwise non-Claude)
 * machine that default is wrong: the picker would sit on Claude even though
 * Claude isn't authenticated. Worse, the per-session WebSocket derives its
 * effective agent from the *saved model* (and falls back to the saved agent) at
 * connect time — so without persisting a correction, the first turn connects as
 * the unauthed agent and the server's auth gate rejects it, until the user
 * round-trips the model selector (which sends `set_model` live). See docs/142
 * (model is the single source of truth the agent is derived from).
 *
 * Returns the `{ agentId, modelId }` to persist (localStorage + the in-memory
 * picker) when a redirect is needed, or `null` when the current selection is
 * already on an installed-and-authed agent and nothing should change.
 *
 * The model is overwritten whenever the saved model doesn't already resolve to
 * an authed agent — a stale model owned by the unauthed agent would otherwise
 * pull the WS agent derivation back to the unauthed agent. A saved model that
 * already maps to an authed agent is a deliberate pick and is preserved.
 */
export function resolveAuthedSelection(
  agents: AgentOption[],
  activeAgentId: AgentId,
  savedModelId: string | undefined,
): { agentId: AgentId; modelId: string | undefined } | null {
  const active = agents.find((a) => a.id === activeAgentId);
  if (active && active.installed && active.authConfigured) return null;

  const firstAuthed = agents.find((a) => a.installed && a.authConfigured);
  if (!firstAuthed || firstAuthed.id === activeAgentId) return null;

  const savedModelOwner = savedModelId
    ? agents.find((a) => a.models.includes(savedModelId))
    : undefined;
  const savedModelAuthed =
    !!savedModelOwner && savedModelOwner.installed && savedModelOwner.authConfigured;

  return {
    agentId: firstAuthed.id as AgentId,
    modelId: savedModelAuthed ? savedModelId : firstAuthed.models[0],
  };
}
