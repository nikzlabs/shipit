---
status: planned
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

## Implementation sketch — Tier 1 (inline artifacts)

### New types

```typescript
// ws-server-messages.ts
interface PresentContentMessage {
  type: "present_content";
  sessionId: string;
  presentId: string;       // unique ID for this presentation (for updates/replacement)
  content: string;          // the content (HTML string, SVG string, data URI, markdown)
  mimeType: string;         // "text/html", "image/svg+xml", "text/markdown", "image/png"
  title?: string;           // display title for the preview pane header
}

interface PresentClearedMessage {
  type: "present_cleared";
  sessionId: string;
}
```

### Agent tool

A `present` tool in the agent's tool list (registered in `tool-map.ts`, documented in shipit-docs):

```
present({
  content: "<html><body><h1>Hello</h1><div id='chart'></div><script>...</script></body></html>",
  mimeType: "text/html",    // optional, default "text/html"
  title: "Sales Chart"       // optional
})
```

The tool handler in the session worker:
1. Generates a `presentId` (nanoid)
2. Emits `present_content` via SSE
3. Returns `{ presentId, status: "presented" }` to the agent

For images/SVG, the agent can pass inline content directly:
```
present({
  content: "<svg xmlns='...' viewBox='0 0 400 300'>...</svg>",
  mimeType: "image/svg+xml",
  title: "Architecture Diagram"
})
```

### Client changes

- **Preview pane**: When a `present_content` message arrives, switch to "presentation mode":
  - HTML: render in sandboxed iframe via `srcdoc` attribute
  - SVG: render in iframe via `srcdoc` (wrapped in minimal HTML) or directly as `<img src="data:image/svg+xml,..."/>`
  - Markdown: render with existing markdown renderer, display in a styled container
  - Images: render as `<img>` with data URI
- **Preview store**: Add `presentation: { presentId, content, mimeType, title } | null`. Clear on `present_cleared` or session switch.
- **Preview pane header**: Show title, "Presented by agent" badge, "Save to project" button, dismiss button.
- **"Save to project" action**: Opens a file-save dialog (or prompts agent), copies content to a workspace file. Transitions from ephemeral → persistent.
- **Port selector**: When presentation is active, show "Presentation: {title}" as the selected option. User can switch back to preview ports, and switch back to presentation.

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

1. **Max inline size** — 256KB? 1MB? Need to test WS/SSE backpressure impact at various sizes.
2. **Multiple presentations** — latest-wins (simple) or tabbed (powerful)? Start with latest-wins, add tabs if users want to compare.
3. **Interaction with full preview** — presentation and preview are separate "modes" in the preview pane. User can toggle between them. Presentation auto-activates when agent presents; preview stays available via port selector.
4. **Update semantics** — when agent calls `present()` again, does it replace the current presentation or create a new one? Propose: replace by default, but `presentId` allows targeted updates if needed.
5. **Chat integration** — should a small thumbnail/link appear in the chat message when the agent presents? Low-effort way to connect the chat flow to the visual output without full Option E.
6. **"Save to project" UX** — modal with file path input? Or agent-mediated ("save this as `public/chart.html`")? Agent-mediated feels more natural for ShipIt.

---

## Key files (to be updated when implemented)

### Tier 1
- `src/server/session/session-worker.ts` — `POST /present` endpoint (tool handler)
- `src/server/shared/types/ws-server-messages.ts` — `PresentContentMessage`, `PresentClearedMessage`
- `src/server/session/agents/tool-map.ts` — register `present` tool
- `src/server/shipit-docs/` — document `present` tool for the agent
- `src/client/components/PreviewFrame.tsx` — presentation mode rendering
- `src/client/stores/preview-store.ts` — presentation state

### Tier 2 (future)
- `src/server/session/session-worker.ts` — `GET /present-files/*` static serving
- `src/server/orchestrator/preview-proxy.ts` — proxy route for scratch-dir files
