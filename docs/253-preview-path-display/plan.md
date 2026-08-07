---
description: Show the previewed page's path and query string in the preview toolbar, reported out of the cross-origin iframe by the injected script.
---

# Preview path display

Implements [`requirements.md`](./requirements.md). The preview toolbar shows which
page the preview is currently on — path and query string, never the host or port.

Visual reference: [`mockup.html`](./mockup.html) (placement options, truncation
behaviour, and the empty/root states).

This is the companion to the refresh fix (PR #2019): once refresh keeps you on the
page you were on, you want to be able to see what that page is.

## Why the page has to report its own path

The preview iframe is cross-origin — it lives on a `{session}--{port}` subdomain —
so the parent cannot read `contentWindow.location`. The value has to be pushed
*out* of the page by the script `preview-proxy.ts` injects into every proxied HTML
response (`HMR_WS_PATCH`), over the same `shipit-preview` message channel that
already carries `loaded` (req 1).

A load-time read alone is not enough (req 3). A client-side router changes the URL
with `history.pushState` and no navigation, so the script also wraps `pushState`
and `replaceState` and listens for `popstate` and `hashchange`. It is first in
`<head>`, so it patches before any app code runs; a framework that wraps history
itself ends up wrapping ours, and the report still fires. The wrapper calls
through and preserves the original return value — it sits on the hot path of every
SPA navigation in every preview, so swallowing either would break routing.

`preview-proxy.test.ts` executes the real injected string in a `node:vm` sandbox
with fake `window`/`history`/`location` rather than pattern-matching its source.

## The reported value is untrusted input

The path is authored by the previewed page, which is arbitrary user code. The
message handler in `PreviewFrame` requires a same-document absolute path and caps
the length (`MAX_PATH_LENGTH`). The `//host/x` rejection is the load-bearing one:
protocol-relative URLs resolve against the slot URL into a *different* origin, so
without it a page could put a foreign host into the toolbar tooltip and onto the
user's clipboard. Only then is the absolute URL recovered with
`new URL(path, slotUrl)` for click-to-copy.

Attribution is by `contentWindow` identity, matching the existing `loaded`
handling — a message from a window that owns no slot is dropped, so one preview
cannot report a path on another's behalf.

## State lives per slot

Paths are held in a `Map<slotKey, string>` in `PreviewFrame`, keyed the same way as
the iframe pool (`sessionId:port`). Background iframes stay mounted and keep
reporting, so a single "current path" value would let a background session
overwrite what the visible one shows. Entries are dropped alongside the other
per-slot tracking when a merged session's background iframe is torn down.

## Display decisions

These are design choices, not requirements — the requirement is only that the path
and query show (req 2) and that it is read-only with click-to-copy (req 4).

- **The query string is a second-class citizen.** It is dimmed, and it shrinks far
  more eagerly than the route (`shrink-[999]` against the route's default `1`), so
  a long query gives up its space first. Proportional shrinking would truncate
  both, costing the user the part that says where they are. The mockup's narrow-panel
  comparison is why: a naive single-string ellipsis cuts the route *and* hides the
  query entirely.
- **The split is at the first `?`, not at `#`.** Hash routers keep the real route
  after the hash (`/#/orders?tab=open`), so splitting on `#` would grey out the
  only informative part.
- **Unknown renders no chip, but keeps the region.** A non-proxied local preview
  has no injected script and never reports a path; an empty chip would read as
  "this page has no URL", and dropping the region would shift the toolbar when a
  path arrives.
- **Its own toolbar region, left-aligned** (req 5). It claims the slack between the
  two existing groups so it truncates on its own terms instead of competing with
  the port and device selectors for width — but the content is left-aligned, so
  the path starts at a fixed x position rather than drifting as the route changes
  length.

## Key files

- `src/server/orchestrator/preview-proxy.ts` — `HMR_WS_PATCH`; reports the path and
  wraps the History methods. Its CSP hash is derived from the string, so it updates
  automatically.
- `src/client/components/PreviewFrame/PreviewPath.tsx` — the chip: route/query
  split, truncation priority, click-to-copy.
- `src/client/components/PreviewFrame/PreviewFrame.tsx` — `path` message handling,
  validation, per-slot state, absolute-URL resolution.
- `src/client/components/PreviewFrame/PreviewToolbar.tsx` — hosts the region.
