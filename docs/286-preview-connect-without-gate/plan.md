---
title: Preview connects without a client-side gate — design
description: Retry the upstream connect inside the preview proxy, serve a connecting page when it runs out, and delete the health probe and the client poll.
---

# Preview connects without a client-side gate — design

Implements [requirements.md](./requirements.md).

## The problem

An iframe loads its URL one time. Before this change, a preview request that
arrived before the dev server listened got `502 {"error":"Container preview
unreachable"}` from `proxyHttp`, and the iframe kept that body — there is no
reload affordance on it and no retry.

To avoid that, the client gated iframe creation behind a probe:
`GET /api/preview-health/:sessionId/:port` sent `HEAD /` to the container and
answered `ready` only for a status below 500; `usePreviewHealthPoller` polled it
(2 s per fetch, 250 ms between, 15 s wall-clock deadline) and set the iframe
`src` only after `ready`. The pane showed "Connecting to dev server..." for the
whole of that poll.

That gate cost real time even when nothing was wrong (req 1), and it answered a
different question from the browser's (req 3):

- The probe demanded a status below 500 from `HEAD /`. An app that does not
  implement `HEAD`, or that 5xx's on `/` while its real routes work, was
  "not ready" for the full 15 s and instant in a tab.
- The probe went straight to the container IP with no `Host` rewrite, while
  every proxied request gets `Host: localhost:<targetPort>` from
  `buildUpstreamHeaders` — so an app with a host allowlist could refuse the
  probe and serve the browser.
- Each failed attempt cost up to 2 s (server-side timeout) plus 250 ms.

## The design

Move the wait into the proxy, where the one-shot problem lives, and delete both
the probe and the poll.

### 1. The proxy retries the connect (req 2, 3)

`proxyHttp`'s single attempt becomes a bounded retry loop in
`proxyPreviewRequest`, which owns both failure modes that a too-early request
hits:

- **No target yet.** `resolveTarget` returns `null` while the Compose service
  has no container and the agent container is not registered. This used to be a
  hard `404`. It is now retried, and the target is re-resolved on every attempt
  so a container that changes IP is picked up.
- **Target present, nothing listening.** `ECONNREFUSED`, `EHOSTUNREACH`,
  `ENETUNREACH`, `ECONNRESET`, `EAI_AGAIN`, `ETIMEDOUT` — retried on the same
  loop.

`PREVIEW_CONNECT_RETRY_MS` (1 s) bounds the window; attempts are spaced by
`PREVIEW_CONNECT_RETRY_STEP_MS` (250 ms).

**The window is bounded by the client twice over, and is not a tuning
preference.** `PreviewFrame`'s auth detector reloads the iframe when no `loaded`
message arrives within `MAX_AUTH_TIMEOUT_MS` (5 s) and, after two such reloads,
reports "Preview authentication required" — so a held first load past that timer
produces precisely the false claim req 6 forbids. The tighter bound is the pane:
nothing renders while the request is held, so this window is also how long the
preview can look blank rather than saying "connecting" (req 4). A second of that
is ordinary navigation latency; more is a stare. So the window earns its keep
only on the short boot — Vite's "ready in 437 ms" — which it swallows with no
connecting page at all. Everything longer is the page's job.

**One attempt is bounded at the connect, and only at the connect**
(`PREVIEW_CONNECT_TIMEOUT_MS`, 3 s). A container whose address is stale drops
the SYN rather than refusing it, so no error fires — and the deadline is only
consulted from an error callback, so no error means no deadline and no
connecting page, forever. The bound deliberately stops at the connect: a dev
server compiling a route on demand accepts at once and answers a minute later,
and a *response* timeout would kill that working preview.

**Only `GET` and `HEAD` are retried.** A retry re-sends the request, and the
body of anything else has already been consumed by `rawReq.pipe(proxyReq)` —
there is nothing to replay. Every other method fails exactly as it did before.
This costs nothing in practice: the request that hits a cold dev server is the
iframe's navigation, and assets only follow an HTML response that already
proved the server is up.

A retry never happens after `headersSent` — once the upstream answered, the
response is being streamed and the outcome belongs to the app.

### 2. A connecting page instead of a 502 (req 4, 6)

When the window runs out, a request that is a `GET` whose `Accept` includes
`text/html` — the iframe's navigation — gets `503` with a small self-contained
HTML page instead of the JSON. Everything else (assets, XHR) keeps the `502`
JSON, because an asset must not receive HTML.

The page states the port it is waiting for and, after 30 s, adds the last
connect error underneath. So "connecting" is the previewed document's own state
(req 4) and a preview that never comes up says what it waits for rather than
spinning (req 6).

It **polls, then reloads** — it does not reload on a timer. Since it is what the
user watches for the whole of a slow boot, a blind reload every couple of
seconds would flash the pane throughout. Instead one rendered document sits
still, asking for its own URL every second; that request is answered by the same
retry path, so the 503 means "keep waiting" and anything else means the app is
up and it is time to reload into it.

The page is served through `injectPreviewBootstrap`, like any other preview
document. That is what keeps it from tripping the auth-blocked detector in
`PreviewFrame`: the detector force-reloads and then reports "Preview
authentication required" when no `shipit-preview`/`loaded` message arrives
within 5 s, and the bootstrap posts exactly that message (req 6). The claim it
makes is true — a page that reached ShipIt's own proxy was not intercepted by a
reverse-proxy auth gate, which sits in front of this origin.

### 3. A boot is not an error (req 5)

`reportError` moves once: it is called when the retry window is exhausted, not
per attempt. `createPreviewErrorReporter` (2 s grace, 5 s throttle, cleared by
`report.success`) is unchanged and now sees one report per genuinely failed
request rather than one per transient `ECONNREFUSED` during bring-up — which,
with the grace window on top, means a boot that resolves says nothing at all.

Both paths report. An earlier draft suppressed the report on the
connecting-page path, on the theory that it could wake auto-fix; that was
wrong. The report writes a Logs line and nothing else. Auto-fix reads the
separate captured-console `errors` collection (`useAutoFix` takes
`previewErrors`), so a proxy error cannot reach it. Suppressing the navigation
path would have lost the docs/124 §1.5 Logs record for a crashed preview and
bought nothing.

**Superseded (PR #2607).** At the time this was written the report also drove
an in-pane banner via `preview_error` and `message-handlers/preview-error.ts`.
That banner is gone, and the connecting page introduced by *this* doc is why.

`createPreviewErrorReporter` keys its failure streak and its `report.success`
signal on `(sessionId, port)` alone, so any success on that port deletes a
pending streak. The banner could therefore only fire reliably when *every*
request to the port failed — and for that case the connecting page names the
port, reveals the last error once the wait passes `CONNECTING_PAGE_DETAIL_MS`,
and reloads itself when the app answers. The banner restated it, and having no
recovery signal, stayed on screen after the preview came back. Where it would
have added something — a failure interleaved with working traffic on the same
port — the surrounding successes deleted its streak first.

The `preview_error` WS message, its handler, and the `previewProxyError` store
field were deleted with it. `reportError` is now Logs-only, and routes through
`appendAgentLog` so the record is durable rather than emit-only. The
HMR-upgrade case, which is the one with no other signal, is planning#489.

### 4. The client stops polling

`usePreviewHealthPoller` is renamed `usePreviewSlot` — with the poll gone it
does what its remaining body always did: create the iframe slot for the active
`(session, port)`, promote a retained one, and drop one whose port changed owner
(planning#394). Slot creation is now synchronous inside the effect, so the
iframe's `src` is set on the first pass.

Gone with it: the `pollUrl` and `isContainerMode` parameters, the 15 s deadline,
`pollingRef` (and its entry in `IframePool`), the whole cancellation invariant
that existed to stop duplicate polls, and the "Connecting to dev server..."
overlay in `PreviewFrame`. The overlay's own case is now covered by the page
behind it.

Two things had to be *added* to keep existing guarantees. A slot dropped for
an ownership takeover (planning#394) used to be recreated after the poll, so
React had already unmounted the iframe and the rebuilt slot got a fresh
element — which is what made it load the new owner's app. Without the poll the
drop and the rebuild happen in one effect pass, so React reconciles the same key
and keeps the live iframe, and the URL is identical (same session, same port),
so nothing reloads. `IframeSlot.generation` — a rebuild counter stamped by
`setSlot` and folded into the iframe's React key — restores the fresh element.

The same rebuild then invalidates the auth-detection state, which was keyed by
slot key alone: `loadedSlotsRef` and `authSettledRef` would have handed the new
owner's iframe the previous owner's "loaded" confirmation or "blocked" verdict,
skipping detection for a frame that never reported or leaving a stale overlay
over a working one. Both are now keyed by `${slotKey}#${generation}`, and the
detector's effect depends on the generation so a rebuild re-arms it.

The empty states that remain are unaffected: `waitingForService`
(planning#478) still owns "the service this pane is parked on is not running",
and `cannotSubdomainPreview` still owns "this host cannot carry a wildcard
subdomain".

## Key files

- `src/server/orchestrator/preview-proxy.ts` — `proxyPreviewRequest` (retry
  loop), `buildConnectingPage`, the deleted `/api/preview-health` route.
- `src/client/hooks/usePreviewSlot.ts` — was `usePreviewHealthPoller.ts`.
- `src/client/hooks/useIframePool.ts` — `pollingRef` removed,
  `IframeSlot.generation` added.
- `src/client/components/PreviewFrame/PreviewFrame.tsx` — overlay and
  `pollUrl` removed.

## What this does not change

- Subdomain routing is still the only preview mode (docs/175).
- The HMR WebSocket leg is not retried. Dev servers reconnect their own HMR
  socket (Vite pings every 30 s), and a raw byte pipe has no safe replay point.
- Local (non-container) previews. `computePreviewUrl` still has a
  `http://localhost:<port>` branch that the proxy never sees, and the deleted
  poll did have a `no-cors` pre-flight for it — but that branch is unreachable:
  the only builder of a non-`/preview/` status hardcodes `running: false`
  (`session-runner.ts` `buildPreviewStatus`), the client's
  `deriveEffectivePreviewStatus` synthesises a `/preview/…` URL, and slot
  creation requires `preview.running`. The pre-flight was already dead code.
