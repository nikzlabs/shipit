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

## Phase 2 — Chat-native review on Claude (DONE)

Substantial. Lands the MCP bridge, `submit_review_comments` tool, the
allow-listed `send_review_message` flow, the `review_updated` event, the
"Ask agent to review" button rewording, and the `/review` slash command.
The old `/ai-review` endpoint stays in place but is unused by the client.

**Architectural deltas from the plan (intentional, confirmed during impl):**

- **The tool handler runs in the orchestrator, not the worker.** The plan
  put it in the worker, but `FileReviewStore` (the DB) and the runner's
  `activeReviewFilePath` allow-list both live in the orchestrator, and the
  worker is a separate container in prod with no access to either. So the
  flow is **bridge → worker `/agent-ops/review/submit` → orchestrator
  `POST /api/sessions/:id/review-submit`**. The worker is a thin relay that
  injects the trusted `SESSION_ID` (the existing agent-ops broker pattern);
  all business logic, allow-list auth, persistence, and the `review_updated`
  broadcast live in the orchestrator. Every plan *decision* is preserved.
- **HTTP relay, not a Unix socket.** The bridge POSTs to the worker's
  existing localhost HTTP server (`WORKER_PORT`), exactly like the `gh`/
  `shipit` shims. Each worker already has its own port, so the plan's
  Unix-socket "local-mode collision" concern doesn't apply.
- **No worker SSE `review_updated` event.** Because persistence happens in
  the orchestrator, it broadcasts `review_updated` directly via the
  resolved runner's `emitMessage` — the worker→orchestrator SSE hop the
  plan described (touchpoints 1–2) is unnecessary.
- **Bridge ships as `mcp-review-bridge.ts` run via tsx-by-absolute-path**
  (mirrors the `gh` shim), not `.js`. Uses the SDK's low-level `Server`
  with plain JSON Schema to avoid a direct `zod` dependency.

- [x] Add `@modelcontextprotocol/sdk` to the worker image's deps.
- [x] Ship `mcp-review-bridge.ts` (stdio MCP server, no business logic).
- [x] Worker generates `mcp.json` declaring the bridge (reached via
  `WORKER_PORT` HTTP, not a socket); threaded through `mcpConfigPath`.
- [x] Implement the review tool handler (in the orchestrator) with
  allow-list, draft resolution, re-anchoring, size caps, server-side
  `source: "ai"`, and rejection on `sent` drafts.
- [x] Add the `review_updated` WS server message; broadcast via the
  runner's `emitMessage` (no worker SSE hop needed).
- [x] Add the `send_review_message` WS client message + handler;
  manage `runner.activeReviewFilePath` lifecycle (set at turn start in
  `runAgentWithMessage`, cleared on done, registry-resolved) per
  CLAUDE.md WS-resilience rules.
- [x] Replace the AI Review button with "Ask agent to review";
  compose body with the 20-comment cap and 500-char truncation.
- [x] Wire the `/review [@file]` slash command to the same body.
- [x] Client store: handle `review_updated`, drop `aiReview` action.
- [x] Full-flow integration test (`review-chat-native.test.ts`): chat
  message → simulated tool call → draft populated → client receives
  `review_updated`; plus allow-list rejection cases.
- [x] Tool-handler unit tests (`reviews.test.ts`): `source: "ai"` enforced
  server-side, rejection on sent drafts, oversize payload, re-anchor
  against current file.

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
