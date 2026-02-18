# 034 — Multi-Agent CLI Support — Remaining Work

## Phase 1: Abstraction layer (Complete)

- [x] `AgentProcess` interface and `AgentEvent` types (`src/server/agents/agent-process.ts`)
- [x] `ClaudeAdapter` wrapping `ClaudeProcess` (`src/server/agents/claude-adapter.ts`)
- [x] Canonical tool name mapping (`src/server/agents/tool-map.ts`)
- [x] `WsAgentEvent` and `WsSetAgentMessage` WS message types (`src/server/types.ts`)
- [x] `agentFactory` and `defaultAgentId` in `AppDeps` (`src/server/index.ts`)
- [x] Server emits both `agent_event` and `claude_event` (backward compat)
- [x] Client handles `agent_event` messages (`src/client/App.tsx`)
- [x] `StreamingIndicator` supports canonical tool names
- [x] `set_agent` WS message handler (server-side)
- [x] Tests for `ClaudeAdapter` and `tool-map` (20 tests)
- [x] All existing tests pass (1168/1168)

## Phase 2: Codex adapter

- [ ] Create `src/server/agents/codex-adapter.ts` implementing `AgentProcess`
- [ ] Parse Codex CLI NDJSON output into `AgentEvent`
- [ ] Map Codex tool names (`shell`, `file_write`, `file_read`) to canonical names
- [ ] Integration tests for Codex adapter
- [ ] Update `agentFactory` to handle `codex` agent ID

## Phase 3: Agent picker UI

- [ ] Agent selector dropdown in `MessageInput` or `StatusBar`
- [ ] Send `set_agent` WS message when user switches agents
- [ ] Show active agent indicator in chat header
- [ ] Component tests for agent picker
- [ ] Persist agent preference in localStorage

## Phase 4: Gemini adapter

- [ ] Create `src/server/agents/gemini-adapter.ts` implementing `AgentProcess`
- [ ] Parse Gemini CLI output into `AgentEvent`
- [ ] Map Gemini tool names to canonical names
- [ ] Integration tests for Gemini adapter
