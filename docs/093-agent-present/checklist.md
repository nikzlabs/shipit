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
- [x] Inline chat chip for `present` tool results focuses the matching artifact in the Present tab
- [x] Keyboard shortcuts (←/→) when the Present pane is focused
- [x] Component tests for the store reducer
- [x] PresentPane component tests for empty state, carousel navigation, sandboxing, save, and dismiss

## Docs

- [x] Add `src/server/shipit-docs/present.md` describing the `present` tool, when to use it vs `Write`, and size limits
- [x] Update `plan.md` status to `in-progress` when work starts
- [x] Update `plan.md` status to `done` when shipping
- [x] Check off items above as they land

## Verification

- [x] Unit tests for the present buffer (LRU eviction, byte cap, replaceId, delete, clear)
- [x] Unit tests for the present-store reducer (append/replace/clear/setActiveIndex/markSeen)
- [ ] **End-to-end integration test — deferred.** See "Deferred follow-ups" below.
- [ ] Manual: oversize content (>1 MB) is rejected with a clear error to the agent
- [ ] Manual: sandboxed iframe cannot read parent cookies/storage or navigate the top frame
- [x] `npm run lint:dev` and `npm run typecheck` clean

## Persistence across session switches + #300 fix

- [x] `PresentStateEntry` + `WsPresentStateMessage` added to `ws-server-messages.ts` and wired into the union
- [x] Runner-side `presentations` cache on `SessionRunnerInterface` (optional) + `ContainerSessionRunner` (maintained in SSE `present_content` / `present_cleared` handlers)
- [x] `attachToRunner` (index.ts) replays `present_state` on viewer attach when the cache is non-empty
- [x] Client `handlePresentState` handler + `usePresentStore.hydrate()` (no unseen bump, no auto-switch)
- [x] `addOrReplace` dedupes by `presentId` so live/replay overlap doesn't duplicate
- [x] Auto-switch moved from App-level effect into `handlePresentContent` (live 0→1 edge only)
- [x] Fix React #300 in `PresentPane` — all hooks declared before the empty-state early return
- [x] Store tests for `hydrate` (snapshot replace, no unseen bump, index clamp) and presentId dedupe

## Deferred follow-ups

Polish and defense-in-depth left out of the shipping PR. None blocks the
feature; each entry below names the gap, explains why we stopped where we did,
and points at the concrete pickup path so a future contributor doesn't have
to re-derive the context.

### Inline chat chip for `present` tool results

Status: done.

Importance: medium. Implementation cost: small/medium.

Implemented: the bridge returns structured JSON (`status`, `presentId`,
optional `title` / `replaceId`), the chat tool renderer detects
`mcp__shipit-present__present`, and the inline chip's View action calls
`usePresentStore.focusById(presentId)` plus `useUiStore.setRightTab("present")`.

### `PresentPane` component test

Status: done.

Importance: low/medium. Implementation cost: small.

Implemented React Testing Library coverage for the empty state, single-entry
carousel hiding, iframe sandbox attribute, button + keyboard navigation, Save
POST body, and dismiss behavior.

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
