/**
 * Per-agent barrel for OpenCode orchestrator-side code (docs/268).
 *
 * Same shape as `../claude/index.ts` and `../codex/index.ts`, minus what the
 * launch scope deliberately omits (docs/268 req 5): no auth manager (no
 * OpenCode login integration — key-mode services only) and no limits provider
 * (no quota API to poll). The session-side adapter lives in
 * `src/server/session/agents/opencode/`.
 */

export { prepareOpencodeRunParams } from "./run-params-prep.js";
export { OPENCODE_PARALLEL_SESSIONS_SECTION } from "./system-prompt.js";
