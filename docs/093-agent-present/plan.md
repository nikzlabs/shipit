---
status: planned
priority: medium
description: Let the agent display visual artifacts (HTML, SVG, charts, markdown) in a dedicated Present tab without spinning up a dev server or touching the workspace.
---

# Agent Present — lightweight content display without full preview

## Problem

Today, to show the user *anything* visual — an HTML prototype, an SVG diagram, a rendered markdown doc — the agent must spin up a full Docker Compose dev server. This is heavyweight: it requires a `docker-compose.yml`, a running process, port detection, and the preview proxy pipeline. For many common cases ("here's a quick diagram", "here's the landing page mockup", "here's a chart of the data") this is massive overkill.

The agent needs a lightweight way to **present** a single piece of content — an HTML page, an SVG, an image, a document — and have it appear in the user's preview pane immediately, with zero infrastructure.

### Use cases

- Agent generates an SVG diagram and wants to show it
- Agent writes an `index.html` prototype and wants the user to see it rendered
- Agent creates a chart (HTML + inline JS) to visualize data
- Agent wants to show a rendered markdown document
- Agent generates a PDF or image and wants to display it
- Agent builds a multi-file HTML app (HTML + CSS + JS) without a bundler

---

## Design constraints

1. **No new processes** — presenting content must not start a dev server, container, or background process.
2. **Instant** — content should appear within milliseconds of the agent requesting it, not after a health-check polling loop.
3. **Works with existing UI** — should reuse or minimally extend the preview pane, not create a wholly new panel.
4. **Secure** — presented content must be sandboxed; it cannot access the parent frame, session cookies, or other origins.
5. **Simple agent interface** — the agent should do something natural (write a file, call a tool) without needing to understand ShipIt internals.
6. **Ephemeral by default** — presented content is scratch/throwaway. It should not appear in the file tree, trigger file watcher events, or risk being committed to git. If the user wants to keep it, they explicitly ask the agent to save it to the workspace.

---

## Ephemeral vs. persistent

A key design axis: should presented content live in the workspace?

**No.** Most presentations are transient — a quick chart, a diagram to discuss, a mockup to iterate on. Writing them to the workspace creates noise:
- Clutters the file tree with throwaway files
- Triggers file watcher events and potential auto-commit
- User must manually clean up or `.gitignore` them
- Conceptually wrong: a presentation is an *action*, not a *deliverable*

The right default is **ephemeral**: content exists only for display, outside the workspace. If the user likes what they see, they ask "save this to the project" and the agent copies it into the workspace as a deliberate act.

This means the content needs to live somewhere the session worker can serve it but that is invisible to git and the file tree:
- **In-memory** (for small inline content sent over WS)
- **Scratch directory** like `/tmp/present/` or `/shipit/present/` (for multi-file content that needs relative path resolution)

Both are wiped when the container stops — truly ephemeral.

---

## Options

### Option A: Workspace file convention ("just write and open")

The agent writes a file to the workspace and tells ShipIt to display it.

**How it works:**

1. Agent writes file to workspace (e.g., `/workspace/output/chart.html`)
2. Agent calls `present("output/chart.html")`
3. Session worker serves the file; client shows it in preview pane

**Pros:**
- Multi-file support (relative paths work naturally)
- Simple mental model: "write a file, show a file"

**Cons:**
- **Not ephemeral** — files land in the workspace, show in file tree, risk being committed
- Requires cleanup or `.gitignore` discipline
- Triggers file watcher noise

**Complexity:** Medium
**Verdict:** Rejected — violates the ephemeral-by-default constraint

---

### Option B: Inline artifact over WebSocket

The agent emits content directly as a WS message. No files anywhere — purely in-memory, purely ephemeral.

**How it works:**

1. Agent generates content and calls a `present` tool (or emits a structured block)
2. Session worker sends an `artifact` SSE event: `{ type: "artifact", content: "...", mimeType: "text/html", title: "Chart" }`
3. Orchestrator relays to client via WS
4. Client renders in the preview pane using a sandboxed iframe with `srcdoc` (for HTML) or `<img>` (for images/SVG)

**Pros:**
- **Perfectly ephemeral** — no files created anywhere, content lives only in the message stream
- Zero HTTP infrastructure — flows through existing SSE/WS pipeline
- Simplest implementation: one new message type, one client renderer
- No file serving, no proxy routing, no cleanup

**Cons:**
- Size limits — large content (images, complex pages) bloats the WS/SSE pipeline
- No relative asset references — everything must be inline (CSS, JS, data URIs)
- Multi-file apps don't work; single self-contained blobs only
- No hot reload — agent must re-send entire artifact to update

**Complexity:** Low
**Best for:** Single-file artifacts under ~256KB (diagrams, charts, mockups)

---

### Option C: Scratch directory + WS signaling

The agent writes files to a **scratch directory outside the workspace** (`/tmp/present/`), then a WS signal tells the client what to display. The session worker serves files from the scratch dir. Multi-file support with full ephemerality.

**How it works:**

1. Agent generates content and calls a `present` tool:
   - For inline content: `present({ content: "<html>...", mimeType: "text/html", title: "Chart" })`
   - For multi-file: `present({ files: {"index.html": "...", "style.css": "..."}, entry: "index.html", title: "App" })`
2. Session worker writes files to `/tmp/present/{presentationId}/` (outside workspace, invisible to git/file-tree/file-watcher)
3. Session worker emits `present_content` SSE event with the presentation ID
4. Session worker serves from `/tmp/present/` via `GET /present-files/{presentationId}/*`
5. Orchestrator proxies; client loads in sandboxed iframe

**Pros:**
- **Ephemeral** — scratch dir is outside workspace, invisible to git, wiped on container stop
- Multi-file works (relative paths resolve against the scratch root)
- Small WS messages (just a pointer, not the content)
- Supports iterative updates — agent calls `present()` again, new version replaces old
- Can serve large files without bloating WS pipeline
- "Save to project" is a clean copy from scratch dir → workspace

**Cons:**
- Two moving parts (file serving + signaling)
- Agent must pass content through the tool (can't just `write_file` naturally)
- Requires a new static file server endpoint on the session worker

**Complexity:** Medium
**Best for:** Multi-file presentations, large content, iterative refinement

---

### Option D: Built-in static server on a scratch directory

Like Option A's "extend the preview system" idea, but serving from a scratch dir instead of the workspace. The session worker's Fastify instance serves static files on a reserved path — no separate process needed.

**How it works:**

1. Agent writes files via the `present` tool (same as Option C)
2. Session worker writes to `/tmp/present/` and registers the route on its existing Fastify instance
3. Preview proxy routes to the session worker's present endpoint
4. Client shows it in the PreviewFrame as a special "Presentation" port

**Pros:**
- Ephemeral (scratch dir)
- Reuses existing preview proxy pipeline
- No new process — Fastify serves static files on an additional route
- Multi-file support

**Cons:**
- Conflates "app preview" and "agent presentation" in the port selector
- Less explicit signaling — relies on preview detection rather than a dedicated event
- No inline-content fast path for small artifacts

**Complexity:** Low-Medium

---

### Option E: Tool-output artifacts (embedded in chat)

Rather than using the preview pane, render rich content inline in the chat message list — similar to how Claude.ai shows artifacts alongside messages.

**How it works:**

1. Agent emits a structured tool result with `type: "artifact"` containing content + MIME type
2. Client message renderer detects artifact results and renders them inline: iframe for HTML, `<img>` for images, rendered markdown for `.md`
3. User can click "expand" to open the artifact in the preview pane or a modal
4. Artifacts are stored in chat history for replay

**Pros:**
- Discoverable — content appears right where the agent talks about it
- No navigation required — user doesn't need to switch to preview pane
- Natural for small artifacts (diagrams, charts, quick mockups)
- Persists in chat history

**Cons:**
- Inline iframes in a chat list are tricky (sizing, scrolling, interaction)
- Doesn't replace preview pane for interactive apps
- Large artifacts overwhelm the chat flow
- Complex rendering logic in the message list component

**Complexity:** Medium-High

---

## Comparison matrix

| Criterion                  | A: Workspace | B: WS inline | C: Scratch+WS | D: Static srv | E: Chat inline |
|---------------------------|:---:|:---:|:---:|:---:|:---:|
| **Ephemeral by default**   | **No** | **Yes** | **Yes** | **Yes** | **Yes** |
| Implementation complexity  | Med | **Low** | Med | Low-Med | Med-High |
| Multi-file support         | Yes | No | Yes | Yes | No |
| Large content support      | Yes | No | Yes | Yes | No |
| Instant display            | Yes | **Yes** | Yes | Yes | Yes |
| No new processes           | Yes | **Yes** | Yes | Yes | **Yes** |
| Works with existing UI     | Mostly | Mostly | Yes | **Yes** | Partial |
| Agent simplicity           | Good | **Best** | Good | Good | Good |
| Iterative updates          | Yes | Resend all | Yes | Yes | Resend all |
| "Save to project" path     | N/A | Copy from msg | **Copy from scratch** | Copy from scratch | Copy from msg |

---

## Recommendation

**Two-tier approach: Option B (inline) as the primary path, with Option C (scratch dir) as the upgrade path for complex presentations.**

### Tier 1: Inline artifacts (Option B) — start here

Most presentations are a single self-contained blob: an SVG diagram, an HTML page with inline CSS/JS, a chart. For these, inline content over WS is the simplest possible implementation:

- Agent calls `present({ content: "...", mimeType: "text/html", title: "Architecture Diagram" })`
- Content flows through SSE → WS → client renders in preview pane via `srcdoc`
- No files, no endpoints, no proxy changes
- Perfectly ephemeral — content lives only in the message stream
- Implementation: ~1 day (new message type + client renderer)

### Tier 2: Scratch-backed presentations (Option C) — add when needed

When someone needs multi-file support (HTML + CSS + JS), large content (images, complex apps), or iterative refinement with hot reload, add the scratch directory approach:

- Agent calls `present({ files: {...}, entry: "index.html" })`
- Files written to `/tmp/present/`, served by session worker, proxied to client
- Still ephemeral — scratch dir is outside workspace

This can be added later without breaking the Tier 1 API — the `present` tool just gains a `files` parameter alongside `content`.

### Future: Chat inline (Option E)

Small artifacts (SVG, chart) rendered inline in the message thread alongside the agent's explanation. Great UX but higher complexity — layer on after Tier 1 proves the concept.

### Why not A or D?

- **A (workspace files):** Not ephemeral. Rejected.
- **D (static server):** Decent but lacks explicit signaling. The agent can't say "look at this" — it relies on the user noticing a new port. Also conflates preview and presentation.

---

## UI placement: separate tab, not inside Preview

Presentations get their own **"Present" tab** in the right panel, alongside Preview and Terminal. Not embedded inside the Preview pane.

```
┌─────────┬──────────────────────────────────┐
│         │ [Preview] [Present] [Terminal]    │
│  Chat   │ ┌──────────────────────────────┐ │
│         │ │ ◀ 2/3 ▶  Sales Chart   💾  ✕ │ │
│         │ │                              │ │
│         │ │      [rendered content]      │ │
│         │ │                              │ │
│         │ └──────────────────────────────┘ │
└─────────┴──────────────────────────────────┘
```

### Why separate?

1. **No conflict with preview** — the killer argument. User is iterating on a live app AND the agent presents a diagram. With a shared pane they'd have to toggle; with separate tabs they coexist. Just click between them.
2. **Clean conceptual separation** — "Preview" = a running process (dev server, Docker Compose). "Present" = a static artifact the agent generated. Different sources, different lifecycles, different mental models.
3. **Each tab owns its header** — Preview gets the port selector. Present gets the carousel nav. No competing navigation crammed into one header bar.
4. **Appears only when needed** — the Present tab is hidden until the first `present_content` message. Users who never see a presentation never see the tab. Zero noise.
5. **Future-friendly** — natural home for richer content types later (generated PDFs, interactive notebooks, comparison views).

### Behavior

- **Tab appears** on first `present_content` message in the session. Auto-switches to it.
- **Badge** shows count: `Present (3)` when there are multiple presentations and the tab isn't focused.
- **Tab hides** when all presentations are dismissed and there's nothing to show.
- **Session switch** clears presentations and hides the tab.

---

## Multiple presentations

When the agent presents multiple artifacts — across turns or within a single turn — how do they appear?

### Scenarios

| Scenario | Example | Desired behavior |
|----------|---------|-----------------|
| **Revision** | Agent presents landing page v1, user gives feedback, agent presents v2 | v2 replaces v1 — same slot, latest wins |
| **Unrelated, sequential** | Turn 3: DB schema diagram. Turn 7: sales chart | Both accessible — user might want to flip back |
| **Multiple in one turn** | Agent generates component tree AND data flow chart | Both accessible as peers |

### Design: presentation list with active selection

The preview pane maintains an **ordered list of presentations** for the session, with one shown at a time:

```
┌─────────────────────────────────────────────┐
│ ◀ 2/3 ▶  Sales Chart     💾 Save  ✕ Close  │  ← header: nav + title + actions
├─────────────────────────────────────────────┤
│                                             │
│            [rendered content]               │
│                                             │
└─────────────────────────────────────────────┘
```

**Rules:**

1. **New presentation** — appended to the list, auto-selected (user sees it immediately)
2. **Revision** — agent passes `replaceId` referencing a previous `presentId`. Replaces that entry in-place, no new slot. If omitted, it's a new entry.
3. **Navigation** — `◀ ▶` arrows or `2/3` indicator let the user flip between presentations. Keyboard shortcuts (←/→) when pane is focused.
4. **Dismiss** — `✕` removes one entry from the list. When the last one is dismissed, presentation mode exits.
5. **Clear all** — `present_cleared` message wipes the entire list (e.g., on session switch).
6. **Cap** — max ~20 presentations per session. Oldest evicted when exceeded (LRU). Prevents unbounded memory growth from long sessions.

### Why not tabs?

Tabs would work but are visually heavy for what's often 1–3 items. The `◀ 2/3 ▶` carousel pattern is lighter, doesn't compete with the port selector, and degrades gracefully: with 1 item, the nav arrows simply don't appear.

### Agent API for revisions

```
// First presentation — new entry
present({ content: "...", title: "Schema v1" })
→ { presentId: "abc123" }

// User gives feedback, agent revises — replace in-place
present({ content: "...", title: "Schema v2", replaceId: "abc123" })
→ { presentId: "def456" }

// Separate artifact in the same turn — new entry
present({ content: "...", title: "Data Flow" })
→ { presentId: "ghi789" }
```

The agent gets back the `presentId` from each call, so it can reference previous presentations for updates. If the agent doesn't track IDs (simpler agents, one-shot presentations), every call creates a new entry — fine for most cases.

### Chat integration (lightweight)

When the agent presents, a small **chip** appears inline in the chat message:

```
I've created a diagram showing the database schema.

  ┌──────────────────────────┐
  │ 📊 Schema Diagram  [View]│  ← clickable chip, scrolls preview pane into view
  └──────────────────────────┘

Let me know if you'd like any changes.
```

This connects the conversation to the visual output without rendering the full artifact inline (which is the heavier Option E). The chip is emitted as part of the tool result display — minimal client work.

---

## Implementation sketch — Tier 1 (inline artifacts)

### New types

```typescript
// ws-server-messages.ts
interface PresentContentMessage {
  type: "present_content";
  sessionId: string;
  presentId: string;        // unique ID for this presentation
  replaceId?: string;       // if set, replaces this existing presentation in-place
  content: string;          // the content (HTML string, SVG string, data URI, markdown)
  mimeType: string;         // "text/html", "image/svg+xml", "text/markdown", "image/png"
  title?: string;           // display title for the header
}

interface PresentClearedMessage {
  type: "present_cleared";
  sessionId: string;
  presentId?: string;       // if set, clear just this entry (eviction); otherwise clear all
}
```

### Agent tool

A `present` tool is exposed to the agent via an **MCP bridge process**, following the same pattern as `submit_review_comments` (docs/125, `src/server/session/mcp-review-bridge.ts`). `tool-map.ts` is a one-way normalizer that maps CLI-emitted tool names to a canonical vocabulary for client rendering — it does **not** expose tools to the agent and is irrelevant here.

The wiring:

1. A new `mcp-present-bridge.ts` stdio MCP server is built into the agent image and declared in the `mcp.json` that `claude-adapter.ts`'s `writeMcpConfig` and `codex-adapter.ts`'s analogous writer generate at session start. Both adapters need the entry — there is no shared layer above them today (the per-agent MCP writers were split out deliberately; see commit 598ade2d "Agent abstraction hairs: Phase 4 — per-agent MCP writers").
2. The bridge is pure transport — no state, no validation. On each `present` tool call it POSTs to the session worker's `/agent-ops/present/submit` broker on `127.0.0.1:${WORKER_PORT}`, the same localhost surface the `gh` / `shipit` shims use.
3. The worker injects the trusted `SESSION_ID`, persists the content (see "Server-side buffer" below), emits the `present_content` SSE event, and returns `{ presentId }` to the bridge, which relays it back over stdio as the MCP tool result.

The tool description the agent sees must be explicit enough that Claude/Codex pick it over `Write` for ephemeral artifacts — roughly: *"Display a single self-contained artifact (HTML, SVG, markdown, image) to the user in the Present tab without writing to the workspace. Use this for charts, diagrams, mockups, and previews you do not want committed. For files the user wants to keep, use Write instead."*

**Why MCP bridge, not a CLI shim?** The `present` payload is structured (content string + mimeType + optional replaceId) and the HTML/SVG content routinely contains characters that are awkward to pass through argv (`<`, `>`, `"`, newlines, NULs). MCP's JSON tool-call schema handles this natively; a shim would need stdin piping plus a parallel flag protocol.

**The tool handler in the session worker** (`/agent-ops/present/submit`):
1. Generates a `presentId` (nanoid)
2. **Stores `{ content, mimeType, title }` in an in-memory map keyed by `presentId`** (see "Server-side buffer")
3. Emits `present_content` via SSE (with `replaceId` if provided)
4. Returns `{ presentId, status: "presented" }` through the bridge to the agent

### Server-side buffer (load-bearing for "Save to project")

The session worker keeps a `Map<presentId, { content, mimeType, title, createdAt }>` for the lifetime of the container. This is what lets the "Save to project" path copy the exact bytes the user saw — see the action description below for why agent-mediated save is not viable.

Bounds: capped at the same ~20-entry LRU as the client-side list, plus a hard byte ceiling (e.g. 16 MB total) so a pathological agent can't OOM the worker. Eviction removes the entry from the map and broadcasts `present_cleared` with a `presentId` so the client drops only that one entry. When `presentId` is omitted (session switch, full clear) the client wipes the entire list. The container's `/tmp` lifetime already bounds this in the worst case.

For images/SVG, the agent can pass inline content directly:
```
present({
  content: "<svg xmlns='...' viewBox='0 0 400 300'>...</svg>",
  mimeType: "image/svg+xml",
  title: "Architecture Diagram"
})
```

### Client changes

- **New `PresentPane` component** (`src/client/components/PresentPane.tsx`): a dedicated right-panel tab, peer to `PreviewFrame` and Terminal. Renders content by MIME type:
  - HTML → sandboxed iframe via `srcdoc`
  - SVG → iframe via `srcdoc` (wrapped in minimal HTML) or `<img src="data:image/svg+xml,...">`
  - Markdown → existing markdown renderer in a styled container
  - Images → `<img>` with data URI
- **Presentation header**: `◀ 2/3 ▶` carousel nav, title, "Save to project" button, dismiss `✕` button.
- **Present store** (`src/client/stores/present-store.ts`): new Zustand store, separate from preview-store:
  ```typescript
  presentations: Array<{ presentId: string; content: string; mimeType: string; title?: string }>;
  activePresentIndex: number;
  ```
  On `present_content`: if `replaceId` matches an existing entry, replace it; otherwise append and set as active. On `present_cleared`: if `presentId` is set, drop just that entry (server-side LRU eviction); otherwise wipe the array (session switch, full clear).
- **Right panel tabs** (`AppLayout.tsx`): add "Present" tab. Conditionally visible — only rendered when `presentations.length > 0`. Shows badge with count when not focused. Auto-switches to Present tab on first `present_content`.
- **"Save to project" action**: **Client-driven, not agent-mediated.** The button POSTs `{ presentId, destPath }` to a new `/api/sessions/:id/present/save` orchestrator route, which forwards to a worker endpoint that copies the buffered bytes (see "Server-side buffer") to the workspace path and lets the normal file watcher + auto-commit pipeline take it from there. Agent-mediated save was rejected because after context compaction, several turns, or a fresh agent run the model may no longer have the exact content in its context window — it would have to regenerate, potentially producing a different chart/diagram than the one the user saw and approved. Save must be byte-exact with what was displayed.

### Sandboxing

The `srcdoc` iframe gets:
```html
<iframe
  sandbox="allow-scripts"
  srcdoc="..."
  style="width:100%;height:100%;border:none"
/>
```

`allow-scripts` lets JS run (charts, interactivity). Omitting `allow-same-origin` means the content can't access cookies, storage, or the parent frame. Omitting `allow-top-navigation` prevents redirects. External network requests (CDN, fonts) work by default in sandboxed iframes.

### Size limits

- Inline content via WS: **max 1MB**. Beyond that, the agent gets an error from the tool: "Content too large for inline presentation. Consider simplifying or splitting."
- Tier 2 (scratch dir) removes this limit by serving files over HTTP.

---

## Implementation sketch — Tier 2 (scratch directory, future)

When Tier 1 proves insufficient for multi-file or large content:

### Extended tool API

```
present({
  files: {
    "index.html": "<!DOCTYPE html>...",
    "style.css": "body { ... }",
    "app.js": "document.addEventListener(..."
  },
  entry: "index.html",        // which file to load in the iframe
  title: "Landing Page v2"
})
```

### Session worker additions

1. Write files to `/tmp/present/{presentId}/`
2. Register `GET /present-files/{presentId}/*` route (Fastify static plugin, scoped to the scratch dir)
3. Emit `present_content` with `url` field instead of `content`

### Orchestrator proxy

Extend `preview-proxy.ts`:
```
GET /present/:sessionId/:presentId/*  →  container GET /present-files/{presentId}/*
```

### Lifecycle

- Scratch dirs are per-presentation. New `present()` call creates a new dir.
- Old presentations are cleaned up after N presentations or M minutes (LRU).
- Container stop wipes `/tmp/` — automatic cleanup.

---

## Open questions

1. **Max inline size** — 256KB? 1MB? Need to test WS/SSE backpressure impact at various sizes. Determines when Tier 2 becomes necessary.
2. **Presentation persistence across reload** — presentations are ephemeral (no files), but should they survive a browser refresh? Options: (a) gone on refresh (truly ephemeral), (b) stored in chat history and replayed on session load. (b) is nicer but increases chat history size.
3. **CSP and sandboxing** — presented HTML needs network access (CDN scripts, Google Fonts) but must not access the parent frame. `sandbox="allow-scripts"` on the iframe works, but some content may need `allow-same-origin` for APIs. How strict?
4. **Right panel tab ordering** — when Present tab appears dynamically, where does it slot in? Proposal: `[Preview] [Present] [Terminal]` — Present is conceptually closest to Preview.

---

## Key files (to be updated when implemented)

### Tier 1
- `src/server/session/mcp-present-bridge.ts` — **new stdio MCP server**, mirrors `mcp-review-bridge.ts` (docs/125)
- `src/server/session/agents/claude-adapter.ts` — declare `present` MCP server in `writeMcpConfig`
- `src/server/session/agents/codex-adapter.ts` — declare `present` MCP server in the codex MCP writer
- `src/server/session/agent-ops-routes.ts` — `POST /agent-ops/present/submit` broker (matches the existing `gh` / `shipit` / `review` routes)
- `src/server/session/session-worker.ts` — in-memory `presentBuffer` map, `POST /api/sessions/:id/present/save` worker route that copies bytes from the buffer to the workspace
- `src/server/orchestrator/api-routes-session.ts` — `POST /api/sessions/:id/present/save` orchestrator route, forwards to the worker
- `src/server/shared/types/ws-server-messages.ts` — `PresentContentMessage`, `PresentClearedMessage`
- `src/server/shipit-docs/` — document `present` tool semantics (when to use vs. `Write`)
- `src/client/components/PresentPane.tsx` — **new component**, the Present tab
- `src/client/stores/present-store.ts` — **new store**, presentation list + active index
- `src/client/AppLayout.tsx` — add Present tab to right panel, conditional visibility

### Tier 2 (future)
- `src/server/session/session-worker.ts` — `GET /present-files/*` static serving
- `src/server/orchestrator/preview-proxy.ts` — proxy route for scratch-dir files
