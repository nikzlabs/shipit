/**
 * Grok's run-params prep hook (docs/274, following docs/155 Phase 5).
 *
 * Identity today, like Codex's and OpenCode's — no Grok-only fields exist on
 * `AgentRunParams`; the adapter derives everything (config.toml, compat
 * toggles, session id, prompt file) from the shared fields at spawn. Kept as an
 * explicit entry so the registry map exhaustively covers every `AgentId`.
 */

import type { PrepareRunParamsFn } from "../../agent-run-params-prep.js";

export const prepareGrokRunParams: PrepareRunParamsFn = (params) => params;
