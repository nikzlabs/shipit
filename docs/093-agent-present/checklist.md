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
- [x] Updates to `claude-mcp-writer.test.ts` and `codex-mcp-writer.test.ts` for the new `presentBridge` context slot
- [ ] **Co-located bridge test `mcp-present-bridge.test.ts` — deferred.** See "Deferred follow-ups" below.

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
- [ ] **Inline chat chip — deferred.** See "Deferred follow-ups" below.
- [x] Keyboard shortcuts (←/→) when the Present pane is focused
- [x] Component tests for the store reducer
- [ ] **PresentPane component test — deferred.** See "Deferred follow-ups" below.

## Docs

- [x] Add `src/server/shipit-docs/present.md` describing the `present` tool, when to use it vs `Write`, and size limits
- [x] Update `plan.md` status to `in-progress` when work starts
- [ ] Update `plan.md` status to `done` when shipping
- [x] Check off items above as they land

## Verification

- [x] Unit tests for the present buffer (LRU eviction, byte cap, replaceId, delete, clear)
- [x] Unit tests for the present-store reducer (append/replace/clear/setActiveIndex/markSeen)
- [ ] **End-to-end integration test — deferred.** See "Deferred follow-ups" below.
- [ ] Manual: oversize content (>1 MB) is rejected with a clear error to the agent
- [ ] Manual: sandboxed iframe cannot read parent cookies/storage or navigate the top frame
- [x] `npm run lint:dev` and `npm run typecheck` clean

## Deferred follow-ups

Polish and defense-in-depth left out of the shipping PR. None blocks the
feature; each entry below names the gap, explains why we stopped where we did,
and points at the concrete pickup path so a future contributor doesn't have
to re-derive the context.

### Inline chat chip for `present` tool results

Importance: medium. Implementation cost: small/medium.

**What's missing.** The plan (§"Chat integration (lightweight)") calls for a
small clickable chip rendered next to the agent's prose at the chat position
where the `present` tool call landed, with a [View] action that focuses the
Present tab on the matching `presentId`. Today the bridge returns plain prose
(*"Presented \"X\" as pres_abc... The user can see it in the Present tab."*)
which renders as a normal tool-result line — informative, but not clickable.

**Why deferred.** Adding the chip is orthogonal to the storage + display path
this PR builds. It requires the bridge to return a structured `{ presentId,
title }` payload (today it returns prose so the agent has the id to reference
on a follow-up `replaceId` call); a chat-side renderer that recognizes
`present` tool calls by name; a "focus this presentId" action on the store; and
a click handler that flips `useUiStore.setRightTab("present")`. Discoverability
isn't broken without it — the tab auto-switches on the first presentation per
session — so the chip is polish, not a correctness fix.

**Pickup.** Change the bridge to return structured JSON (`{ presentId,
title }`), update Claude/Codex tool-result rendering to detect the
`shipit-present` server name + `present` tool name and render a new
`PresentChip` component. Add `usePresentStore.focusById(presentId)` that sets
the active index by id. Click handler calls that plus `setRightTab("present")`.

### `PresentPane` component test

Importance: low/medium. Implementation cost: small.

**What's missing.** No React Testing Library coverage for the pane itself.
The reducer below it (`present-store`) and the buffer above it
(`PresentBuffer`) are covered; the pane is the un-tested glue.

**Why deferred.** The pane is largely declarative — a few conditionals around
the carousel arrows, the MIME-type switch in `PresentationContent`, and the
Save dialog flow. The data-layer tests catch most regressions: active-index
clamping lives in the store, buffer eviction in the buffer test, the
`sandbox="allow-scripts"` attribute is one literal in source that wouldn't
silently flip. Worth having for the carousel arithmetic and Save dialog UX,
but not load-bearing for correctness.

**Pickup.** Follow `AgentReviewCard.test.tsx` as the template. Mock
`usePresentStore` to seed presentations, mock `fetch` for `POST
/api/sessions/:id/present/save`. Cases worth covering: empty-state copy when
the list is empty, no carousel arrows with a single entry, ◀ N/M ▶ arithmetic
+ disabled-state at the bounds, ←/→ keyboard nav, Save dialog opens / posts
the right body / surfaces server errors, dismiss `✕` calls `clear(presentId)`,
**the iframe `sandbox` attribute is exactly `allow-scripts`** (a regression
here would be a real security hole, so this one earns its own assertion).

### `mcp-present-bridge.test.ts`

Importance: low. Implementation cost: small.

**What's missing.** A unit test that drives the bridge subprocess's MCP
request handlers (`ListTools`, `CallTool`) with `fetch` mocked.

**Why deferred.** The bridge is ~30 lines of pure transport (forward args to
`/agent-ops/present/submit`, relay the response). Its contract is exercised
end-to-end by the worker route + the buffer tests, so a co-located test would
mostly assert that the JSON shape on either side matches — which is also
caught at typecheck if the bridge or worker route diverge.

**Pickup.** Same harness as `mcp-review-bridge` would use if it had one
(neither does today). Wire the bridge's `server` instance to an in-process
transport pair, send `CallTool` requests, stub `globalThis.fetch`, assert the
forwarded body and the relayed text response.

### End-to-end integration test (agent → SSE → store → tab)

Importance: medium. Implementation cost: medium.

**What's missing.** A test that drives the full pipeline: a fake worker
accepts `POST /agent-ops/present/submit`, the SSE broadcaster fans out, the
orchestrator's `ContainerSessionRunner.handleSSEEvent` translates the worker
event into a WS message, and a `TestClient` receives it as
`WsPresentContentMessage`.

**Why deferred.** The integration harness in
`src/server/orchestrator/integration_tests/` is built around `TestClient`
(WebSocket fixture) and `FakeClaudeProcess` (agent stub). Driving the present
path properly needs a fake worker the orchestrator's container runner can
connect SSE to — that infra doesn't exist today. The unit tests on each link
(buffer, reducer, SSE event union typing) cover the individual hops; the
integration test would mostly verify wiring, but the kind of wiring that a
future refactor could silently break.

**Pickup.** Either (a) build a small in-process fake worker that registers
the `/agent-ops/present/submit` + `/events` routes on a local Fastify and
have `ContainerSessionRunner` point its SSE at that, or (b) add a worker-side
test mode that lets the orchestrator skip the container layer entirely and
drive the SSE broadcaster directly. Option (a) is more honest, option (b) is
cheaper. Check whether the existing harness has a similar hook for the review
flow (docs/151's tests touched related infrastructure).
