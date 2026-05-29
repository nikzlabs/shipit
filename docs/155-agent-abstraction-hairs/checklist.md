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
- [x] STOP-GATE held: interface has zero `unknown` types — typed lifecycle methods plus zero-payload normalized events. Per-agent SSE broadcasts stay on the concrete classes where the payload shapes diverge.

## Phase 3 — Per-agent run-params prep hooks

- [ ] Add `prepareRunParams(params): AgentRunParams` hook per agent module.
- [ ] Move `settingsPath` injection out of `session-agent-run-params.ts:106` into Claude's hook.
- [ ] Replace hair 4 with the hook table call.
- [ ] Audit `AgentRunParams` for other "Claude-only" / "Codex-only" fields and route them through hooks.

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
