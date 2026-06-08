---
description: Serve buffered present artifacts at a worker-local URL so the agent can screenshot its own visual output with the browser it already has and iterate.
---

# Present artifact screenshot loop — let the agent see its own visual work

## Problem

The `present` MCP tool (docs/093, Tier 1) is **inline-only**. When the agent
calls `present({ content, mimeType })`:

- the content lands in the worker's in-memory `PresentBuffer`
  (`src/server/session/present-buffer.ts`),
- streams over SSE → WS to the client,
- and renders **client-side** in a sandboxed `srcdoc` iframe
  (`src/client/components/PresentPane.tsx`).

The tool result the agent gets back is just `{ presentId, status: "presented" }`.
There is **no URL** the artifact is served at, and **no rendered view** comes
back to the agent.

So the agent is blind to its own visual output. It can describe HTML it *thinks*
it produced, but it can't see how the markup actually rasterizes — broken
layout, clipped SVG `viewBox`, overflow, low contrast, a chart that rendered
empty because the inline JS threw. Those are exactly the failures you only catch
by looking at the pixels.

Meanwhile the agent **already** has a Playwright browser inside the session
container and already screenshots **live previews** (dev servers on a port). The
only reason it can't do the same for a presentation is that presentations aren't
reachable by URL. Closing that one asymmetry is the whole feature.

## Approach (Option 1 of the design discussion)

Serve buffered presentations at a **worker-local URL** and let the agent
screenshot them with the browser it already drives. No new screenshot
capability, no new user-facing surface — the agent is the actor (CLAUDE.md §5),
and the loop stays entirely inside ShipIt.

This is the serving half of the **Tier 2** path that docs/093 sketched as
"future" but never built. We scope it down to exactly what the screenshot loop
needs.

### The loop

```
present({ content, mimeType, title })            // → { presentId }
  → browser_navigate(127.0.0.1:${WORKER_PORT}/present-files/{presentId})
  → browser_take_screenshot                        // agent SEES its output
  → observe defects → edit content
  → present({ content, mimeType, replaceId: presentId })   // revise in-place
  → browser_navigate(... same URL ...) → screenshot   // confirm the fix
```

`replaceId` already exists in the Tier 1 API and `PresentBuffer.put()` already
handles in-place replacement, so the revise step needs no new plumbing. The user
sees each revision land in the Present tab as the agent iterates — the
screenshot loop and the human-visible carousel are the same artifacts.

## Why this approach

- **Reuses the existing browser stack.** The agent-CLI image already ships
  Playwright/Chromium and the agent already knows `browser_navigate` /
  `browser_take_screenshot` from live-preview work. Nothing new to teach.
- **Same rendering engine the user sees.** The artifact renders in real
  Chromium, the same engine backing the client's `srcdoc` iframe — what the
  agent screenshots is what the user sees, modulo the sandbox attributes.
- **Bytes already exist.** `PresentBuffer` holds the exact content keyed by
  `presentId`. The endpoint is a thin read over a map that's already there.
- **Product-principle fit.** Inside ShipIt, agent-driven, no link-out (§1/§3),
  no shell-shaped affordance (§5). Ephemerality is preserved — content stays in
  worker memory + the container's lifetime, never the workspace.
- **Unlocks multi-file later.** The same `/present-files/:presentId/*` route is
  the natural home for the multi-file artifacts Tier 2 also wanted; this issue
  ships the single-entry case and leaves the door open.

## Design

### Worker: `GET /present-files/:presentId/*`

A new route on the session worker's Fastify instance
(`src/server/session/session-worker.ts`), served on the existing worker port
(`127.0.0.1:${WORKER_PORT}`) that the agent's in-container browser can reach
(same localhost surface the `gh` / `shipit` shims and the present-save broker
already use).

Handler:

1. Look up `presentId` in the `PresentBuffer`. 404 if absent (evicted by LRU,
   or never existed).
2. Set `Content-Type` from the entry's `mimeType`.
3. Serve the body:
   - **`text/html`** — return `content` as-is.
   - **`image/svg+xml`** — wrap bare SVG markup in a minimal HTML document
     (`<!doctype html><html><body style="margin:0">…</body></html>`) so the
     browser renders it edge-to-edge and a screenshot captures the whole
     drawing rather than a default-sized `<img>`. Also serve the raw SVG at the
     same path when requested as an image, if simplest is to always wrap — TBD
     during implementation; wrapping is the safe default for the screenshot use
     case.
   - **`text/markdown`** — must be converted to HTML by a **server-side**
     markdown pass. The client's `react-markdown` renderer
     (`src/client/components/message-markdown.tsx`) is a client-only React
     component and is **not reachable from the worker** (a Fastify server with no
     markdown library bundled). Serving the buffered markdown as-is with
     `Content-Type: text/markdown` would make the browser show raw source, so the
     agent's screenshot would capture unformatted markdown — defeating the loop
     for this mime type. The implementation must add a lightweight markdown→HTML
     library to the worker (e.g. `marked`) and serve the rendered HTML in a
     minimal HTML wrapper. Note this is purely for the agent's screenshot view;
     the user-facing Present tab still renders markdown via `react-markdown`
     client-side, so the two paths will use different renderers — acceptable for
     a screenshot-fidelity check, but worth keeping in mind.
   - **`image/png` / `image/jpeg` / `image/gif`** — the content is a `data:`
     URI; decode to bytes and serve with the matching content type (or embed in
     a zero-margin HTML wrapper — wrapper is fine, the agent only screenshots).
4. Set headers that make the artifact safe and un-cacheable
   (`Cache-Control: no-store`; no credentials needed — it's localhost-only).

The route is **worker-local by design** — it does **not** go through the
orchestrator preview proxy. The only consumer is the agent's in-container
browser, which already talks to `127.0.0.1:${WORKER_PORT}`. Keeping it off the
proxy avoids exposing ephemeral artifacts on a publicly routable preview URL and
keeps the blast radius small. (If we later want the *user's* browser to load
multi-file presentations this way, that's a separate proxy-routing decision —
explicitly out of scope here.)

### Agent docs: `src/server/shipit-docs/present.md`

Add a short "Iterating on visual artifacts" section documenting the loop above:
after `present(...)`, the agent can navigate its browser to
`127.0.0.1:${WORKER_PORT}/present-files/{presentId}` and screenshot to verify
the rendered result, then revise with `replaceId`. This is the load-bearing
behavioral change — the endpoint is useless if the agent doesn't know to use it.

Confirm the worker port env var name the docs should reference
(`WORKER_PORT` vs whatever the agent-facing name is) during implementation and
write the exact URL the agent should hit.

## Out of scope

- **Option 2 — auto-raster in the tool result.** Having `present` headless-render
  the artifact to a PNG and return it in the tool result (one-call loop) is a
  nice ergonomic layer but a separate change; track it on its own if we want it.
- **Option 3 — client-side pixel capture** of the actual `srcdoc` iframe.
- **Orchestrator preview-proxy routing** for present artifacts (user-browser
  access to multi-file presentations).
- **Multi-file artifacts** themselves (the `files` / `entry` Tier 2 API). The
  route is shaped to accommodate them later but this issue ships single-entry.

## Key files (to be updated when implemented)

- `src/server/session/session-worker.ts` — new `GET /present-files/:presentId/*`
  route reading from the `PresentBuffer`.
- `src/server/session/present-buffer.ts` — no change expected; `get(presentId)`
  already exposes the entry. Confirm the byte/mime data is sufficient to serve.
- `package.json` — add a server-side markdown→HTML library (e.g. `marked`) for
  the `text/markdown` path. Follow the dependency policy in CLAUDE.md: pin an
  exact version, ≥7 days old, refresh the lockfile, run `npm run check-deps`.
- `src/server/shipit-docs/present.md` — document the screenshot-and-iterate loop.
- `docs/093-agent-present/plan.md` / `checklist.md` — cross-reference this doc as
  the realization of the Tier 2 serving path.

## Open questions

1. **SVG/markdown/image serving shape** — always wrap in zero-margin HTML, or
   content-negotiate raw vs wrapped? Wrapping is the safe default for
   screenshots; settle during implementation.
2. **Worker port reference in docs** — confirm the exact env var / URL the agent
   should navigate to, and whether it's already surfaced to the agent elsewhere.
3. **404 ergonomics** — when an artifact was LRU-evicted, the navigate will 404.
   Worth a clear body the agent can read ("presentation evicted; re-present to
   get a fresh URL") so it self-corrects rather than guessing.
