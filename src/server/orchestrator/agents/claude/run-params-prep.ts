/**
 * Claude's run-params prep hook (docs/155 Phase 3, Phase 5 consolidation).
 *
 * Injects the managed-settings file (drives the PreToolUse branch-block hook +
 * Stop-hook PR enforcement — see docs/129, docs/130) and forwards the resolved
 * `autoCreatePr` boolean so the Stop hook self-gates on the matching env var.
 * Both fields are documented on `AgentRunParams` as "Claude-only; other
 * adapters ignore it" — keeping them off non-Claude spawns is functionally
 * equivalent (the Codex adapter ignored them anyway) but removes the
 * type-shape lie at the call site.
 */

import type { PrepareRunParamsFn } from "../../agent-run-params-prep.js";

export const prepareClaudeRunParams: PrepareRunParamsFn = (params, input) => ({
  ...params,
  settingsPath: "/etc/shipit/managed-settings.json",
  autoCreatePr: input.autoCreatePrActive,
});
