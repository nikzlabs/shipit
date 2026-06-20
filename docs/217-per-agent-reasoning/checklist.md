# Checklist — Per-agent reasoning controls

## Shared foundation
- [x] `reasoning` block on `AgentCapabilities` + values for claude / codex (`agent-registry.ts`)
- [x] `reasoningEffort?: string` on `AgentRunParams` (`agent-types.ts`)
- [x] Claude adapter: `--effort` in PTY + streaming arg builders (`claude/process.ts`, `adapter.ts`)
- [x] Codex adapter: `-c model_reasoning_effort=` at app-server spawn (`codex/adapter.ts`)
- [x] Tests: registry metadata distinct per agent; claude arg-build; codex arg-build

## Control A — Sub-agent defaults (per-agent Settings tab → sub-agents)
- [x] `agentSubAgentDefaults` map (`Record<agentId, { reasoningEffort? }>`) + merge accessors on `CredentialStore`
- [x] `agentSubAgentDefaults` in `GlobalSettings` + `get/saveGlobalSettings`
- [x] `PUT /api/settings` accepts + merges partial `agentSubAgentDefaults`
- [x] Validation rejects unknown agent / out-of-set `reasoningEffort`
- [x] Sub-agent spawn reads `getAgentSubAgentDefaults(subAgentId).reasoningEffort` (threaded through `sub-agent-run.ts`, `services/sub-agent.ts`, runners, worker)
- [x] Settings UI: "Sub-agent defaults" section on `ClaudeTab`/`CodexTab` (`SubAgentDefaultsSection.tsx`)
- [x] Client store hydration (`agentSubAgentDefaults` in settings-store, bootstrap, settings broadcast)
- [x] Tests: credential-store round-trip/persist/clear

## Control B — Session control (composer → active turns)
- [x] `reasoning_effort` column + migration (`database.ts`)
- [x] `sessions.ts` read/write (`fromRow`, `setReasoning`) + `SessionInfo.reasoningEffort`
- [x] `set_reasoning` WS message + dispatch handler + per-connection state (`route-registry.ts`)
- [x] `buildAgentRunParams` sets `reasoningEffort` from per-session value (WS + system-turn paths)
- [x] Pre-pin agent-switch self-heal to default when value invalid for new agent (connect seed + `set_agent`)
- [x] `ReasoningSelector.tsx` in composer toolbar + per-agent localStorage seed + `set_reasoning` send
- [x] Tests: `ReasoningSelector` render + value-precedence

## Wrap-up
- [x] `npm run typecheck` + `npm run lint:dev` clean
- [ ] Browser-check both controls (Claude vs Codex option sets; persistence across reload) — requires booting the heavy manual `dev` preview; deferred to avoid in-session OOM
- [ ] Spot-check spawned commands in a live run (claude `--effort`, codex `-c model_reasoning_effort=`, default = neither)
