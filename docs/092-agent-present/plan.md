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

---

## Options

### Option A: Magic file convention ("just write and open")

The agent writes a file to the workspace (e.g., `preview.html`) and then uses a hypothetical `open` tool or a special comment/directive to tell ShipIt to display it. The session worker serves the file statically; the client renders it in an iframe.

**How it works:**

1. Agent writes file to workspace (e.g., `/workspace/output/chart.html`)
2. Agent calls a tool: `present("output/chart.html")` — or writes a sentinel file like `.shipit/present`
3. Session worker has a new `GET /present/*` endpoint that serves files from the workspace with appropriate MIME types
4. Orchestrator proxies `/present/` requests like it proxies preview requests
5. Client receives a `present_content` WS message with the file path and loads it in the preview pane iframe

**Pros:**
- Files are real files in the workspace — user can see them in the file tree, edit them, commit them
- Multi-file support works naturally (HTML can reference `./style.css`, `./app.js` via relative paths)
- Simple mental model: "write a file, show a file"
- Hot reload is trivial: agent edits the file, file watcher triggers, client refreshes iframe

**Cons:**
- Requires a new static file server in the session worker
- Relative asset resolution needs the serving root to be correct
- Security: serving arbitrary workspace files over HTTP needs sandboxing

**Complexity:** Medium

---

### Option B: Artifact message (inline content over WebSocket)

The agent emits content directly as a structured message, similar to Claude.ai's artifact system. The content travels over the existing WebSocket as a new message type and is rendered client-side.

**How it works:**

1. Agent writes content and signals ShipIt (tool call, special markdown block, or file write)
2. Session worker sends an `artifact` event via SSE: `{ type: "artifact", content: "...", mimeType: "text/html", title: "Chart" }`
3. Orchestrator relays to client via WS
4. Client renders in the preview pane using a sandboxed iframe with `srcdoc` (for HTML) or an `<img>` tag (for images), or a markdown renderer (for `.md`)

**Pros:**
- Zero HTTP infrastructure — everything flows through the existing SSE/WS pipeline
- Content is self-contained; no file serving, no proxy routing
- Easy to implement: one new message type, one new client renderer
- Content can be ephemeral (not saved to workspace) or persisted — agent's choice

**Cons:**
- Size limits — very large content (images, complex pages) bloats the WS pipeline
- No relative asset references — everything must be inline (inline CSS, inline JS, data URIs for images)
- Multi-file apps don't work; only single self-contained blobs
- No hot reload — agent must re-send the entire artifact to update it

**Complexity:** Low

---

### Option C: Hybrid — file-backed artifacts with WS signaling

Combine A and B: the agent writes files to the workspace, then a lightweight signal tells the client what to display. The session worker serves files; the WS just carries the "show this" pointer.

**How it works:**

1. Agent writes files to workspace (single HTML file, or a directory with HTML + CSS + JS)
2. Agent signals presentation via one of:
   - A tool call: `present({ path: "output/index.html", title: "Landing Page" })`
   - Writing a manifest file: `.shipit/present.json` → `{ "path": "output/index.html" }`
   - A special code fence in chat: ` ```present:output/index.html` `
3. Session worker's file watcher (or tool handler) picks up the signal and emits a `present` SSE event with just the path + metadata
4. Session worker serves the file tree under a new `GET /present-files/*` endpoint (static, read-only, workspace-rooted)
5. Client loads the URL in a sandboxed iframe in the preview pane
6. File watcher detects changes → client auto-refreshes the iframe

**Pros:**
- Best of both worlds: real files + instant signaling
- Multi-file works (relative paths resolve against the serving root)
- Hot reload via file watcher
- Small WS messages (just a path, not the content)
- Files persist in the workspace — visible in file tree, committable
- Agent can also present data URIs or inline HTML for quick one-offs (fallback to Option B for small content)

**Cons:**
- Two moving parts (file serving + signaling) vs one
- Still needs the static file server from Option A

**Complexity:** Medium

---

### Option D: Extend the existing preview system with a built-in static server

Instead of a separate "present" concept, make the preview pane capable of showing static files without Docker Compose. The session container always runs a minimal static file server on a known port.

**How it works:**

1. Session worker starts a lightweight static server (e.g., `sirv` or built-in Fastify static) on a fixed port (e.g., `9100`) at container start — always on, near-zero overhead
2. Agent writes files to workspace; the static server serves them immediately
3. Agent tells the user "open the preview" or triggers it programmatically
4. Preview proxy routes to port `9100` like any other preview port
5. Client shows it in the existing PreviewFrame with no changes to the iframe pool, port selector, etc.

**Pros:**
- Minimal new concepts — reuses the entire existing preview pipeline
- Port selector "just works" — static server shows up as a detected port
- Multi-file, relative paths, hot reload — all free from existing infrastructure
- Agent doesn't need a new tool; it writes files and the user opens the preview
- No new WS message types

**Cons:**
- Always-on process (though very lightweight — single-digit MB, no CPU when idle)
- Conflates "app preview" with "agent presentation" — may be confusing when both are active
- Less explicit — agent can't easily say "look at this specific file"; it's "look at port 9100"
- Doesn't support non-HTML content natively (images, PDFs need an HTML wrapper)

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

| Criterion                  | A: File conv. | B: WS artifact | C: Hybrid | D: Static server | E: Chat inline |
|---------------------------|:---:|:---:|:---:|:---:|:---:|
| Implementation complexity  | Med | **Low** | Med | Low-Med | Med-High |
| Multi-file support         | Yes | No | Yes | Yes | No |
| Hot reload                 | Yes | No | Yes | Yes | No |
| Instant display            | Yes | **Yes** | Yes | Yes | Yes |
| No new processes           | Yes | **Yes** | Yes | No | **Yes** |
| Works with existing UI     | Mostly | Mostly | Yes | **Yes** | Partial |
| Large content support      | Yes | No | Yes | Yes | No |
| Agent simplicity           | Good | Good | **Best** | Good | Good |
| Inline + panel display     | No | No | No | No | **Yes** |
| No new endpoints needed    | No | **Yes** | No | No | **Yes** |

---

## Recommendation

**Option C (Hybrid) as primary, with Option E (chat inline) as a future enhancement.**

Rationale:
- C gives the agent the most natural workflow: write files, present them. It handles everything from a single SVG to a multi-page HTML app.
- The file-serving endpoint is simple and reusable — it's just static file serving from the workspace.
- The signaling mechanism (tool or manifest file) is clean and doesn't overload the WS pipeline.
- Option E is a great complement for small artifacts (inline diagrams in chat) but is higher complexity and can be layered on later.

Option D is a close runner-up — it's simpler by reusing the preview pipeline — but it lacks the explicit "present this" signal, making it harder for the agent to direct the user's attention.

---

## Sketch of Option C implementation

### New types

```typescript
// ws-server-messages.ts
interface PresentContentMessage {
  type: "present_content";
  sessionId: string;
  path: string;           // workspace-relative path (file or directory index)
  title?: string;         // display title for the preview pane tab
  mimeType?: string;      // hint; derived from extension if omitted
  inline?: string;        // optional: small inline content (< 256KB) for Option B fallback
}

interface PresentClearedMessage {
  type: "present_cleared";
  sessionId: string;
}
```

### Session worker: static file endpoint

```
GET /present-files/*
```

Serves files from the workspace directory. Read-only. MIME types derived from file extensions. Directory requests serve `index.html` if present.

Security headers: `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox allow-scripts`.

### Agent interface

The agent triggers presentation by writing a file and using one of:

1. **Tool call** (preferred): A `present` tool exposed via the agent's tool list:
   ```
   present({ path: "output/index.html", title: "Landing Page Mockup" })
   ```

2. **Manifest file** (zero-tool fallback): Agent writes `.shipit/present.json`:
   ```json
   { "path": "output/index.html", "title": "Landing Page Mockup" }
   ```
   File watcher detects the write and emits the `present_content` event.

### Client changes

- **PreviewFrame**: Add a `present` mode alongside the existing `preview` mode. When a `present_content` message arrives, switch the iframe src to the present-files URL. Show a "Presented by agent" badge. Auto-refresh on `files_changed` events that match the presented path.
- **Preview store**: Track `presentedPath`, `presentedTitle`. Clear on `present_cleared`.
- **Port selector**: Show "Agent presentation" as a virtual port option when content is being presented.

### Orchestrator proxy

Add a route or extend `preview-proxy.ts`:

```
GET /present/:sessionId/*  →  container GET /present-files/*
```

Or reuse subdomain routing with a reserved port number (e.g., `{sessionId}--0.localhost` maps to the present-files endpoint).

---

## Open questions

1. **Tool vs. manifest vs. both?** — Tools require agent-side support (the tool must be registered). A manifest file works with any agent. Supporting both adds small complexity but maximum flexibility.
2. **Inline content size limit** — For the Option B fallback path (small inline artifacts), what's the max size to send over WS? 256KB seems reasonable.
3. **Multiple presentations** — Can the agent present multiple things simultaneously (tabs)? Or is it always single-presentation, latest-wins?
4. **Interaction with full preview** — When Docker Compose preview is running AND the agent presents a file, how do they coexist? Separate tabs in the port selector? Priority?
5. **CSP and sandboxing** — Presented HTML needs network access (CDN scripts, Google Fonts) but must not access the parent frame. `sandbox="allow-scripts allow-same-origin"` on the iframe? Or use a null origin?

---

## Key files (to be updated when implemented)

- `src/server/session/session-worker.ts` — new `/present-files/*` endpoint
- `src/server/orchestrator/preview-proxy.ts` — proxy route for present files
- `src/server/shared/types/ws-server-messages.ts` — new message types
- `src/client/components/PreviewFrame.tsx` — present mode rendering
- `src/client/stores/preview-store.ts` — present state tracking
