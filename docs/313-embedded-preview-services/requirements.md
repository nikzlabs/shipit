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
viewer at `embed.html`, made to be framed. The consumer is **another of the
project's own services** — a style guide, a requirements sheet, a project's own
docs page — and it has no URL it can write: a preview is reached through ShipIt's
proxy, the port belongs to the consuming project, and the origin differs per
session, so a hard-coded `host:port` is an address the user's browser usually
cannot open. The service **name** is the only stable thing, and it is exactly what
the scheme already resolves.

```html
<iframe src="shipit-preview://assetgen/embed.html?id=char%2Fminer%231&angle=front"></iframe>
```

## Requirements

1. The same `shipit-preview://<service>/<path>` address that works as a link also
   works as an **`<iframe src>`**: the named service renders **inline, in the
   embedding page**, rather than replacing what the reader was looking at.
2. The embedding page is one the project's **own Compose services** serves — a
   style guide, a requirements sheet, a project's own docs page — shown in the
   Preview.
3. The embedding page and the embedded service are two different services of the
   same project, resolved by name within that session.
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

- **What does an embed of a stopped service do (requirement 5)?** Start it and
  show the boot, show a placeholder until someone starts it, or state plainly
  that it is stopped and stay inert?
- **Must a page with no JavaScript be able to embed (requirements 1, 3)?** A
  browser cannot resolve an unregistered scheme in `src` on its own, so either
  ShipIt rewrites the address before the browser sees it, or the page resolves
  it in script and assigns `src` itself. The second is simpler and covers only
  pages that run JavaScript.

## Resolved questions

- **2026-09-21 — Is a presented artifact one of the embedding surfaces?** The
  first draft read the brief as two surfaces and made the presented artifact
  requirement 2. The requester: *"it is not from the present tab, but from other
  services"*. Requirements 2 and 3 now name the project's own Compose services
  as the embedding page, and the presented artifact is a non-requirement.

  The measurement that prompted the question stands as the reason not to revisit
  it casually: an artifact renders in a frame sandboxed without
  `allow-same-origin`, and a nested frame **inherits** that, so a service framed
  inside an artifact gets `window.origin === "null"`, `localStorage` throws
  `SecurityError`, and `fetch` to its own server is refused by CORS. The
  container-mode preview iframe carries no sandbox attribute at all, so the
  surface that remains has none of those limits.

## Non-requirements

- Embedding a service inside a **presented artifact**. Removed 2026-09-21; see
  Resolved questions.
- Embedding a **presented artifact** inside another page (`shipit-present:` as
  an `<iframe src>`). Only the preview scheme was asked for.
- Changing how a pointer navigates a page whose address moves. Requirement 8 is
  about documenting the existing mechanism, not altering it; the `assetgen` page
  that hit the trap has already been fixed to subscribe.
