/**
 * Per-agent barrel for Claude orchestrator-side code (docs/155 Phase 5).
 *
 * Adapter and process live in `src/server/session/agents/claude/` because they
 * run inside the session worker container; everything that lives in the
 * orchestrator process — auth manager, OAuth refresher, limits provider,
 * run-params prep, system-prompt fragment — is re-exported here so
 * `agents/index.ts buildAgentRuntime()` can wire it into the runtime tables
 * without knowing the per-file layout.
 */

export { AuthManager } from "./auth-manager.js";
export { ClaudeOAuthRefresher } from "./oauth-refresher.js";
export { ClaudeLimitsProvider } from "./limits-provider.js";
export { prepareClaudeRunParams } from "./run-params-prep.js";
export { CLAUDE_PARALLEL_SESSIONS_SECTION } from "./system-prompt.js";
