# Checklist — Agent abstraction hairs

Tracks the phased cleanup from `plan.md`. Phases are independently mergeable;
items inside a phase can be done in any order.

## Phase 0 — Capability knobs

- [x] Add `skillsDirName` to `AgentCapabilities` and populate for claude/codex.
- [x] Add `skillInvocationPrefix` to `AgentCapabilities` and populate.
- [x] Replace hair 5 (`services/skills.ts:28` + `services/marketplace.ts:351`) with capability reads.
- [x] Replace hair 6 (`services/marketplace.ts:359` + `MessageInput.tsx:333`) with capability reads.
- [x] Promote `AUTH_ENV_KEYS` from private to a registry method `getAuthEnvKey(agentId)`.
- [x] Replace hair 1 (`services/settings.ts:167` + `index.ts:1361`) with the registry method.

## Phase 1 — Dispatch tables

- [x] Build `limitsProviders: Map<AgentId, LimitsProvider>` at app-DI.
- [x] Replace hair 2 (`index.ts:453-460`) with a one-line map lookup.
- [x] Delete or update the misleading comment that says "single callback serves every backend."
- [x] Add an `onAuthRequired` per-agent hook table.
- [x] Replace hair 3 (`agent-listeners.ts:865`) with a hook lookup.

## Phase 2 — `AgentAuthManager` interface

- [x] Sketch the interface (`start`, `cancel`, `signOut`, `isConfigured`, `kill`, normalized `complete`/`failed` events). Per-agent shaped events (`auth_url`, `codex_auth_pending`) stay on the concrete classes — payloads differ across backends, lifting them would force `unknown`-typed events and trip the STOP-GATE.
- [x] Retrofit `auth.ts` (Claude OAuth) to the interface — `start()`/`cancel()`/`isConfigured()` alias the Claude-specific entry points; `complete`/`failed` emit alongside the legacy `auth_complete`/`auth_failed` events.
- [x] Retrofit `codex-auth.ts` to the interface — `start()` aliases `startDeviceFlow()`; `cancel()`/`kill()`/`signOut()` already match; `complete`/`failed` emit alongside the legacy `codex_auth_*` events.
- [x] Replace the post-completion dispatch with a `Map<AgentId, AgentAuthManager>` lookup: limits-registry rearm in `index.ts`, shared post-completion bookkeeping in `wireEventHandlers` (`app-lifecycle.ts`), and the shutdown-hook `kill()` calls (`shutdown-manager.ts`).

### Phase 2b — Unify the SSE event family (carved out from Phase 2)

The wire format was the last per-agent surface in our own code (not a CLI restriction). Adding Cursor would otherwise mean a third `cursor_auth_*` event triplet plus three client handlers — same shape of duplication this phase set out to remove. Listed here because it belongs to Phase 2 (auth-manager dispatch); not covered by Phases 3-5.

- [x] Extend `AgentAuthManager` with typed `pending` event (`AgentAuthPendingDetails` discriminated union: `code-paste-url` | `device-code`), optional-payload `failed` event (`{reason?, message?}`), and `getPendingPayload()` for SSE replay.
- [x] Add `WsAgentAuthPending` / `WsAgentAuthComplete` / `WsAgentAuthFailed` WS-message + SSE-event types in `ws-server-messages.ts`.
- [x] Remove the old `WsCodexAuthPending` / `WsCodexAuthComplete` / `WsCodexAuthFailed` types — the unified family supersedes them. Keep `WsAuthRequired` (per-session WS message — different semantics: "this turn failed, please sign in").
- [x] Emit the typed `pending`/`failed` events from `AuthManager` and `CodexAuthManager` alongside their legacy emits; implement `getPendingPayload()` on each (Codex translates its cached device-flow payload; Claude now caches the URL in `lastPendingDetails` and exposes it for reconnect replay — strict improvement over the old behavior, which dropped the URL on reload).
- [x] Replace per-agent SSE broadcasts in `wireEventHandlers` with one loop over the auth-manager map (`agent_auth_pending` / `agent_auth_complete` / `agent_auth_failed`, all carrying `agentId`). Per-agent legacy SSE emits deleted.
- [x] Replace the codex-specific SSE-on-connect replay in `index.ts` with a loop over the map calling `getPendingPayload()` — every backend that has a cached pending payload replays it on reconnect (so Claude's mid-flow page reload now also recovers the URL).
- [x] Update the other SSE rebroadcasters to the unified names: `api-routes-bootstrap.ts` (post-API-key `auth_complete` → `agent_auth_complete`) and `claude-oauth-refresher.ts` (revoked-account `auth_required` → `agent_auth_failed` with `reason: "revoked"`).
- [x] Update the client `useServerEvents` SSE handlers and the stores/components downstream of them (`session-store.setAuthUrl`, `settings-store.setCodexDeviceAuth*`, `CodexAuthCard`) to consume the unified events. The client dispatches on `agentId` + `details.kind` instead of per-event-name handlers.

### Phase 2c — Dispatch table at the auth_required call site

- [x] Replace the hardcoded `deps.authManager.startOAuthFlow()` in `agent-listeners.ts:1004` with a map lookup (`deps.authManagers?.get(turnSession.agentId)?.start()`) so the auth-required handler restarts the right backend's flow, not Claude's, when a non-Claude turn fails. Piped `authManagers` through `AppCtx`, `ApiDeps`, `AgentListenerDeps`, and the runner-registry-factory deps so system-turn listeners get the same routing. Legacy fallback to `authManager.startOAuthFlow()` preserved for tests that don't construct the map.

### Tests + verification

- [x] Updated integration tests to the new SSE event names (`integration_tests/codex-auth.test.ts`, `integration_tests/claude-auth.test.ts`, `claude-oauth-refresher.test.ts`); `StubAuthManager` in `test-helpers.ts` extended with the `AgentAuthManager` surface so `prompt-queuing.test.ts`'s `auth_required` flow keeps working.
- [x] `npm run typecheck`, `npm run lint:dev`, `npx vitest run src/server/orchestrator/integration_tests/` — full integration suite passes (744 tests). Per-file auth manager + refresher unit tests pass (99 tests).

## Phase 3 — Per-agent run-params prep hooks

- [x] Add `prepareRunParams(params, input): AgentRunParams` hook per agent module — defined in new `agent-run-params-prep.ts` with `prepareClaudeRunParams`, `prepareCodexRunParams`, and an `identityPrepareRunParams` fallback used when the map has no entry for an `AgentId` (so a Cursor/Gemini drop-in works before its hook is wired). The hook receives a small `PrepareRunParamsInput` carrying runtime flags (today: `autoCreatePrActive`) so backends consult only an explicit, audited surface — not the full assembler context.
- [x] Move `settingsPath` injection out of `session-agent-run-params.ts:106` into Claude's hook — `prepareClaudeRunParams` returns the params with `/etc/shipit/managed-settings.json` attached.
- [x] Replace hair 4 with the hook table call — `buildAgentRunParams` resolves the hook via `getPrepareRunParams(deps.runParamsPreps, agentId)` and invokes it. The map is constructed once in `index.ts` (next to `authManagers`) and threaded through `AppCtx`, `ApiDeps`, and `RunnerRegistryDeps` so both the WS path (`agent-execution.ts`) and the system-turn path (`runner-registry-factory.ts buildRunParams`) share the same prep table.
- [x] Audit `AgentRunParams` for other "Claude-only" / "Codex-only" fields and route them through hooks — `autoCreatePr` was the only other Claude-only field documented on the run-params shape. Moved into Claude's hook (it was previously set unconditionally; Codex adapter ignored it). `useStreaming` is set at the WS call site (`currentAgent.run({ ...runParams, useStreaming })`) rather than inside `buildAgentRunParams`, so it didn't need routing through a hook. No Codex-only run-params fields exist today (Codex's MCP config-toml writing lives in `session-worker.ts` and is Phase 4 work, not Phase 3).
- [x] Tests + verification — new unit tests in `agent-run-params-prep.test.ts` cover the per-agent hooks, identity fallback, and registry lookup (including a "Cursor not registered yet" case). `npm run typecheck`, `npm run lint:dev`, and the full `src/server/orchestrator/integration_tests/` suite (744 tests) pass; `agent-spawned-session.test.ts` continues to assert the spawned session's first turn carries `settingsPath = "/etc/shipit/managed-settings.json"` via the new hook path.

## Phase 4 — Per-agent MCP writers

- [x] Define `writeMcpConfig(ctx): AgentMcpWriteResult` method on the `AgentProcess` interface — `ctx` carries `{ servers, reviewBridge, onServerFailed }` (the per-spawn cross-cutting context the worker owns) and the result is `{ mcpConfigPath?, runtimeEnv?, cleanup? }` (Claude returns `mcpConfigPath` + `cleanup`; Codex returns `runtimeEnv` from env-indirection). New types `AgentMcpReviewBridge`, `AgentMcpWriteContext`, `AgentMcpWriteResult` live in `shared/types/agent-types.ts`.
- [x] Move `generateMcpConfig` (`session-worker.ts:178`) into `ClaudeAdapter.writeMcpConfig` — writes the per-turn `/tmp/mcp-config-*.json` (Playwright + review bridge + `$secret:`-resolved user servers) and returns the path + an unlink cleanup. Missing-secret servers are reported via `ctx.onServerFailed()` (worker rebroadcasts as `mcp_server_status`).
- [x] Move `ensureCodexMcpConfig` (`session-worker.ts:443`) into `CodexAdapter.writeMcpConfig` — rewrites the `<shipit-managed-mcp>` block in `~/.codex/config.toml` (review bridge + user servers as `[mcp_servers.*]`) and returns `runtimeEnv` so secrets stay out of disk. The compatibility wrapper `ensureCodexReviewMcpConfig` is gone.
- [x] Replace hair 10 — worker's `/agent/start` now calls a single `invokeAgentMcpWriter(this.agent, params)` helper unconditionally; the two `agentId === "claude"` / `agentId === "codex"` branches are deleted. `withTemporaryEnv(mcpWrite.runtimeEnv ?? {}, …)` applies whatever the adapter returned; `mcpWrite.cleanup` is wired to `agent.on("done", …)` only if the adapter asked for it.
- [x] Confirm the `wireAgentEvents` and cleanup paths in `session-worker.ts` still fire correctly — agent factory is called first, then `writeMcpConfig`, then `run()` with the adapter-supplied `mcpConfigPath` threaded through; cleanup attaches on `done` exactly when the adapter returned one (Claude only).
- [x] `ProxyAgentProcess` (orchestrator-side) implements `writeMcpConfig` as a loud throw — MCP writing belongs inside the worker container on the real adapter; reaching the proxy method means a wiring bug.
- [x] Tests + verification — `codex-review-mcp.test.ts` was migrated to `agents/codex-mcp-writer.test.ts` (tests `CodexAdapter.writeMcpConfig` directly — no SessionWorker reach-through, plus a new "drops missing-secret servers and calls onServerFailed" case); new sibling `agents/claude-mcp-writer.test.ts` covers ClaudeAdapter's writer end-to-end (playwright always present, review bridge conditional, `$secret:` substitution, missing-secret drop, cleanup unlinks). FakeWorkerAgent/FakeAgent/FakeCodexProcess stubs across integration tests grew a no-op `writeMcpConfig(): {}`. `npm run typecheck`, lint, and the full `src/server/orchestrator/integration_tests/` (744 tests) + `src/server/session/` (393 tests) suites pass.

## Phase 5 — Per-agent folder consolidation

### Session layer

- [x] Create `src/server/session/agents/claude/` and move:
  - [x] `claude-adapter.ts` → `claude/adapter.ts` (+ test)
  - [x] `../claude.ts` → `claude/process.ts` (+ test)
  - [x] `../claude-auth-detection.test.ts` → `claude/auth-detection.test.ts`
  - [x] `claude-mcp-writer.test.ts` → `claude/mcp-writer.test.ts`
- [x] Create `src/server/session/agents/codex/` and move:
  - [x] `codex-adapter.ts` → `codex/adapter.ts` (+ test)
  - [x] `codex-mcp-writer.test.ts` → `codex/mcp-writer.test.ts` (the older `codex-review-mcp.test.ts` was already migrated to `codex-mcp-writer.test.ts` in Phase 4)
- [x] Split `tool-map.ts` into per-agent slices + a merger — `claude/tool-map.ts` + `codex/tool-map.ts` exported as `CLAUDE_TOOL_MAP` / `CODEX_TOOL_MAP`; `agents/tool-map.ts` merges them into `AGENT_TOOL_MAPS`. `canonicalizeTool()` / `agentToolName()` keep their public signatures.
- [x] Update all importers (`session-worker.ts`, `agents/index.ts`, every per-agent test).

### Orchestrator layer

- [x] Create `src/server/orchestrator/agents/claude/` and move:
  - [x] `auth.ts` (Claude-specific parts) → `claude/auth-manager.ts` (+ test)
  - [x] `claude-oauth-refresher.ts` → `claude/oauth-refresher.ts` (+ test)
  - [x] `limits/claude-limits.ts` → `claude/limits-provider.ts` (+ test)
  - [x] Extract Claude system-prompt fragment from `agent-instructions.ts` → `claude/system-prompt.ts`
  - [x] Extract Claude prep hook → `claude/run-params-prep.ts` (re-exported through `agent-run-params-prep.ts` for back-compat).
- [x] Create `src/server/orchestrator/agents/codex/` and move:
  - [x] `codex-auth.ts` → `codex/auth-manager.ts` (+ test)
  - [x] `limits/codex-limits.ts` → `codex/limits-provider.ts` (+ test)
  - [x] Extract Codex system-prompt fragment → `codex/system-prompt.ts`
  - [x] Extract Codex prep hook → `codex/run-params-prep.ts`.
- [x] Create `orchestrator/agents/index.ts` exporting `buildAgentRuntime()` — assembles `authManagers`, `limitsProviders`, `runParamsPreps`, `parallelSessionsSections` maps in one place.
- [x] Update `index.ts` to call `buildAgentRuntime({ authManager, codexAuthManager })` and destructure the maps. Inline `new ClaudeLimitsProvider(…)` / `new CodexLimitsProvider(…)` / `runParamsPreps.set(...)` cascades removed.
- [x] Move `limits/types.ts` → `agents/types.ts` (LimitsProvider interface). Delete the now-empty `orchestrator/limits/` directory (gone — Git auto-removed it when the last file moved out).

### Shared layer

- [ ] Move `types/agent-types.ts` → `agents/types.ts` — DEFERRED. Plan flagged it as "or keep — low value to move." Skipping; current location is consistent with sibling type files under `shared/types/`.
- [ ] Move `agent-registry.ts` → `agents/registry.ts` — DEFERRED for the same reason. The registry already exports `AgentInfo` and the per-capability flags consumers need; no consumers branch on its location.
- [ ] Add `agents/capabilities.ts` if not folded into types — N/A, capabilities live on `AgentInfo` already.

### Client layer (optional / cosmetic)

- [ ] Decide: move `client/themes/{claude,codex}*.css` into `client/agents/<id>/theme*.css`, or defer — DEFERRED. Cosmetic move with non-trivial CSS import-path churn; the plan called this out as likely-defer.

## Phase 6 — Documentation and pattern enforcement

- [x] Update CLAUDE.md "Project structure" section to reflect new layout — session `agents/{claude,codex}/` subtree + orchestrator `agents/{claude,codex}/` subtree both listed; `auth.ts` / `claude.ts` removed from the flat listings.
- [x] Write `docs/158-add-an-agent/plan.md` walkthrough — covers all six steps (registry widening, session-side adapter folder, orchestrator-side folder, `buildAgentRuntime()` wiring, app-DI changes, client theme), with the "≤5 files outside the new folder" target codified.
- [ ] Optional: ESLint rule flagging `agentId === "claude"` / `agentId === "codex"` outside `agents/<id>/` folders — DEFERRED. Worth doing if the abstraction starts leaking again; not required for the immediate goal.
- [ ] Optional: integration test that verifies the per-agent runtime tables have an entry for every `AgentId` value — DEFERRED. Compile-time exhaustiveness via the `Map<AgentId, …>` construction already trips TS when `AgentId` is widened.

## Wider audit (one-off, before starting)

- [x] Re-run grep for `agentId === "claude" | "codex"` — confirmed in Phase 4 commit; inventory still matches. The remaining branches are the legitimate construction switch in `createWorkerAgent`, the per-agent system-prompt fragment selector (now a one-line map lookup via the runtime table), and the v1-only marketplace install gate (hair 7 — deliberately not generalized yet).
- [x] Grep `src/client/` for `activeAgentId === "claude"` / `activeAgentId === "codex"` — completed during Phases 0-4; remaining sites are exhaustive `switch` statements that TypeScript will flag on union widening.
- [x] Confirm whether `docs/154-cursor-agent-adapter` will land before or after this refactor — this refactor lands first; Cursor adopts the new per-agent layout from the start per docs/158.
