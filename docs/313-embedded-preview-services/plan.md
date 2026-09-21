---
issue: planning#608
title: Embedding a Compose service by name — design
description: How shipit-preview://<service>/<path> resolves inside a previewed page so it works as an iframe src, and what happens when the named service is stopped.
---

# Embedding a Compose service by name — design

Implements [`requirements.md`](./requirements.md). Requirements are cited as
`(req N)`.

## The gap

docs/258-agent-authored-links made `shipit-preview://<service>/<path>` a **link**.
Everything it needs — the service name resolved against the session's declared
services, the port ShipIt owns, the start of a stopped service — is already
solved. What it produces is a navigation: the Preview tab is selected and the
user is taken away from the page they were reading.

An **embed** is the same address used as an `<iframe src>`, and it is not a
smaller version of the link. A link is resolved by ShipIt's own React code on a
click it observed. An embed is resolved by **the browser**, inside a document
ShipIt did not author, at parse time, with no click and no way to wait (req 1).

## The constraint that decides the shape

A browser cannot resolve an unregistered scheme in `src` at all. So the address
must be turned into a real URL **before the browser is asked to load it**, and
the only code that runs inside the previewed document is what ShipIt injects
there. That is not a new mechanism: `preview-proxy.ts` already injects
`HMR_WS_PATCH` and the Agent Interface SDK into every proxied HTML response.

This adds a third injected script — the **embed resolver** — and nothing else on
the page side.

**ShipIt never edits the page's markup bytes.** The resolver rewrites the live
DOM, which is what makes req 9's second half work: an iframe a framework creates
later is rewritten the same way a literal tag in the source is. Rewriting the
HTML text would cover only the first and would have ShipIt parsing and
re-serialising documents it does not own.

**One consequence of rewriting the DOM rather than the markup**, measured in
Chrome on 2026-09-21: an iframe a *script* inserts is briefly in the document
carrying the unresolved address, so the browser tries to launch the scheme and
logs `Not allowed to launch 'shipit-preview://…'` before the observer rewrites
it. An iframe the **parser** inserts is rewritten before its load is attempted
and logs nothing. Console noise in the embedding page, no failed request, and the
cost of not parsing and re-serialising documents ShipIt does not own.

## Where the port comes from

The resolver needs one fact the page cannot derive: **service name → port**. It
rides as a `data-shipit-services` attribute on the injected script tag:

```html
<script data-shipit-services='{"assetgen":5173,"web":3000}'>…</script>
```

An attribute rather than a value baked into the script body, and that is
load-bearing. `allowPreviewBootstrapInCsp` permits ShipIt's injected scripts
under a page's own CSP by **`sha256` hash of the script's content**, computed
once at module load from constant strings (`preview-proxy.ts:156`). A per-session
map inside the body would make the content vary per response, so every response
would need its own hash computed and spliced into that page's CSP. A CSP hash
covers the script's text and not its attributes, so carrying the map as an
attribute keeps the body constant and the existing hash list correct — the
resolver reads it back through `document.currentScript`.

Ports are **declared** values, read from the compose file (`ManagedService.port`),
so they are stable for the session and do not go stale between a start and a
stop. Status is deliberately **not** in the map: the page never decides whether
to start a service, it only says what it wants (below), so shipping status would
be a fact that can rot for no gain.

The origin is derived from the page's own address, not from the map. A previewed
page is served at `{sessionId}--{port}.{host}`, so the sibling service's origin is
that host with the port segment replaced. The session id therefore never has to
be injected, and the page can address nothing outside its own session (req 3).

## Resolving, and the gate that keeps it inside the session

Resolution mirrors `parseShipitLink`'s preview branch, and the two must agree
about what an address means; the resolver is deliberately the *narrower* of the
two, because a value it produces becomes a load and not a toast:

- The authority is matched **exactly** against a key of the injected map. No
  prefix match, no case folding — the same rule the link parser applies against
  the declared service list (`shipit-link.ts:276`). An unknown name is left
  alone and warned about in the page's console; there is no channel from an
  embed to a toast, and inventing one for an author's typo is not worth a
  protocol.
- The resolved URL is built with `new URL(path, origin)` and **refused unless
  `resolved.origin === origin`**. This is the guard that actually holds the
  boundary, and it is the same one `withPath` uses when a remembered path is
  resolved against a slot (`usePreviewSlot.ts:81`). Backslashes and tab/CR/LF are
  rejected before that resolution for the reason `shipit-link.ts` documents: URL
  parsing folds `\` into `/` and strips those characters anywhere in the input,
  so `/\evil.example/x` resolves to a foreign host while passing a naive
  "starts with one slash" test.
- `shipit-render` is stripped, as it is from a link. It is ShipIt's reserved
  name and selects how a *pointer* looks; it means nothing in an embed, and
  leaving it in the query would hand the framed page ShipIt's own knob — which
  docs/258-agent-authored-links req 11 forbids.

## A stopped service (req 5)

**The boot needs no new UI.** The iframe is pointed at the sibling origin
whatever the service's state; a request for a port nothing is listening on
reaches the proxy, which answers `503` with the self-refreshing connecting page
it already serves for a dev server that has not come up yet (docs/286). So the
embed shows "Connecting to the dev server on port …" and swaps itself for the
app the moment it answers. Its poll is a same-origin `fetch`, which works in a
frame with a real origin.

What is left is asking for the start, and that has to come from ShipIt because
`start_service` is a WebSocket message. The resolver posts
`{ source: "shipit-preview", type: "embed_start_service", name }` to its parent,
and `PreviewFrame` — which already receives `ready`, `path`, `loaded` and
`agent_message` from previewed pages — forwards it.

**Three gates, and each is load-bearing:**

1. **Page side — an `IntersectionObserver` on the iframe**, fired once, so the
   request is made when the embed is actually scrolled into view. This is the
   "on screen" of req 5: a docs page listing eight services boots the ones the
   reader reaches, not all eight on open.
2. **ShipIt side — the sending window must be a slot's `contentWindow`, it must
   be the ACTIVE slot, its origin must match that slot's, and the pane must be
   visible.** The first three are the checks `agent_message` already applies
   (`handle-request.ts:17`). The fourth is not redundant: the pane is hidden with
   `visibility: hidden`, which is invisible to geometry, so an
   `IntersectionObserver` inside the page reports an embed as intersecting while
   the user is looking at the Files tree (`PreviewFrame.tsx:73`'s docstring
   records this exact trap). Gate 1 alone would start containers behind another
   tab.
3. **ShipIt side — the service must be declared, and not already `running` or
   `starting`**, with a short per-name cooldown so two embeds of one stopped
   service in a single document send one start. The status check lives here and
   not on the page because the page has no status and must not acquire one.

A start that **fails** is not reported to the embed. docs/258's toast is tied to
a click the user made and is the answer to "why did nothing happen when I
pressed that?"; an embed had no click, and the service's own error is already in
the services drawer and the compose logs. The embed keeps showing the connecting
page, which is true: nothing is listening.

## Nesting (req 7)

The embedded document is itself proxied HTML, so it receives the same three
injected scripts. It is already inert as a ShipIt surface, and the reason is
worth stating rather than re-deriving:

- **The SDK takes `window.parent` as its host** (`bootstrap.ts:3`). For a
  top-level previewed page that is the ShipIt page; for an embed it is the
  *embedding page*, which never answers with the `visibility` message the
  handshake waits for. So `ready` rejects on the 5 s timeout, `embedded` stays
  `false`, and `sendMessage` — which awaits `ready` — throws. The embed cannot
  speak to the agent.
- **ShipIt would refuse it anyway.** `agent_message` is accepted only from a
  window that is a slot's `contentWindow`; an embed's messages never reach ShipIt
  in the first place, because `postMessage` to `window.parent` goes to the
  embedding page and no further.
- The same is true of `embed_start_service`: an embed's request reaches the
  embedding page, which is not ShipIt, and dies there. Two levels deep, nothing
  starts.

**Rejected: making the SDK fail fast on `window.parent !== window.top`.** It
reads as the obvious nesting test and it is wrong here — under the dogfood loop
(`RUNTIME_MODE=local`, docs/118-shipit-ui-local) an inner ShipIt is itself framed
by the outer instance, so a legitimately top-level previewed page inside it has
`parent !== top` and would lose the SDK. The timeout is slower and correct.

## Cross-origin (req 6)

Nothing to build, and two facts to pin with tests rather than assume:

- **ShipIt's own anti-framing headers do not apply.** `registerFrameGuard`
  exempts any request whose Host parses as a preview subdomain
  (`frame-guard.ts:15`), so `frame-ancestors 'none'` / `X-Frame-Options: DENY`
  are never sent on preview responses.
- **The container-mode preview iframe carries no `sandbox` attribute** — it is
  applied only in local (non-proxied) mode (`PreviewFrame.tsx:785`). So an embed
  inherits nothing: it is an ordinary cross-origin document with a real origin,
  its own storage, and same-origin `fetch` to its own server.

Measured end to end in Chrome against a two-service preview shape (2026-09-21):
the embedded document reports the sibling origin, `localStorage` writes, and
`fetch` to its own server returns 200 — the three things the artifact surface
loses. `window.shipit.embedded` is `false` in it, and its handshake rejects after
the 5 s timeout, which is req 7 in a real browser rather than in jsdom.

The embedding and embedded origins are **same-site, different-origin**
(`{id}--3000.host` and `{id}--3001.host`), which is what docs/262-plugins
established for preview origins generally. Framing one of the project's own
services from another is allowed by default: both are the same session's own
declared services, and req 6 is the requirement that says so.

**Two limits are the app's own to fix, and ShipIt does not rewrite its way past
them.** An app that sends `X-Frame-Options` or `frame-ancestors` refuses to be
framed — such an app is already broken in the Preview itself, except in the
narrow case where it names ShipIt's origin explicitly. And an app that sends a
CSP with `frame-src`/`child-src`/`default-src` blocks the embed from its side.
ShipIt patches `script-src` today only because its own injected scripts cannot
run otherwise; widening a policy the app author wrote so that *their own markup*
works is a different act, and it belongs in its own change if it is ever wanted.

## What a framed document must do (req 8)

This is documentation, not mechanism, and it is here because the trap is real and
silent. A chat pointer at a page the user is already on navigates **in place** —
the fragment changes directly, and a changed query string is `pushState` plus a
synthetic `popstate` (`preview-proxy.ts:102`). A document that reads
`location.search` once at load keeps showing its old view under the new address,
with no error anywhere. Every address of a single-path viewer is that case, so
the second pointer and every one after it appear dead.

Embedding makes it more common, because an embed *is* a single-path viewer by
construction. `chat-links.md` therefore states plainly that a framed document
must subscribe — `popstate`, `hashchange` — rather than read its address once.

One behaviour worth stating with it: a **chat pointer never targets an embed**.
It names a service, and ShipIt opens that service's own top-level slot, replacing
the Preview with it. An embed is a place inside someone else's page, and ShipIt
has no address for it.

## Key files

| File | Role |
|---|---|
| `src/server/shared/preview-embed/bootstrap.ts` | The injected resolver: parse, resolve against the map, rewrite `src`, observe, request a start |
| `src/server/orchestrator/preview-proxy.ts` | Inject it with the session's declared service→port map; hash it into the CSP allowlist |
| `src/client/components/PreviewFrame/PreviewFrame.tsx` | Accept `embed_start_service` from the active, visible slot only |
| `src/client/App.tsx` | Send `start_service` for a declared service that is not already running |
| `src/server/shipit-docs/chat-links.md` | Agent-facing reference: the `src` form, the stopped-service behaviour, req 8's warning |
| `src/server/shipit-docs/agent-interface-sdk.md` | That `window.shipit` is not available to an embedded frame |
| `src/server/shipit-docs/wiki/previews.md` | User-facing: a preview can hold another service inline |

## Non-goals

- `shipit-present:` as an `<iframe src>`, and embedding a service **inside a
  presented artifact**. Both are non-requirements; the second was measured and
  rejected (see the requirements doc's resolved questions) because an artifact's
  frame is sandboxed without `allow-same-origin` and a nested frame inherits it.
- Rewriting an app's own CSP or framing headers so its embeds work.
- Reporting an embed's failures — an unknown service name, a start that failed —
  anywhere but the page's own console and the surfaces that already show compose
  errors.
- Local (non-proxied) previews. Nothing is injected into them at all, so the
  scheme does not resolve there; that is the existing boundary, not a new one.
