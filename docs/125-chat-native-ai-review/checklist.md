# 125 — Chat-native AI Review — Checklist

This tracks the three-phase rollout described in the plan's "Phasing"
section. Each phase is intended to be shippable on its own; reverting
later phases must leave earlier phases working.

## Phase 1 — Capability gating (DONE)

A few-line surface change that hides the existing AI Review affordance on
Codex sessions and lays the wire-format groundwork for Phase 2. Behavior
on Claude sessions is unchanged.

- [x] Add `supportsReview: boolean` to `AgentCapabilities` (server
  shared types).
- [x] Set `supportsReview: true` on Claude in both
  `claude-adapter.ts` and the static `AGENT_DEFS` in
  `src/server/shared/agent-registry.ts`.
- [x] Set `supportsReview: false` on Codex in both `codex-adapter.ts`
  and `AGENT_DEFS`.
- [x] Set a conservative `supportsReview: false` default on
  `ProxyAgentProcess` (the orchestrator publishes the real flag via the
  registry; the proxy doesn't know its target's capability).
- [x] Surface the flag on every wire shape that exports agent metadata:
  - service-layer `AgentInfo` (`services/types.ts`)
  - WS `agent_list` and `global_settings` payloads
  - `services/settings.ts:listAgents` (shared mapper)
  - the three duplicated mappers in `api-routes-bootstrap.ts`,
    `app-lifecycle.ts`, and `index.ts` (SSE on connect)
- [x] Extend the client `AgentOption` interface with `supportsReview`.
- [x] Read the flag in `useServerEvents`'s `agent_list` handler and
  default to `false` when an old server build omits the field.
- [x] Gate the AI Review button in `FilePreviewModal` on the active
  agent's `supportsReview`. Hide (don't disable) the button on Codex.
- [x] Update fixtures in every adapter / capability test that builds
  `AgentCapabilities` or `AgentOption` literals.
- [x] Add explicit `supportsReview` assertions to the Claude / Codex
  adapter tests and the agent-registry test, so a future regression that
  flips the flag is caught at unit level.
- [x] Add gating tests to `FilePreviewModal.test.tsx`: button shows on
  Claude active, hidden on Codex active, hidden when the agent list
  hasn't loaded yet.

## Phase 2 — Chat-native review on Claude (NOT STARTED)

Substantial. Lands the MCP bridge, `submit_review_comments` tool, the
allow-listed `send_review_message` flow, the `review_updated` event, the
"Ask agent to review" button rewording, and the `/review` slash command.
The old `/ai-review` endpoint stays in place but is unused by the client.

- [ ] Add `@modelcontextprotocol/sdk` to the worker image's deps.
- [ ] Ship `mcp-review-bridge.js` (stdio MCP server, no business
  logic).
- [ ] Worker generates per-session `mcp.json` and Unix socket; thread
  the config path through `mcpConfigPath`.
- [ ] Implement the worker-side review tool handler with allow-list,
  draft resolution, re-anchoring, size caps, server-side `source: "ai"`,
  and rejection on `sent` drafts.
- [ ] Add the `review_updated` worker SSE event and the corresponding
  WS server message; relay through `ContainerSessionRunner`.
- [ ] Add the `send_review_message` WS client message + handler;
  manage `runner.activeReviewFilePath` lifecycle per CLAUDE.md
  WS-resilience rules.
- [ ] Replace the AI Review button with "Ask agent to review";
  compose body with the 20-comment cap and 500-char truncation.
- [ ] Wire the `/review [@file]` slash command to the same body.
- [ ] Client store: handle `review_updated`, drop `aiReview` action.
- [ ] Stand up an MCP fake usable by integration tests; add the full
  flow integration test (chat message → tool call → draft populated →
  client receives `review_updated`).
- [ ] Tool-handler unit tests: `source: "ai"` is enforced server-side,
  rejection on sent drafts, oversize payload, re-anchor against current
  file.

## Phase 3 — Remove the old path (NOT STARTED)

Cleanup-only PR. Reverting Phase 2 leaves the old path in place; this
phase is what makes the chat-native path the only path.

- [ ] Delete `generateAiReview` and the `/ai-review` route.
- [ ] Delete the `generateText` factory and `agentFactory` plumbing
  in `app-di.ts`.
- [ ] Delete `AI_REVIEW_PROMPT_TEMPLATE`.
- [ ] Delete the client `aiReview` action and its tests.
- [ ] Update `docs/112-unified-review-surface/plan.md` to point at this
  doc as the successor for the AI Review affordance.
