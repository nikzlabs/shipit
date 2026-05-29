# Agent Present — checklist

Tracking Tier 1 (inline artifacts). Tier 2 (scratch dir) is deferred.

## Types & messages

- [ ] Add `PresentContentMessage` to `src/server/shared/types/ws-server-messages.ts` (`type`, `sessionId`, `presentId`, `replaceId?`, `content`, `mimeType`, `title?`)
- [ ] Add `PresentClearedMessage` (`type`, `sessionId`, `presentId?` — per-id eviction vs full clear)
- [ ] Wire both into the orchestrator WS dispatch so they reach the browser

## MCP bridge (agent → worker)

- [ ] Create `src/server/session/mcp-present-bridge.ts` as a stdio MCP server (mirror `mcp-review-bridge.ts`)
- [ ] Define `present` tool schema: `content` (string), `mimeType` (string, default `text/html`), `title` (string, optional), `replaceId` (string, optional)
- [ ] Write tool description that steers the agent to use `present` for ephemeral artifacts and `Write` for files to keep
- [ ] Forward each call to `http://127.0.0.1:${WORKER_PORT}/agent-ops/present/submit`, relay `{ presentId }` back as the tool result
- [ ] Declare the bridge in `claude-adapter.ts` `writeMcpConfig`
- [ ] Declare the bridge in `codex-adapter.ts` MCP writer
- [ ] Co-located tests: `mcp-present-bridge.test.ts`, plus updates to `claude-mcp-writer.test.ts` and `codex-mcp-writer.test.ts`

## Worker

- [ ] Add `presentBuffer: Map<presentId, { content, mimeType, title, createdAt, byteSize }>` to the session worker
- [ ] Enforce ~20-entry LRU + ~16 MB byte ceiling; evictions broadcast `present_cleared` with the evicted `presentId`
- [ ] `POST /agent-ops/present/submit` route: generate `presentId` (nanoid), store, emit `present_content` SSE, return `{ presentId, status: "presented" }`
- [ ] `POST /present/save` worker route: copy buffered bytes for `presentId` to `destPath` inside `/workspace`, reject paths outside the workspace
- [ ] Clear the buffer on container teardown (implicit) and on explicit `present_cleared` from the orchestrator

## Orchestrator

- [ ] Add `POST /api/sessions/:id/present/save` to `api-routes-session.ts`; forward to the worker via `worker-http.ts`
- [ ] Relay `present_content` and `present_cleared` SSE events to the session WS

## Client

- [ ] New store `src/client/stores/present-store.ts` with `presentations: Array<{ presentId, content, mimeType, title? }>` and `activePresentIndex`
- [ ] Reducer rules: `present_content` with matching `replaceId` replaces in-place; otherwise append + activate. `present_cleared` with `presentId` drops one entry; without `presentId` wipes the array
- [ ] Reset the store on session switch (wire into `stores/actions/session-actions.ts`)
- [ ] New component `src/client/components/PresentPane.tsx` rendering by MIME type:
  - [ ] HTML → sandboxed iframe (`sandbox="allow-scripts"`, `srcdoc`)
  - [ ] SVG → iframe `srcdoc` wrapper or `<img>` with data URI
  - [ ] Markdown → existing markdown renderer
  - [ ] Images → `<img>` with data URI
- [ ] Presentation header: `◀ N/M ▶` carousel nav, title, "Save to project" button, `✕` dismiss
- [ ] "Save to project" dialog/inline path picker → `POST /api/sessions/:id/present/save` with `{ presentId, destPath }`
- [ ] Add "Present" tab to `AppLayout.tsx` right panel; conditionally visible (`presentations.length > 0`), badge with count, auto-switch on first `present_content`
- [ ] Inline chat chip on the agent's tool result for `present` — clickable, focuses the Present tab on the matching `presentId`
- [ ] Keyboard shortcuts (←/→) when the Present pane is focused
- [ ] Component tests for `PresentPane` and the store reducer

## Docs

- [ ] Add `src/server/shipit-docs/present.md` describing the `present` tool, when to use it vs `Write`, and size limits
- [ ] Update `plan.md` status to `in-progress` when work starts, `done` when shipping
- [ ] Check off items above as they land

## Verification

- [ ] Integration test: agent calls `present` → SSE → client store updates → tab appears
- [ ] Integration test: `replaceId` swaps in-place without growing the list
- [ ] Integration test: LRU eviction at cap emits `present_cleared` with `presentId`, client drops just that entry
- [ ] Integration test: "Save to project" writes byte-exact content to the workspace and triggers auto-commit
- [ ] Manual: oversize content (>16 MB) is rejected with a clear error to the agent
- [ ] Manual: sandboxed iframe cannot read parent cookies/storage or navigate the top frame
- [ ] `npm run lint:dev` and `npm run typecheck` clean
