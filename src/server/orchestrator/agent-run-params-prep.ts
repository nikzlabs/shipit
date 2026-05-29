/**
 * Per-agent run-params prep hooks (docs/155 Phase 3).
 *
 * `buildAgentRunParams` assembles the *shared* shape of `AgentRunParams`
 * (prompt, cwd, model, system prompt, MCP servers, resume id). Anything that's
 * meaningful only to one backend — Claude's `--settings` path, Claude's
 * `SHIPIT_AUTO_CREATE_PR` env-var driver — was previously injected via an
 * inline `agentId === "claude"` branch at the bottom of the shared assembler.
 * That branch is exactly the hair this phase is removing.
 *
 * Each backend now registers a `PrepareRunParamsFn` that receives the shared
 * params plus a small `PrepareRunParamsInput` carrying the runtime flags the
 * hook needs (today: `autoCreatePrActive`, the AND of "user opted in" and
 * "GitHub auth present"). The hook returns the params shape the backend wants
 * to spawn with — Claude's injects `settingsPath` + `autoCreatePr`; Codex's is
 * the identity function. Adding Cursor / Gemini is one new hook plus one
 * `set("cursor", …)` at the wiring site instead of growing the branch.
 *
 * Lives in the orchestrator layer (not session/) because the *call site* —
 * `buildAgentRunParams` and the system-turn `buildRunParams` hook on the
 * runner registry — runs in the orchestrator process. The backend-side
 * adapters consume the resulting params over HTTP+SSE.
 */

import type { AgentId, AgentRunParams } from "../shared/types.js";

/**
 * Runtime inputs the per-agent prep hooks may consult. Held to a small,
 * explicit shape so adding a new flag is a deliberate edit at every hook —
 * Claude's hook reads `autoCreatePrActive`, others may want it later.
 */
export interface PrepareRunParamsInput {
  /**
   * `true` iff the user opted into auto-PR (Settings) AND GitHub auth is
   * configured. Claude's hook forwards this to the adapter as `autoCreatePr`,
   * which sets `SHIPIT_AUTO_CREATE_PR=1` in the CLI env so the
   * managed-settings.json Stop hook fires PR creation. Backends without a
   * comparable Stop-hook surface ignore this entirely.
   */
  autoCreatePrActive: boolean;
}

/**
 * Per-agent run-params prep hook. Pure: takes the shared params and returns
 * the agent-specific final shape. Must not mutate `params` in place — return
 * a new object so multiple call sites can share the same hook instance.
 */
export type PrepareRunParamsFn = (
  params: AgentRunParams,
  input: PrepareRunParamsInput,
) => AgentRunParams;

/**
 * Claude's hook. Injects the managed-settings file (drives the PreToolUse
 * branch-block hook + Stop-hook PR enforcement — see docs/129, docs/130) and
 * forwards the resolved `autoCreatePr` boolean so the Stop hook self-gates on
 * the matching env var. Both fields are documented on `AgentRunParams` as
 * "Claude-only; other adapters ignore it" — keeping them off non-Claude
 * spawns is functionally equivalent (the Codex adapter ignored them anyway)
 * but removes the type-shape lie at the call site.
 */
export const prepareClaudeRunParams: PrepareRunParamsFn = (params, input) => ({
  ...params,
  settingsPath: "/etc/shipit/managed-settings.json",
  autoCreatePr: input.autoCreatePrActive,
});

/**
 * Codex's hook. Identity today — no Codex-only fields exist on
 * `AgentRunParams`. Kept as an explicit entry in the registry so the map
 * exhaustively covers every `AgentId` (a missing entry would silently fall
 * through to the no-op default, which is the same outcome but harder to
 * audit).
 */
export const prepareCodexRunParams: PrepareRunParamsFn = (params) => params;

/**
 * Identity-prep hook used when a backend hasn't registered its own. Exposed
 * so call sites can fall back cleanly without an inline conditional.
 */
export const identityPrepareRunParams: PrepareRunParamsFn = (params) => params;

/**
 * Resolve the prep hook for `agentId`. Falls back to the identity hook when
 * the map is undefined (extreme-minimal test setups) or has no entry for
 * `agentId`. Wrapped as a helper so every consumer reads the same fallback
 * rule.
 */
export function getPrepareRunParams(
  preps: Map<AgentId, PrepareRunParamsFn> | undefined,
  agentId: AgentId,
): PrepareRunParamsFn {
  return preps?.get(agentId) ?? identityPrepareRunParams;
}
