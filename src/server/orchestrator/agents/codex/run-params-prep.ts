/**
 * Codex's run-params prep hook (docs/155 Phase 3, Phase 5 consolidation).
 *
 * Identity today — no Codex-only fields exist on `AgentRunParams`. Kept as an
 * explicit entry in the registry so the map exhaustively covers every
 * `AgentId` (a missing entry would silently fall through to the no-op
 * default, which is the same outcome but harder to audit).
 */

import type { PrepareRunParamsFn } from "../../agent-run-params-prep.js";

export const prepareCodexRunParams: PrepareRunParamsFn = (params) => params;
