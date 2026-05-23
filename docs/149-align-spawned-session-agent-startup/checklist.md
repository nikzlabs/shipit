# 149 — Align spawned-session startup with user-spawned path

## Module 1 — environment preparation
- [ ] Create `src/server/orchestrator/session-agent-env.ts` exporting `prepareSessionAgentEnvironment` and `finalizeSessionAgentEnvironment` plus `SessionAgentEnvDeps`.
- [ ] Implement the four-step prep (cred provision + pin, `syncAgentTokenIn`, `refreshExpiredMcpOAuthTokens`, `tryPushAgentSecrets`) with the same fault-tolerance the inline blocks have today.
- [ ] Implement `finalizeSessionAgentEnvironment` wrapping `syncAgentTokenBack`.

## Module 2 — agent run params
- [ ] Create `src/server/orchestrator/session-agent-run-params.ts` exporting `buildAgentRunParams` and `BuildAgentRunParamsDeps`.
- [ ] Move the agent-instructions / settings / model / MCP / `autoCreatePr` assembly out of `agent-execution.ts` and into the new module.

## Module 3 — PR lifecycle
- [ ] Create `src/server/orchestrator/services/pr-lifecycle.ts` exporting `emitPrLifecycleAfterCommit`.
- [ ] Replace both duplicated PR-lifecycle blocks in `agent-execution.ts` with calls to the helper.

## `runSystemTurn` integration
- [ ] Add `buildRunParams` (required) and `postTurnPrFlow` (optional) to `SystemTurnDeps`.
- [ ] Make `runSystemTurn` async and have it call `deps.buildRunParams(...)` and `deps.postTurnPrFlow?.(...)`.
- [ ] Update `sendSystemMessage` callsites to use `void this._runSystemTurn(...)`.

## Registry wiring
- [ ] Wire `buildRunParams` and `postTurnPrFlow` in `runner-registry-factory.ts` using the new modules.
- [ ] Register a post-turn `finalizeSessionAgentEnvironment` listener on each created runner (so system-turn token write-back happens without a third `SystemTurnDeps` hook). Decide listener vs hook during implementation.

## Call sites
- [ ] `runAgentWithMessage`: replace inline prep, run-params, write-back, PR-lifecycle ×2 with helper calls.
- [ ] `spawnChildSession`: insert `prepareSessionAgentEnvironment` before `sendSystemMessage`; drop the redundant `provisionAgentCredentials` block.
- [ ] `sendChildMessage`: insert `prepareSessionAgentEnvironment` before `sendSystemMessage`.
- [ ] `triggerCiAutoFix`: insert `prepareSessionAgentEnvironment` before `sendSystemMessage`.

## Tests
- [ ] Extend `agent-spawned-session.test.ts`: run-params parity (system prompt, settings, model, MCP, autoCreatePr).
- [ ] Add: rotated OAuth token freshness on spawned first turn.
- [ ] Add: post-turn `syncAgentTokenBack` runs on system turns.
- [ ] Add: `prepareSessionAgentEnvironment` is idempotent (second call doesn't re-provision creds).
- [ ] Verify CI auto-fix tests still pass and pick up the new env prep / run params.

## Quality
- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run test:dev`
- [ ] Update doc 149 with any deviations from the design discovered during implementation.
- [ ] Set `status: done` and check off this checklist.
