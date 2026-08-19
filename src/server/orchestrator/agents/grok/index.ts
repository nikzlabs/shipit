/**
 * Per-agent barrel for Grok Build orchestrator-side code (docs/274).
 *
 * Carries an auth manager since planning#435 — {@link XaiAuthManager}, the
 * device-code flow that connects a SuperGrok subscription. It is keyed by the
 * LOGIN (`xai-oauth`) rather than by this harness, which is why it is named for
 * xAI and not for Grok.
 *
 * Still no limits provider, and that omission is a decision rather than a gap
 * (docs/274 req 16): xAI publishes no per-account usage API — every candidate
 * route 404s — so the subscription mode declares `quota: null` and ShipIt
 * reports nothing instead of an invented indicator. It gains one if the vendor
 * ever ships a usage endpoint.
 *
 * The session-side adapter lives in `src/server/session/agents/grok/`.
 */

export { XaiAuthManager } from "./auth-manager.js";
export { prepareGrokRunParams } from "./run-params-prep.js";
export { GROK_PARALLEL_SESSIONS_SECTION } from "./system-prompt.js";
