---
issue: https://linear.app/shipit-ai/issue/SHI-91
description: Make the `present` tool file-based — the agent writes a file and presents it by path, so prototypes can be tracked in git and rendered in the Present tab at the same time.
---

# Present from a file — one path, tracked or throwaway

## Problem

The `present` tool (docs/093) was **inline-only**: the agent passed the artifact
body as a `content` string and an explicit `mimeType`. That made every
presentation ephemeral by construction — the bytes lived only in the worker's
`PresentBuffer`, never on disk. The only way to keep one was the client-side
"Save to project" button, a one-shot byte copy after which the Present tab and
the saved file diverged.

But a real workflow kept coming up: the agent builds a prototype (a mockup, a
diagram, a landing page) that the user *does* want to **merge back into git** —
reviewed in the PR, committed, iterated on — while still seeing it rendered in
the Present tab. With an inline `content` API there was no way to present a file
that was also a tracked workspace deliverable. CLAUDE.md already encourages
committing `mockup.html` / `mockup.svg` into feature folders as diffable
reference artifacts; the present tool couldn't render those.

## Decision

Make `present` **file-based**. The agent writes a single self-contained file
(it already has `Write`), then calls `present({ file })` with the path. The
worker reads the file, infers the MIME type from the extension, and feeds the
bytes into the **existing** buffer → SSE → client `srcdoc` pipeline. Nothing
about rendering, sandboxing, or the WS protocol changes.

**Tracked vs. ephemeral falls out of where the agent writes the file — there is
no special handling and no new field:**

- A path under **`/tmp`** → throwaway. Never enters the workspace, file tree, or
  git. (`/tmp` is already the documented scratch area.)
- A path under the **workspace** → shows in the file tree, auto-committed like
  any file, **and** rendered in the Present tab. This is the "merge prototypes
  to git" case.

The `content` and required-`mimeType` parameters are **removed**. `mimeType`
remains as an optional override; by default it is inferred from the extension.

### Why file-based (rejected: keep inline `content`)

- **It's the only way to present a tracked artifact.** An inline string has no
  path, so it can never *be* a committed file. A file path can point anywhere —
  `/tmp` or the workspace — so one API spans both lifecycles.
- **Easier for the agent.** Writing a file then presenting it is the same
  muscle the agent already uses for every deliverable; it avoids passing large
  HTML/SVG bodies (with awkward `<`, `>`, quotes, newlines) as a tool argument.
- **No new infrastructure.** The buffer still snapshots the bytes, so the
  docs/170 worker-local `viewUrl` screenshot loop, the client renderer, the
  `present_state` replay, and "Save to project" all keep working unchanged.

### Scope held deliberately small

- **Single file only.** Multi-file artifacts (the `files`/`entry` Tier-2 idea in
  docs/093) remain out of scope — that's the Preview pane's job.
- **Serving stays the existing mechanism.** The client still renders from the
  `content` the worker emits over WS into a sandboxed `srcdoc` iframe — no
  orchestrator preview-proxy route, no origin/sandbox rework. (Those costs are
  what going to a fully proxied `<iframe src>` would incur; not paid here.)
- **Reload = re-present.** There is no file watcher. After editing the file the
  agent calls `present` again (with `replaceId` to revise in place). Accepted as
  the simplest reload story.

## How it works

1. **Agent** writes a file (`/tmp/...` or a workspace path), then calls
   `present({ file, title?, replaceId? })`. `mimeType` is an optional override.
2. **Bridge** (`mcp-present-bridge.ts`) forwards `{ file, mimeType?, title?,
   replaceId? }` to the worker's `/agent-ops/present/submit` broker — pure
   transport, unchanged otherwise.
3. **Worker** (`session-worker.ts`):
   - Resolves the path: relative → against `workspaceDir` (the agent's cwd),
     absolute → as-is.
   - Infers the MIME from the extension (`inferPresentMimeType`), unless
     `mimeType` overrides it; unknown extensions → `text/plain`.
   - Reads the file into the `content` string the rest of the pipeline expects:
     binary images (`isBinaryPresentMime`) become a `data:` URI; everything else
     (HTML/SVG markup, markdown, text) is read as UTF-8.
   - On a read error (missing file, etc.) returns **400** with a clear message
     the agent can act on.
   - From here it's the existing path: `PresentBuffer.put` (≤1 MB/entry, 20-entry
     + 16 MB LRU), `present_content` SSE, `viewUrl` for the screenshot loop.
4. **Client** is unchanged — `PresentPane` renders from `content`/`mimeType` as
   before. "Save to project" still works (useful for a `/tmp`-sourced present;
   redundant but harmless for a workspace file).

## MIME inference

`inferPresentMimeType(path)` (in `present-view.ts`, unit-tested) maps:
`.html`/`.htm` → `text/html`, `.svg` → `image/svg+xml`, `.md`/`.markdown` →
`text/markdown`, `.png` → `image/png`, `.jpg`/`.jpeg` → `image/jpeg`, `.gif` →
`image/gif`, `.webp` → `image/webp`, `.txt`/`.text` → `text/plain`. Unrecognized
→ `""`, and the worker falls back to `text/plain` (rendered as escaped
preformatted text). Kept in sync with the renderer in the same module and the
client's `PresentationContent` branch list.

## Key files

- `src/server/session/mcp-present-bridge.ts` — `present` tool schema: `file`
  (required) replaces `content`; `mimeType` is now an optional override.
- `src/server/session/session-worker.ts` — `/agent-ops/present/submit` resolves
  + reads the file, infers MIME, snapshots into the buffer.
- `src/server/session/present-view.ts` — `inferPresentMimeType`,
  `isBinaryPresentMime` (new exported helpers).
- `src/server/shipit-docs/present.md` — agent-facing docs rewritten file-based.
- `src/server/orchestrator/agent-instructions.ts` — `present.md` added to the
  system prompt's "Key docs" list so the agent can discover it (it was baked
  into the image but unlinked).

## Surfacing the tool to the agent (two surfaces, one job each)

Guidance lives on two surfaces with different guarantees:

- **Tool description** (`mcp-present-bridge.ts`) is the only thing guaranteed in
  the agent's context when it calls `present` and receives `viewUrl`. So it
  carries the action-critical trigger: write a file → present by path → navigate
  `viewUrl` and screenshot to self-verify → revise with `replaceId`. It also
  carries the new-API nuance that **the agent must screenshot `viewUrl`, not the
  file directly** — now that the agent holds a real path, opening `file://`
  would skip the markdown/SVG/image rendering and produce a misleading
  screenshot. The description points to `present.md` for the rest rather than
  inlining it (that text ships on every request).
- **`present.md`** holds the full reference (step-by-step loop, MIME inference,
  limits, examples). Previously orphaned; now linked from both the tool
  description and the system prompt's docs list.
- `src/server/session/mcp-present-bridge.test.ts`,
  `src/server/orchestrator/integration_tests/present-flow.test.ts` — updated to
  the file-based API (+ missing-file 400 coverage).

## Discovery is search-gated (tool search), not upfront

Both backends defer MCP tools behind a search layer by default, so the agent
does **not** see the `present` definition at session start:

- **Claude Code** (pinned 2.1.161): tool search is on by default — only MCP tool
  *names* and *server instructions* load at session start; full definitions are
  fetched on demand via the `ToolSearch` tool (`tool_reference` → expanded def).
  ShipIt sets neither `ENABLE_TOOL_SEARCH` nor `alwaysLoad` and uses no custom
  `ANTHROPIC_BASE_URL`, so the default (deferred) applies. (Disabled only on
  Vertex AI / non-first-party base URL / Haiku.)
- **Codex** (pinned 0.136.0): uses a BM25 tool index with deferred MCP tool
  calls; tools-only MCP servers like this bridge were historically invisible to
  its search until codex#16944 (~Apr 2026).

This is why `present` stayed dormant unless explicitly asked: the agent had to
*think to search* for it and *then* choose it, with no cue to do either.

### Portable discoverability levers (applied)

`alwaysLoad` (and the `anthropic/alwaysLoad` tool `_meta` key) would force the
definition upfront — but it is **Claude-only**; Codex has no equivalent. So we
use the levers that work for *both* search layers:

1. **System-prompt nudge** (`agent-instructions.ts`, "Showing visual work"):
   tells the agent to proactively `present` visual artifacts rather than only
   describing them. Agent-agnostic — both backends receive the ShipIt system
   prompt. This is what makes the agent *want* to reach for (search) the tool.
2. **MCP server `instructions`** on the present bridge: both Claude's tool search
   and Codex's BM25 index rank deferred tools on the server instructions, so
   this is the field that makes `present` *findable* by a search. (Kept < 2 KB;
   Claude truncates there.)
3. **Sharper tool description**: front-loads the visual-artifact trigger
   keywords (diagram/chart/mockup/wireframe/prototype) so the search ranks it and
   the model picks it once surfaced.

`alwaysLoad` was deliberately *not* used — the goal was cross-agent parity, and a
Claude-only flag would help one backend and not the other.

## Relationship to docs/093 and docs/170

- **docs/093** introduced `present` (Tier 1, inline `content`), the Present tab,
  the buffer, "Save to project", and `present_state` replay. This doc supersedes
  its `content` API with the file-based one; everything downstream of the buffer
  is reused as-is.
- **docs/170** built the worker-local `viewUrl` serving + screenshot loop off
  the buffer. Unaffected — the buffer is still populated, just from a file.

## Out of scope / future

- Multi-file artifacts and an orchestrator preview-proxy route for the user's
  browser (full Tier 2).
- Live file-watch reload (today: re-present after editing).
- A "tracked" badge / "reveal in file tree" affordance in the Present tab —
  intentionally skipped; tracked-ness is emergent from the path and needs no UI.
