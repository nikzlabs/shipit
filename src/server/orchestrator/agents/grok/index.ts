/**
 * Per-agent barrel for Grok Build orchestrator-side code (docs/274).
 *
 * Carries an auth manager since planning#435 — {@link XaiAuthManager}, the
 * device-code flow that connects a SuperGrok subscription. It is keyed by the
 * LOGIN (`xai-oauth`) rather than by this harness, which is why it is named for
 * xAI and not for Grok.
 *
 * The quota reader is NOT here, and that is the same rule GLM's follows: a
 * reader belongs to the vendor's subscription rather than to a harness, so it
 * lives in `orchestrator/limits/xai-limits-provider.ts` and declares its own
 * `(xai, sub)`. This barrel is the harness-side code that happens to share a
 * vendor with it.
 *
 * The session-side adapter lives in `src/server/session/agents/grok/`.
 */

export { XaiAuthManager } from "./auth-manager.js";
export { prepareGrokRunParams } from "./run-params-prep.js";
export { GROK_PARALLEL_SESSIONS_SECTION } from "./system-prompt.js";
