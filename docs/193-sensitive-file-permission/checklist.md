# Checklist — 193 sensitive-file permission prompt (SHI-112)

- [x] Agent-agnostic `PermissionBroker` (request/resolve/remember/teardown — no timeout, no expiry)
- [x] Claude `--permission-prompt-tool` bridge + adapter/process wiring
- [x] Codex approval requests routed through the broker (with auto-accept fallback)
- [x] Canonical `agent_permission_request` / `agent_permission_resolved` events + `AgentProcess` methods
- [x] Worker endpoints: `/agent-ops/permission/request` (blocking) + `/agent/permission/resolve`
- [x] Orchestrator resolve path (ProxyAgentProcess → ContainerSessionRunner → worker)
- [x] agent-listeners: emit + persist pending card; patch terminal state
- [x] WS message types (client `resolve_permission`; server card + resolved) + dispatch + handler
- [x] Persistence: `permissionPrompt` field + DB column + migration + `updatePermissionCard`
- [x] Client: store, `PermissionRequestCard`, message handlers, render, rehydrate, send wiring
- [x] Tests: broker, persistence, process flag, mcp registration, codex routing, worker round-trip, render guard
- [x] Typecheck + lint clean
- [x] Verify end-to-end in a real container session (manual): `.npmrc` edit surfaces the card; approve lets the write land (verified live, SHI-112). "remember" suppresses re-prompts — re-verifying
- [x] Confirm the Codex deny enum against `codex app-server generate-json-schema` — live schema has no `"reject"`; v2 deny is `"decline"` (`"cancel"` also interrupts the turn), v1 is `"denied"`. Fixed the stale `"reject"` mapping in `codex-event-handler.ts`
