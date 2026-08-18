/**
 * Per-agent barrel for Grok Build orchestrator-side code (docs/274).
 *
 * Same shape as `../opencode/index.ts`, and omitting the same two things for
 * the same kind of reason (docs/274 req 6): no auth manager and no limits
 * provider. Grok's subscription is real and reached by the CLI's own
 * `grok login --device-auth` — it is deferred to planning#435 rather than
 * absent, so this barrel gains an auth manager when that lands and not before.
 * The session-side adapter lives in `src/server/session/agents/grok/`.
 */

export { prepareGrokRunParams } from "./run-params-prep.js";
export { GROK_PARALLEL_SESSIONS_SECTION } from "./system-prompt.js";
