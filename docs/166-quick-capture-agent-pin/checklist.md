# Checklist — Quick Capture agent pin

- [x] Overlay derives agent from model (`agentIdForModel(selectedModel, agentList) ?? getSavedAgentId()`)
- [x] Remove independent `selectedAgentId` source-of-truth state from the overlay
- [x] `onAgentChange` keeps persisting the picked agent without re-reading it as an agent source
- [x] Server `agentIdForModel(model)` helper in `agent-registry.ts`
- [x] `createHeadlessSession` prefers model-derived agent over conflicting `opts.agent`
- [x] Client test: stale `vibe-agent-id="codex"` + Claude model → sends `agent: "claude"`
- [x] Server test: Claude model + conflicting `agent: "codex"` pins `agentId: "claude"`
- [x] Plan doc captures root cause and references docs/142 + `agent-for-model.ts`
- [x] `npm run test:dev`, `npm run lint:dev`, `npm run typecheck` pass
