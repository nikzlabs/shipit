# 149 — Align spawned-session startup with user-spawned path

## Module 1 — environment preparation
- [x] Create `src/server/orchestrator/session-agent-env.ts` exporting `prepareSessionAgentEnvironment` and `finalizeSessionAgentEnvironment` plus `SessionAgentEnvDeps`.
- [x] Implement the four-step prep (cred provision + pin, `syncAgentTokenIn`, `refreshExpiredMcpOAuthTokens`, `tryPushAgentSecrets`) with the same fault-tolerance the inline blocks have today.
- [x] Implement `finalizeSessionAgentEnvironment` wrapping `syncAgentTokenBack`.

## Module 2 — agent run params
- [x] Create `src/server/orchestrator/session-agent-run-params.ts` exporting `buildAgentRunParams` and `BuildAgentRunParamsDeps`.
- [x] Move the agent-instructions / settings / model / MCP / `autoCreatePr` assembly out of `agent-execution.ts` and into the new module.

## Module 3 — PR lifecycle
- [x] Create `src/server/orchestrator/services/pr-lifecycle.ts` exporting `emitPrLifecycleAfterCommit`.
- [x] Replace both duplicated PR-lifecycle blocks in `agent-execution.ts` with calls to the helper.

## `runSystemTurn` integration
- [x] Add `buildRunParams` (required) and `postTurnPrFlow` (optional) to `SystemTurnDeps`.
- [x] Make `runSystemTurn` async and have it call `deps.buildRunParams(...)` and `deps.postTurnPrFlow?.(...)`.
- [x] Update `sendSystemMessage` callsites to use `void this._runSystemTurn(...)`.

## Registry wiring
- [x] Wire `buildRunParams` and `postTurnPrFlow` in `runner-registry-factory.ts` using the new modules.
- [x] Token write-back wired via a new `finalizeAgentEnv` hook on `SystemTurnDeps` (resolved during implementation — the hook is one line in `runSystemTurn`'s `agent.on("done")`, while a runner event would have rippled across every runner fake).

## Call sites
- [x] `runAgentWithMessage`: replace inline prep, run-params, write-back, PR-lifecycle ×2 with helper calls.
- [x] `spawnChildSession`: insert `prepareSessionAgentEnvironment` before `sendSystemMessage`; drop the redundant `provisionAgentCredentials` block.
- [x] `sendChildMessage`: insert `prepareSessionAgentEnvironment` before `sendSystemMessage`.
- [x] `triggerCiAutoFix`: insert `prepareSessionAgentEnvironment` before `sendSystemMessage`.

## Tests
- [x] Extend `agent-spawned-session.test.ts`: run-params parity (system prompt, settings, model, MCP, autoCreatePr).
- [x] Add: rotated OAuth token freshness on spawned first turn (covered in unit-test `session-agent-env.test.ts` — the integration path uses in-process runners that bypass container creds).
- [x] Add: post-turn `syncAgentTokenBack` runs on system turns (unit test for `finalizeSessionAgentEnvironment`).
- [x] Add: `prepareSessionAgentEnvironment` is idempotent (second call doesn't re-provision creds).
- [x] Verify CI auto-fix tests still pass and pick up the new env prep / run params.

## Quality
- [x] `npm run lint`
- [x] `npm run typecheck`
- [x] `npm run test:dev`
- [x] Update doc 149 with any deviations from the design discovered during implementation.
- [x] Set `status: done` and check off this checklist.
