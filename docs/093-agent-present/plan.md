---
issue: https://linear.app/shipit-ai/issue/SHI-102
description: Let the agent display visual artifacts (HTML, SVG, charts, markdown) in a dedicated Present tab without spinning up a dev server or touching the workspace.
---

# Agent Present — lightweight content display without full preview

> **Update (path-based identity — supersedes the `replaceId` design below):**
> the `presentId` is now **derived deterministically from the file path**
> (`derivePresentId(sessionId, resolvedPath)` in `present-registry.ts`), so the
> file path IS the identity. There is **no `replaceId` parameter** anymore.
> - Present a **new path** → a new carousel entry is appended.
> - Present the **same path again** → the same id is derived, so the entry
>   updates **in place** at every layer (worker registry `Map.set`, orchestrator
>   `ON CONFLICT(present_id) DO UPDATE`, client store dedupe-by-id) — keeping its
>   slot. This is the screenshot iteration loop: edit the file, re-present it.
> - Because the id is stable across re-presents *and container restarts*,
>   re-presenting a committed workspace file after a restart updates the existing
>   persisted row instead of duplicating it — and `viewUrl` stays valid.
> - The present flow no longer emits a per-id `present_cleared`; the only clear is
>   a full wipe on session switch. The client drops cached bytes on a genuine
>   re-present (newer `createdAt`) but preserves them on a true event replay
>   (identical `createdAt`, e.g. a WS reconnect). Motivation: GitHub issue #1543 —
>   the old `replaceId` framing implied a one-artifact-at-a-time limit and the
>   agent misused it; deriving identity from the path removes the knob entirely.
> Mentions of `replaceId` / "revision flow" below are the prior design.
>
> **Update (docs/188):** the `present` tool is now **file-based** — the agent
> writes a file and presents it by path (`present({ file })`), instead of passing
> an inline `content` string. The MIME type is inferred from the extension. A
> file written under the workspace is **tracked** (committed + in the file tree)
> *and* rendered in the Present tab; a file under `/tmp` stays ephemeral.
> See `docs/188-present-from-file/plan.md`.
>
> **Update (serve-from-disk — supersedes the buffer/Save design below):** the
> server retains **no artifact bytes**. The worker keeps a `PresentRegistry` of
> metadata only (`presentId → { path, mimeType, title }`); the bytes are read
> from disk on demand each time an artifact is served. Consequences:
> - **No size or count caps, no eviction.** The old `PresentBuffer` 1 MB / 16 MB
>   / 20-entry caps are gone — a presentation always shows and every artifact
>   stays in the carousel. The only `present_cleared` paths are a revision
>   superseding an id and a full clear on session switch.
> - **WS messages carry metadata only** (no `content` field). The client fetches
>   bytes lazily from `GET /api/sessions/:id/present/:presentId/content` (an
>   authenticated one-time disk read proxied to the worker's `/present/:id/raw`)
>   and caches them in the browser. A reload re-fetches; nothing large lives in
>   the worker or orchestrator. `runner.presentations` is a metadata cache.
> - **"Save to project" is removed** — no rigid-path dialog. To keep a `/tmp`
>   artifact, the user asks the agent to write it into the repo. **Download**
>   (client-side blob → local machine) stays. The user-facing **dismiss (✕)**
>   button is also gone (see Interaction below).
> - **The two serving routes** both read disk via the registry: `/present-files/:id`
>   (rendered, for the agent's screenshot loop, worker-local) and `/present/:id/raw`
>   (raw JSON, for the Present tab via the authenticated session API). Neither
>   uses the public preview proxy. Mentions of `PresentBuffer`, byte retention,
>   `inWorkspace`, and Save in the design below are historical.

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
- **Tab hides** when the list empties (server-driven clear/eviction) and there's nothing to show — there is no user-facing dismiss.
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
│ ◀ 2/3 ▶  Sales Chart        ⬇ Download     │  ← header: nav + title + Download (no Save/✕)
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
4. **No user-facing dismiss** — the pane deliberately has **no** close/✕ button. Presentations are ephemeral (not persisted) and the chat card's "View" button re-opens one by looking it up in the store via `focusById`; a manual dismiss removed the only copy and stranded that card with no way back (especially on mobile, where the ✕ reads as "close the panel"). The user navigates away from the Present tab via the tab system / mobile tab bar, which leaves the store intact.
5. **Clear all** — `present_cleared` message wipes the entire list (e.g., on session switch), or with a `presentId` drops one entry (a revision superseding an old id).
6. **No artifact-size or entry-count caps, no eviction** — a presentation always shows, no matter how large, and the carousel keeps every artifact of the session. The server retains no bytes (metadata-only `PresentRegistry`; bytes read from disk on demand), so there is nothing to cap. The earlier `PresentBuffer` limits (1 MB per artifact → outright rejection; ~20 entries → silent eviction of the oldest) made the UX worse and were a way an artifact could vanish, so they're gone. See the serve-from-disk banner at the top.

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

> **Update (standalone chip placement):** the present chip renders as its **own
> standalone element** in the transcript, never folded into the grouped
> `ToolCallGroup` container. That container is clipped (`max-h-30
> overflow-y-hidden hover:overflow-y-auto`), so a present chip sharing it with a
> stack of Read/Edit/Bash lines would be scrolled out of view. `buildVisualElements`
> (`visual-elements.ts`) excludes the present tool from the groupable accumulator
> via the `isStandaloneTool` predicate — which matches the present tool by name
> (`isPresentTool` in `tool-names.ts`, handling the MCP-prefixed and legacy forms)
> rather than the exact-name `STANDALONE_TOOLS` set — and emits it as a
> `standalone-tool` element (the same path used by `ExitPlanMode` /
> `AskUserQuestion`). This is pure client-side derivation from the persisted
> `tool_use`/`tool_results`, so the chip survives a page reload and server
> restart identically (its `presentId` rides in the persisted result content; the
> Present-tab entry it re-opens is restored from the durable `presentations`
> table, docs/093 serve-from-disk).

---

## Implementation sketch — Tier 1 (inline artifacts)

### New types

> NOTE: the shape below is historical — the message no longer carries `content`.
> See the serve-from-disk banner: messages are metadata only, and the client
> fetches bytes lazily. Current shape:

```typescript
// ws-server-messages.ts (current — metadata only, no bytes)
interface WsPresentContentMessage {
  type: "present_content";
  sessionId: string;
  presentId: string;        // unique ID for this presentation
  replaceId?: string;       // if set, replaces this existing presentation in-place
  mimeType: string;         // "text/html", "image/svg+xml", "text/markdown", "image/png"
  title?: string;           // display title for the header
  filePath: string;         // the presented path (verbatim), shown in the header
  createdAt: string;        // ISO8601
  // No `content` — fetched on demand from /api/sessions/:id/present/:presentId/content
}

interface WsPresentClearedMessage {
  type: "present_cleared";
  sessionId: string;
  presentId?: string;       // set → drop one (a revision); otherwise clear all
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

### Server-side registry (metadata only — supersedes the buffer)

The session worker keeps a `PresentRegistry`: a `Map<presentId, { resolvedPath, filePath, mimeType, title, createdAt }>` for the lifetime of the container — **no bytes**. The artifact is read from disk on demand each time it's served (the agent's rendered `/present-files/:id` screenshot URL; the user's raw `/present/:id/raw` fetch proxied through the authenticated session API). Nothing is cached server-side.

Bounds: **none** — no artifact-size cap, no entry-count cap, no eviction. A presentation always shows and every artifact stays in the carousel. `present_cleared` fires only on a revision (`replaceId` superseding an old id) or a full clear (session switch). The file on disk is the single source of truth; if the agent overwrites or deletes it, the next read reflects that. (Historically this was a `PresentBuffer` that held bytes and capped them — see the top banner for why that was removed.)

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
- **Presentation header**: `◀ 2/3 ▶` carousel nav, a two-line title block, "Save" button, "Download" button, dismiss `✕` button. The title block shows the artifact's **name** (the `title` arg, falling back to the file's basename) on top and the **full presented file path** beneath it in a muted monospace line. The path is a **required** field threaded end-to-end as `filePath`: the worker broadcasts the verbatim (validated non-empty) `file` arg on `present_content`, the runner caches it on `PresentStateEntry` (so the `present_state` replay carries it), and the client `present-store`/`PresentPane` render it. Because the worker validates `file` is non-empty, `filePath` is always present — there is no `Presentation N` fallback. This replaced the old bare `Presentation N` heading, which gave the user no clue which file an artifact came from.
- **Present store** (`src/client/stores/present-store.ts`): new Zustand store, separate from preview-store:
  ```typescript
  presentations: Array<{ presentId: string; content: string; mimeType: string; title?: string }>;
  activePresentIndex: number;
  ```
  On `present_content`: if `replaceId` matches an existing entry, replace it; otherwise append and set as active. On `present_cleared`: if `presentId` is set, drop just that entry (server-side LRU eviction); otherwise wipe the array (session switch, full clear).
- **Right panel tabs** (`AppLayout.tsx`): add "Present" tab. Conditionally visible — only rendered when `presentations.length > 0`. Shows badge with count when not focused. Auto-switches to Present tab on first `present_content`.
- **"Save to project" action**: **Client-driven, not agent-mediated.** Hidden entirely when the presented artifact already lives in the workspace (`inWorkspace`) — it's tracked and auto-committed already, so there's nothing to save; only throwaway (e.g. `/tmp`) artifacts show Save. `inWorkspace` is computed authoritatively on the worker (`path.relative(workspaceDir, resolvedPath)` doesn't climb out via `..` / isn't absolute) and threaded as a required field beside `filePath` through `present_content` → runner cache → store → `PresentPane`. The client can't decide this alone: a relative arg always resolves under the workspace, but an absolute `/workspace/...` arg also counts, and only the worker knows the workspace root. Download stays visible regardless (it targets the user's local machine, not the repo). The button POSTs `{ presentId, destPath }` to a new `/api/sessions/:id/present/save` orchestrator route, which forwards to a worker endpoint that copies the buffered bytes (see "Server-side buffer") to the workspace path and lets the normal file watcher + auto-commit pipeline take it from there. Agent-mediated save was rejected because after context compaction, several turns, or a fresh agent run the model may no longer have the exact content in its context window — it would have to regenerate, potentially producing a different chart/diagram than the one the user saw and approved. Save must be byte-exact with what was displayed.
- **"Download" action**: **Pure client-side, no server round-trip.** The button sits beside "Save" and pulls the artifact onto the user's *local machine* rather than into the workspace. The artifact content already lives in the browser (`present-store` holds the exact displayed bytes), so download is a `Blob` + transient `<a download>` click. Image artifacts (`data:` URIs) are decoded back to their binary bytes; text artifacts (HTML/SVG/markdown) become a typed text Blob. The filename is the slugified title plus a mime-derived extension, with no directory prefix (the browser's download UI owns placement). This is the complement to Save, not a duplicate: Save's destination is the project (committed, container-side); Download's destination is somewhere ShipIt can't reach (a slide deck, an email, a design tool). It is *not* a link-out (§1/§3) and *not* a shell-shaped affordance (§5) — a browser download to the user's disk is something only the client can do; the agent cannot trigger it. Helpers (`presentationToBlob`, `suggestDownloadName`, `mimeTypeToExtension`) are exported from `PresentPane.tsx` and unit-tested in `PresentPane.test.tsx`.

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

## Persistence across session switches (runner cache + `present_state` replay)

The initial Tier 1 ship populated the client `present-store` *only* from the
live `present_content` WS stream. That worked while the user was watching the
session as the tool fired, but the Present tab vanished in two cases the user
reported:

1. `present` fires while the user is in a **different** session; navigating to
   the present session later shows no tab (the live message was discarded by
   the stale-session guard, and nothing replays it).
2. `present` fires, the user switches away and comes back — `present-store` is
   reset on session switch and never re-hydrated.

The fix treats the orchestrator runner as the persistence layer (the worker's
`PresentBuffer` is the ultimate source of truth, but it isn't queried on
attach). Mechanism:

- **Runner-side cache.** `ContainerSessionRunner` maintains a `presentations`
  array, updated in its SSE `present_content` / `present_cleared` handlers
  (mirroring the client reducer: replace-by-`replaceId`, dedupe-by-`presentId`,
  else append; drop-one / wipe-all on cleared). Exposed via an optional
  `presentations` getter on `SessionRunnerInterface` (container-only; in-process
  runners don't host the tool and omit it).
- **`present_state` replay.** On viewer attach, `attachToRunner` (index.ts)
  sends a new `WsPresentStateMessage` carrying the full cached list when it's
  non-empty — same place it already replays service/queue/session-status state.
- **Silent hydrate.** The client `handlePresentState` handler calls a new
  `usePresentStore.hydrate()` that replaces the list **without** bumping the
  unseen badge or auto-switching the panel. Auto-switch moved out of the
  App-level `presentations.length` effect (which would falsely fire on a
  hydrate) into the live `handlePresentContent` handler, gated on the 0→1 edge.
- **Idempotency.** `addOrReplace` now dedupes by `presentId`, so a live
  `present_content` overlapping a `present_state` hydrate replaces in place
  instead of duplicating.

This resolved open question #2 for the *session-switch* axis. Browser **refresh**
and **container restart** are now covered too — see *Durable persistence across a
container restart* below. (The runner cache alone only survives as long as the
container, which is exactly the gap that section closes.)

### React #300 guard

`PresentPane` previously declared its keyboard-nav `useEffect` *after* an early
return for the empty state. When `present-store` reset to empty on session
switch, the early return fired and skipped that hook → "rendered fewer hooks
than expected" (#300). All hooks now run unconditionally before the early
return.

## Durable persistence across a container restart

The runner cache + `present_state` replay above made the Present tab survive a
**session switch**, but everything was still in-memory: the worker's
`PresentRegistry`, the orchestrator runner's `_presentations`, and the client
store. A session container is destroyed (not paused) when it goes idle, so a
restart wiped all three and the Present tab came back **empty** — even for an
artifact whose source file is a committed workspace file still on disk. The
motivating report: a user presented a workspace-committed prototype, the
container idle-recycled, and the tab returned blank.

The fix adds an **orchestrator-side durable store** so presentation *metadata*
outlives the container. Bytes are still never persisted — they're re-read from
the source file on demand (workspace-committed files survive in git; `/tmp`
throwaways may not).

Mechanism:

- **`PresentStore` (`present-store.ts`)** — a SQLite-backed, session-scoped
  metadata store (new `presentations` table, migration in `database.ts`). It
  holds the client-facing fields **plus** the container-internal `resolvedPath`
  (needed to re-serve bytes after a restart). `record()` mirrors the runner's
  reducer: a `replaceId` revision updates the superseded row **in place** so it
  keeps its carousel slot; an idempotent re-delivery updates by `present_id`;
  otherwise it appends (rows sort by insertion-order `id`). Bytes are never
  stored.
- **Worker → orchestrator carries `resolvedPath`.** The worker's
  `present_content` SSE event now includes the resolved absolute path (on the
  SSE event only — NOT the client-facing WS message, which keeps container paths
  off the client). The orchestrator runner reads it and persists the full record.
- **Runner persists + seeds.** `ContainerSessionRunner` takes an optional
  `presentStore` (threaded via `buildRunnerFactory`). Its SSE `present_content` /
  `present_cleared` handlers write through to the store, and the **constructor
  seeds `_presentations` from the store** — so a runner created for a freshly
  restarted container already carries the session's presentations and replays
  them via `present_state` on viewer attach.
- **Re-serve after restart via re-register.** A fresh worker's registry is
  empty, so the first `GET /present/:id/raw` 404s. `proxyPresentRaw` catches
  that, looks up the persisted record, POSTs it to the worker's new
  **`POST /present/register`** route (handing back `resolvedPath` + metadata),
  and retries the read. A workspace-committed file then re-renders fully; a
  `/tmp` file that's gone makes the retry 404 too — propagated so the Present
  tab shows its existing graceful "no longer available" placeholder (the
  `fetchError` branch in `PresentPane`), never a crash.
- **Client rehydrate on session load.** `GET /history` now carries
  `presentations` (metadata only, from `PresentStore.listForClient`), and
  `loadSessionHistory` calls `usePresentStore.hydrate()`. This is belt-and-
  suspenders with the WS `present_state` replay — both seed from the same
  authoritative DB, and `hydrate` / `addOrReplace` are idempotent by
  `present_id` (preserving already-fetched bytes), so a reconnect + a history
  replay never double-render.
- **Cleanup.** `database.ts clearAll()` (full reset) drops the table; the
  permanent `deleteSession` service drops the session's rows. Archive does NOT
  delete (so an unarchive can rehydrate). Rows are keyed by `session_id`, so an
  orphan is harmless.

This resolves open question #2 (persistence across reload) for all three axes —
reload, session switch, and container restart — for artifacts whose source file
is durable. The scope is deliberately **metadata-only**: bytes stay on disk/git.

### Key files (persistence)
- `src/server/orchestrator/present-store.ts` — **new** `PresentStore` (SQLite, session-scoped metadata)
- `src/server/shared/database.ts` — `presentations` table migration + `clearAll()` drop
- `src/server/orchestrator/container-session-runner.ts` — seed from store, persist on SSE, re-register in `proxyPresentRaw`
- `src/server/session/session-worker.ts` — `resolvedPath` on the `present_content` SSE event
- `src/server/session/present-view.ts` — **new** `POST /present/register` route (rehydrate the worker registry)
- `src/server/orchestrator/app-di.ts` / `app-lifecycle.ts` / `index.ts` — construct + thread `presentStore` into the runner factory and `ApiDeps`
- `src/server/orchestrator/api-routes-session.ts` — `presentations` in the `/history` payload
- `src/client/utils/session-data.ts` — `usePresentStore.hydrate()` on session load
- `src/server/orchestrator/services/session.ts` — `deleteSession` drops persisted rows

## Key files (to be updated when implemented)

### Tier 1
- `src/server/session/mcp-present-bridge.ts` — **new stdio MCP server**, mirrors `mcp-review-bridge.ts` (docs/125)
- `src/server/session/agents/claude-adapter.ts` — declare `present` MCP server in `writeMcpConfig`
- `src/server/session/agents/codex-adapter.ts` — declare `present` MCP server in the codex MCP writer
- `src/server/session/agent-ops-routes.ts` — `POST /agent-ops/present/submit` broker (matches the existing `gh` / `shipit` / `review` routes)
- `src/server/session/present-registry.ts` — **`PresentRegistry`**, the metadata-only `presentId → { resolvedPath, filePath, mimeType, title }` map (replaced the old byte-holding `present-buffer.ts`)
- `src/server/session/present-view.ts` — `readArtifactContent` + the two disk-reading routes: `/present-files/:id` (rendered, for the agent screenshot loop) and `/present/:id/raw` (raw JSON, for the Present tab)
- `src/server/session/session-worker.ts` — `POST /agent-ops/present/submit` records metadata (no byte read), wires `registerPresentFilesRoutes`
- `src/server/orchestrator/api-routes-session.ts` — `GET /api/sessions/:id/present/:presentId/content`, proxies a one-time disk read to the worker (replaced the removed `present/save` route)
- `src/server/orchestrator/container-session-runner.ts` — `runner.presentations` metadata cache + `proxyPresentRaw`
- `src/server/shared/types/ws-server-messages.ts` — `WsPresentContentMessage`, `WsPresentClearedMessage`, `PresentStateEntry` (metadata only)
- `src/server/shipit-docs/` — document `present` tool semantics (when to use vs. `Write`)
- `src/client/components/PresentPane.tsx` — **new component**, the Present tab
- `src/client/stores/present-store.ts` — **new store**, presentation list + active index
- `src/client/AppLayout.tsx` — add Present tab to right panel, conditional visibility

### Tier 2 (future)
- `src/server/session/session-worker.ts` — `GET /present-files/*` static serving.
  **Partially realized by docs/170** (`docs/170-present-artifact-screenshot-loop/`,
  TRACKER-68): the single-entry serving path now exists so the agent can navigate
  its own browser to a worker-local `viewUrl` and screenshot the rendered
  artifact. Multi-file (`files`/`entry`) and orchestrator preview-proxy routing
  for the *user's* browser remain future work.
- `src/server/orchestrator/preview-proxy.ts` — proxy route for scratch-dir files

## Gallery view, active-position memory, and the typing-carousel fix

Three related Present-tab refinements (folded into one change):

- **Gallery view ("view all").** With many artifacts, stepping the `◀ N/M ▶`
  carousel one at a time is tedious. A grid icon **beside the carousel
  controls** (where the eye already is — not off in the right-side actions)
  toggles a thumbnail grid of every artifact; clicking a tile jumps to it and
  collapses back to the single view. Shown only when there's more than one
  artifact (same threshold as the carousel). `Esc` closes it. Thumbnails are
  **lazy live renders**, mounted only once a tile scrolls near the viewport
  (IntersectionObserver, 300px margin) with bytes fetched on reveal via the
  shared `loadPresentContent`: HTML/SVG use the same `pointer-events:none`
  sandboxed `RenderedFrame` as the single view (fixed 1280×800 logical size
  scaled to the tile width via ResizeObserver, for a faithful shrunk-page
  preview rather than a mobile reflow); **markdown reuses the docs
  `MarkdownBlock` renderer** on the app background at a narrower 800×500 logical
  page so prose stays readable; images draw directly; other kinds fall back to a
  type icon. Columns are container-query responsive (2 → 3 → 4) so the grid
  adapts to the **pane** width, not the viewport. Tiles **animate in** on open
  with a staggered fade/zoom/slide (`animate-in` utilities, 35ms-per-tile delay
  capped at 11 tiles, `motion-reduce:animate-none`). Store state: `galleryOpen`
  (reset on session switch / full clear).

- **Active-position memory.** The active artifact is remembered per session
  (`lastViewedBySession`, keyed by the stable `presentId`, kept OUTSIDE the
  store state so `reset()` on a session switch doesn't wipe it) and restored
  inside `hydrate`. A session switch / late tab open lands the user back where
  they left off instead of snapping to the first artifact. Seeded from / written
  through to localStorage (`getSavedActivePresentBySession` /
  `saveActivePresentBySession`), so the position also survives a full page
  reload — browser-local view state (may differ across devices), not
  server-persisted. A stale entry (artifact since gone) is harmless: `hydrate`
  falls back to clamping when the id isn't found.

- **Typing no longer moves the carousel.** The pane's arrow-key nav listener is
  on `window`, and the chat composer is on screen alongside the Present tab, so
  pressing ◀/▶ to move the text cursor while typing also stepped the carousel.
  The handler now ignores keystrokes whose target is an `INPUT`/`TEXTAREA`/
  `SELECT`/`contenteditable`, mirroring `useKeyboardShortcuts`' input guard.

Key files:
- `src/client/components/PresentGallery.tsx` — the thumbnail grid + lazy tile
- `src/client/utils/present-content-fetch.ts` — shared lazy bytes fetch (single view + gallery)
- `src/client/components/PresentPane.tsx` — gallery toggle, gallery render, keydown focus guard
- `src/client/stores/present-store.ts` — `galleryOpen`, per-session active-position memory
- `src/client/utils/local-storage.ts` — `getSavedActivePresentBySession` / `saveActivePresentBySession` (reload-durable position)
