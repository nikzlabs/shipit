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

- [ ] Define `writeMcpConfig(workspaceDir, servers, params)` method on each adapter.
- [ ] Move `generateMcpConfig` (`session-worker.ts:178`) into Claude adapter.
- [ ] Move `ensureCodexMcpConfig` (`session-worker.ts:443`) into Codex adapter.
- [ ] Replace hair 10 — worker calls `adapter.writeMcpConfig(...)` unconditionally.
- [ ] Confirm the `wireAgentEvents` and cleanup paths in `session-worker.ts` still fire correctly.

## Phase 5 — Per-agent folder consolidation

### Session layer

- [ ] Create `src/server/session/agents/claude/` and move:
  - [ ] `claude-adapter.ts` → `claude/adapter.ts` (+ test)
  - [ ] `../claude.ts` → `claude/process.ts` (+ test)
  - [ ] `../claude-auth-detection.test.ts` → `claude/auth-detection.test.ts`
- [ ] Create `src/server/session/agents/codex/` and move:
  - [ ] `codex-adapter.ts` → `codex/adapter.ts` (+ test)
  - [ ] `../codex-review-mcp.test.ts` → `codex/review-mcp.test.ts`
- [ ] Split `tool-map.ts` into per-agent slices + a merger.
- [ ] Update all importers.

### Orchestrator layer

- [ ] Create `src/server/orchestrator/agents/claude/` and move:
  - [ ] `auth.ts` (Claude-specific parts) → `claude/auth-manager.ts`
  - [ ] `claude-oauth-refresher.ts` → `claude/oauth-refresher.ts` (+ test)
  - [ ] `limits/claude-limits.ts` → `claude/limits-provider.ts` (+ test)
  - [ ] Extract Claude system-prompt fragment from `agent-instructions.ts` → `claude/system-prompt.ts`
- [ ] Create `src/server/orchestrator/agents/codex/` and move:
  - [ ] `codex-auth.ts` → `codex/auth-manager.ts` (+ test)
  - [ ] `limits/codex-limits.ts` → `codex/limits-provider.ts` (+ test)
  - [ ] Extract Codex system-prompt fragment → `codex/system-prompt.ts`
- [ ] Create `orchestrator/agents/index.ts` exporting `buildAgentRuntime()`.
- [ ] Update app-DI to use `buildAgentRuntime()`.
- [ ] Delete the now-empty `orchestrator/limits/` directory.

### Shared layer

- [ ] Move `types/agent-types.ts` → `agents/types.ts` (or keep — low value to move).
- [ ] Move `agent-registry.ts` → `agents/registry.ts` (or keep).
- [ ] Add `agents/capabilities.ts` if not folded into types.

### Client layer (optional / cosmetic)

- [ ] Decide: move `client/themes/{claude,codex}*.css` into `client/agents/<id>/theme*.css`, or defer.

## Phase 6 — Documentation and pattern enforcement

- [ ] Update CLAUDE.md "Project structure" section to reflect new layout.
- [ ] Write `docs/N-add-an-agent.md` walkthrough.
- [ ] Optional: ESLint rule flagging `agentId === "claude"` / `agentId === "codex"` outside `agents/<id>/` folders.
- [ ] Optional: integration test that verifies the per-agent runtime tables have an entry for every `AgentId` value (compile-time exhaustiveness via `satisfies Record<AgentId, ...>` should be enough).

## Wider audit (one-off, before starting)

- [ ] Re-run `grep -rn 'agentId === "claude"\|agentId === "codex"\|agentId !== "claude"\|agentId !== "codex"' src/` and confirm the inventory in `plan.md` is current.
- [ ] Grep `src/client/` for `activeAgentId === "claude"` / `activeAgentId === "codex"` and add any missing sites.
- [ ] Confirm whether `docs/154-cursor-agent-adapter` will land before or after this refactor; align the doc accordingly.
