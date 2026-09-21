---
issue: planning#608
title: Embedding a Compose service by name
description: Make shipit-preview://<service>/<path> work as an iframe src, so a page can hold a live view of another service inline instead of sending the user away to it.
---

# Embedding a Compose service by name — requirements

What the feature must do, in the requester's terms. Design and mechanism live in
[`plan.md`](./plan.md).

## Context

`shipit-preview://<service>/<path>` (docs/258-agent-authored-links) resolves a
Compose service name to wherever that service answers, starts it if it is
stopped, and navigates the Preview tab. It is a **link**: it takes the user away
from what they were reading. A page cannot hold another service's view inline.

The requester hit this on the `assetgen` repository, which added a chrome-free 3D
viewer at `embed.html`, made to be framed. The natural consumer — a style guide, a
requirements sheet, a project's own docs page — has no URL it can write: a preview
is reached through ShipIt's proxy, the port belongs to the consuming project, and
the origin differs per session, so a hard-coded `host:port` is an address the
user's browser usually cannot open. The service **name** is the only stable thing,
and it is exactly what the scheme already resolves.

```html
<iframe src="shipit-preview://assetgen/embed.html?id=char%2Fminer%231&angle=front"></iframe>
```

## Requirements

1. The same `shipit-preview://<service>/<path>` address that works as a link also
   works as an **`<iframe src>`**: the named service renders **inline, in the
   embedding page**, rather than replacing what the reader was looking at.
2. This works in a **presented artifact** — a comparison sheet, a requirements
   doc or a style guide that holds a live view inline.
3. This works in **a service's own page** shown in the Preview — one of the
   project's pages embedding another of the project's services.
4. The author writes only the **service name**. No host, no port, no session id,
   no origin — the same address discipline a link already has.
5. An embed whose service is **not running** has a defined, documented
   behaviour. An iframe cannot wait for a click the way a link can.
6. ShipIt does not block a page from framing one of the project's own services.
7. An **embedded** document is not the active Preview or Present surface.
   `window.shipit` inside it does not report itself as embedded in ShipIt, and
   does not send messages to the agent on that page's behalf.
8. The agent-facing documentation states plainly what a framed document is
   expected to do when a pointer moves its address, so an author does not write
   a document that reads its address once at load and then shows stale content
   under a new one.

## Open questions

- **How deep does requirement 2 go?** A presented artifact is rendered in a
  frame that is sandboxed without `allow-same-origin`, and a nested frame
  inherits that: measured on 2026-09-21, a service framed inside an artifact
  gets `window.origin === "null"`, `localStorage` throws `SecurityError`, and
  `fetch` to its **own** server is refused by CORS. A self-contained embed page
  renders; one that loads a model, a texture or an API response over `fetch`
  does not. Ship requirement 2 with that constraint documented, or give
  presented artifacts an origin of their own first?
- **What does an embed of a stopped service do (requirement 5)?** Start it and
  show the boot, show a placeholder until someone starts it, or state plainly
  that it is stopped and stay inert?
- **Must a page with no JavaScript be able to embed (requirements 1, 3)?** A
  browser cannot resolve an unregistered scheme in `src` on its own, so either
  ShipIt rewrites the address before the browser sees it, or the page resolves
  it in script and assigns `src` itself. The second is simpler and covers only
  pages that run JavaScript.

## Resolved questions

_None yet._

## Non-requirements

- Embedding a **presented artifact** inside another page (`shipit-present:` as
  an `<iframe src>`). Only the preview scheme was asked for.
- Changing how a pointer navigates a page whose address moves. Requirement 8 is
  about documenting the existing mechanism, not altering it; the `assetgen` page
  that hit the trap has already been fixed to subscribe.
