/**
 * OpenCode's run-params prep hook (docs/268, following docs/155 Phase 5).
 *
 * Identity today, like Codex's — no OpenCode-only fields exist on
 * `AgentRunParams`; the adapter derives everything (provider block, variants,
 * config file) from the shared fields at spawn. Kept as an explicit entry so
 * the registry map exhaustively covers every `AgentId`.
 */

import type { PrepareRunParamsFn } from "../../agent-run-params-prep.js";

export const prepareOpencodeRunParams: PrepareRunParamsFn = (params) => params;
