# Checklist — Per-agent reasoning controls

## Shared foundation
- [ ] `reasoning` block on `AgentCapabilities` + values for claude / codex (`agent-registry.ts`)
- [ ] `reasoningEffort?: string` on `AgentRunParams` (`agent-types.ts`)
- [ ] Claude adapter: `--effort` in PTY + streaming arg builders (`claude/process.ts`, `adapter.ts`)
- [ ] Codex adapter: `-c model_reasoning_effort=` at app-server spawn (`codex/adapter.ts`)
- [ ] Tests: registry metadata distinct per agent; claude arg-build; codex arg-build

## Control A — Global default (Settings → sub-agents)
- [ ] `agentReasoning` map + accessors on `CredentialStore`
- [ ] `agentReasoning` in `GlobalSettings` + `get/saveGlobalSettings`
- [ ] `PUT /api/settings` accepts + merges partial `agentReasoning`
- [ ] Validation rejects unknown agent / out-of-set value
- [ ] Sub-agent spawn reads `getAgentReasoning(subAgentId)` (`sub-agent-run.ts`, `services/sub-agent.ts`)
- [ ] Settings UI: per-agent reasoning row (read/write the map)
- [ ] Tests: credential-store round-trip/persist; settings get/save merge; validation reject; sub-agent injection

## Control B — Session control (composer → active turns)
- [ ] `reasoning_effort` column + migration (`database.ts`)
- [ ] `sessions.ts` read/write (`fromRow`, `setReasoning`)
- [ ] `set_reasoning` WS message + dispatch + per-connection state
- [ ] `buildAgentRunParams` sets `reasoningEffort` from per-session value
- [ ] Pre-pin agent-switch self-heal to default when value invalid for new agent
- [ ] `ReasoningSelector.tsx` in composer toolbar + localStorage per-agent seed
- [ ] `settings-store` wiring for composer value
- [ ] Tests: sessions round-trip; set_reasoning handler; run-params injection; `ReasoningSelector` render/select

## Wrap-up
- [ ] `npm run typecheck` + `npm run lint:dev` clean
- [ ] Browser-check both controls (Claude vs Codex option sets; persistence across reload)
- [ ] Spot-check spawned commands (claude `--effort`, codex `-c model_reasoning_effort=`, default = neither)
- [ ] Update `plan.md` with any new subsystems discovered during implementation
