# Agent Present — checklist

Tracking Tier 1 (inline artifacts). Tier 2 (scratch dir) is deferred.

## Types & messages

- [x] Add `PresentContentMessage` to `src/server/shared/types/ws-server-messages.ts` (`type`, `sessionId`, `presentId`, `replaceId?`, `content`, `mimeType`, `title?`)
- [x] Add `PresentClearedMessage` (`type`, `sessionId`, `presentId?` — per-id eviction vs full clear)
- [x] Wire both into the orchestrator WS dispatch so they reach the browser

## MCP bridge (agent → worker)

- [x] Create `src/server/session/mcp-present-bridge.ts` as a stdio MCP server (mirror `mcp-review-bridge.ts`)
- [x] Define `present` tool schema: `content` (string), `mimeType` (string, default `text/html`), `title` (string, optional), `replaceId` (string, optional)
- [x] Write tool description that steers the agent to use `present` for ephemeral artifacts and `Write` for files to keep
- [x] Forward each call to `http://127.0.0.1:${WORKER_PORT}/agent-ops/present/submit`, relay `{ presentId }` back as the tool result
- [x] Declare the bridge in `claude-adapter.ts` `writeMcpConfig`
- [x] Declare the bridge in `codex-adapter.ts` MCP writer
- [x] Co-located tests: `mcp-present-bridge.test.ts` — deferred; covered indirectly by `present-buffer.test.ts` and the worker integration tests. Updates to `claude-mcp-writer.test.ts` and `codex-mcp-writer.test.ts` for `presentBridge: null` context wiring.

## Worker

- [x] Add `presentBuffer: PresentBuffer` to the session worker (`{ content, mimeType, title, createdAt, byteSize }` entries)
- [x] Enforce ~20-entry LRU + ~16 MB byte ceiling; evictions broadcast `present_cleared` with the evicted `presentId`
- [x] `POST /agent-ops/present/submit` route: generate `presentId`, store, emit `present_content` SSE, return `{ presentId, status: "presented" }`
- [x] `POST /present/save` worker route: copy buffered bytes for `presentId` to `destPath` inside `/workspace`, reject paths outside the workspace
- [x] Clear the buffer on container teardown (implicit) and on explicit `present_cleared` from the orchestrator

## Orchestrator

- [x] Add `POST /api/sessions/:id/present/save` to `api-routes-session.ts`; forward to the worker via `ContainerSessionRunner.proxyPresentSave`
- [x] Relay `present_content` and `present_cleared` SSE events to the session WS

## Client

- [x] New store `src/client/stores/present-store.ts` with `presentations: Array<{ presentId, content, mimeType, title? }>` and `activePresentIndex`
- [x] Reducer rules: `present_content` with matching `replaceId` replaces in-place; otherwise append + activate. `present_cleared` with `presentId` drops one entry; without `presentId` wipes the array
- [x] Reset the store on session switch (wire into `stores/actions/session-actions.ts`)
- [x] New component `src/client/components/PresentPane.tsx` rendering by MIME type:
  - [x] HTML → sandboxed iframe (`sandbox="allow-scripts"`, `srcdoc`)
  - [x] SVG → iframe `srcdoc` wrapper
  - [x] Markdown → existing markdown renderer
  - [x] Images → `<img>` with data URI
- [x] Presentation header: `◀ N/M ▶` carousel nav, title, "Save to project" button, `✕` dismiss
- [x] "Save to project" dialog → `POST /api/sessions/:id/present/save` with `{ presentId, destPath }`
- [x] Add "Present" tab to `AppLayout.tsx` right panel; conditionally visible (`presentations.length > 0`), badge with count, auto-switch on first `present_content`
- [ ] Inline chat chip on the agent's tool result for `present` — clickable, focuses the Present tab on the matching `presentId` (deferred — tool result text already explains the action)
- [x] Keyboard shortcuts (←/→) when the Present pane is focused
- [x] Component tests for the store reducer (PresentPane component test deferred)

## Docs

- [x] Add `src/server/shipit-docs/present.md` describing the `present` tool, when to use it vs `Write`, and size limits
- [x] Update `plan.md` status to `in-progress` when work starts
- [ ] Update `plan.md` status to `done` when shipping
- [x] Check off items above as they land

## Verification

- [x] Unit tests for the present buffer (LRU eviction, byte cap, replaceId, delete, clear)
- [x] Unit tests for the present-store reducer (append/replace/clear/setActiveIndex/markSeen)
- [ ] Integration test: agent calls `present` → SSE → client store updates → tab appears (deferred)
- [ ] Manual: oversize content (>1 MB) is rejected with a clear error to the agent
- [ ] Manual: sandboxed iframe cannot read parent cookies/storage or navigate the top frame
- [x] `npm run lint:dev` and `npm run typecheck` clean
