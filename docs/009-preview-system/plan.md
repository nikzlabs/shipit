---
issue: planning#492
title: Preview System
description: The preview pane — port detection, toolbar navigation, error capture, and per-origin renderer isolation.
---

# Preview System

The preview pane shows a live iframe of the user's app. Supports Vite (managed) and any other dev server (auto-detected via port scanning).

## Port detection

### Triggers

1. **After each Claude turn** (`done` event) — immediate scan
2. **Periodic interval** (every 5s, configurable via `portScanIntervalMs`) — catches servers started mid-turn via Bash tool. Interval starts when first client connects, stops when last disconnects.

### Port scanning

- `checkPort(port)` — TCP connect probe with 300ms timeout
- `scanPorts(ports, excludePorts)` — checks multiple ports concurrently
- `DEFAULT_SCAN_PORTS`: 3001, 4000, 4200, 5000, 5173, 5174, 8000, 8080, 8888
- Excludes ShipIt server port (3000) and managed Vite port when running

### Priority logic in `getPreviewStatus()`

1. Vite running → use Vite (`source: "vite"`), include `detectedPorts`
2. Ports detected → use first detected port (`source: "detected"`), include all
3. Neither → not running

### Multi-port UI

- Single port: green badge (Vite) or yellow badge (auto-detected)
- Multiple ports: `<select>` dropdown in preview bar. User's `selectedPort` tracked in `App.tsx`. Resets if selected port disappears. Iframe `key` includes port to force reload on switch.

## Toolbar navigation (back / refresh)

The iframe is cross-origin (preview subdomain), so the toolbar cannot touch its
`history` or `location` directly. It posts `{source: "shipit-toolbar", type}`
messages that the script injected by `preview-proxy.ts` (`HMR_WS_PATCH`) acts on
inside the page: `back` / `forward` → `navigation.back()` / `navigation.forward()`,
`reload` → `location.reload()`.

**Back/forward go through the Navigation API, never `history.back()`.** A frame's
history entries are nested inside the top-level page's, and `history.back()`
traverses that *joint* session history — so a preview with no entry of its own
walks the **ShipIt tab** back, dropping the user out of their session. There is no
guard available on the legacy API: an iframe's `history.length` reports the joint
length (measured in Chromium: one own entry, `length` 9), so it can't distinguish
"the preview has somewhere to go" from "the app does". `navigation.entries()` is
scoped to the frame, so `canGoBack` answers the right question and
`navigation.back()` cannot move anything but the preview. The script checks
`canGoBack` first and swallows both result promises, since the call still rejects
with `InvalidStateError` if the entry list moves in between.

**There is deliberately no `history.back()` fallback.** A browser without the
Navigation API offers no way to ask whether *this frame* can go back, so falling
back to `history.back()` would just reinstate the bug for those users. The script
instead refuses to traverse and reports `canGoBack: false`, so the button is
visibly disabled rather than silently inert. All three engines ship the API
(Chrome 102, Safari 18.2, Firefox 147), so this costs a button essentially nobody
has.

**The same containment covers the previewed page's own traversal, not just the
toolbar's.** The guard above is reached only by a `shipit-toolbar` message, so an
app that calls `history.back()` itself — a "< Back" control, a router's
`goBack()`, a `javascript:history.back()` link — still walked the ShipIt tab back
and switched the user's active session. The script therefore *replaces*
`back` / `forward` / `go` with the frame-scoped traversal, and it is first in
`<head>`, so it wins over app code that captures them later. Measured in
Chromium: an unpatched cross-origin frame's `history.back()` navigates the
*top-level* page, the patched one leaves it untouched and still goes back within
the frame.

Four details, each with a reason:

- **The patch goes on `History.prototype`, not on the `history` instance.** An
  own property leaves `History.prototype.back.call(history)` as a live route to
  the joint traversal, and it *shadows* — rather than composes with — a router or
  instrumentation library that wraps the prototype method later. Falls back to
  the instance where `History` isn't exposed.
- **`go(delta)` counts the FRAME's entries, deliberately unlike the platform.**
  Native `go` counts steps of the joint history, where a nested frame's
  navigation is also a step — so a native `go(-2)` can land somewhere the app
  never was, and past the frame's first entry it lands on ShipIt. There is no
  `canGoBack`-style predicate for `|delta| > 1`, so `navigation.entries()` is
  both the guard and the counter: an index outside the frame's own list is
  refused. That is also what a router asking for "two of my entries back" means.
  `go(0)` and a missing delta stay a `location.reload()`, as natively, and a
  reload never leaves the frame. The delta goes through `|0`, which is exactly
  the Web IDL `long` conversion (`go(4294967295)` is `go(-1)`).
- **`history.length` reports the frame's own entry count** when the Navigation
  API is available. Unpatched it is the *joint* length (Chromium: one own entry,
  `length` 9) — which is why nothing here can use it as a guard, and why the
  `history.length > 1` check an app puts in front of its own back button used to
  say "yes" on the preview's first page and walk straight into a refusal.
- **A refusal says so once, via `console.warn`.** It is otherwise invisible:
  History returns `undefined` and no event fires, so the app's Back button just
  looks broken. It is a bare `console.warn` rather than a posted
  `shipit-preview` console message precisely so it reaches devtools without
  becoming an app error or waking auto-fix.

**The injected script is ASCII-only**, pinned by a test. It is spliced into
whatever the app serves, and a document with no declared charset renders UTF-8
characters in it as mojibake.

**Known limits of the containment.** It reaches the documents ShipIt instruments
— proxied `text/html` `GET` responses. A nested `srcdoc`/third-party iframe
*inside* the preview, or a document the proxy did not rewrite, keeps the native
methods and can still traverse the tab. Separately, history is not the only way
out: container previews render without a `sandbox` attribute (non-container ones
get one at `PreviewFrame.tsx`), so `target="_top"`, `top.location`, and
`window.open(url, "_top")` can still replace the whole ShipIt page with user
activation. Sandboxing container previews would close that, at the cost of
changing behaviour for every previewed app (downloads, popups, top-level OAuth
redirects) — not attempted here; tracked as planning#368.

The script reports `canGoBack` on every `path` message, and `PreviewFrame` keeps
it per slot — the pool leaves other sessions' iframes mounted and reporting, so a
single shared value would let a background preview at its own base grey out Back
for the preview on screen. The value is untrusted page-authored input like the
path beside it: a non-boolean is ignored, leaving the slot "unknown" and Back
enabled. Unknown is the right default there, because it is also the state of a
**non-proxied local preview** whose page never ran our script at all — clicking
Back posts a message nobody receives, which is inert but not a leak.

`rp` fires on `pushState` / `replaceState` (wrapped), `popstate`, `hashchange`,
**and `navigation`'s `currententrychange`**. That last one is not redundant: an
app that drives the Navigation API directly (`navigation.navigate()`, or a router
in navigation-API mode) changes the current entry without touching the History
methods we wrapped, so both the path display and `canGoBack` would otherwise
freeze at their load-time values.

**Refresh reloads the page the preview is currently on, not the slot's entry
URL.** Re-assigning the iframe's `src` — the obvious implementation, and what
this used to do — navigates back to the URL the pool slot was created with, so a
user who had clicked into a sub-page or an SPA route was silently dropped on the
front page. `PreviewFrame` therefore sends `reload` to any slot it has heard a
`loaded` message from (proof the injected script is running there), and only
falls back to the `src` re-assignment when it hasn't: a non-proxied local
preview, a 502, or an auth-gated response. That fallback is also what the
auth-blocked retry escalation needs, since a genuinely blocked slot must
re-fetch rather than reload a page that never rendered.

The "reloadable" bit is keyed by slot *and* stored as the reporting
`contentWindow`, so a remounted iframe (new element, script not yet run) doesn't
inherit the previous element's confirmation.

## Error capture & auto-debug

### Error capture flow

1. Vite plugin (`vite-error-plugin.ts`) injects script intercepting `window.onerror`, `unhandledrejection`, `console.error/warn`
2. Errors sent to parent frame via `postMessage` with `source: "shipit-preview"`
3. `usePreviewErrors` hook deduplicates (1s window), maintains rolling buffer (50 max)
4. Errors forwarded to server via `preview_error` WS message → terminal log with `source: "preview"`

### Auto-fix mode

- Opt-in toggle in preview header
- New errors auto-trigger "fix these errors" message to Claude (when idle)
- Safety: max 3 retries for same error signature, 5s cooldown between attempts, any manual user message disables auto-fix

### Error panel

Red badge on preview shows error count. Clicking opens collapsible panel with details, stack traces, per-error "Fix" buttons, and "Send to Claude" for all errors.

## Renderer isolation

### The iframe lifecycle, and why it is not the problem

Preview iframes for sessions the user is **not** looking at stay mounted. That
is deliberate and load-bearing: `useIframePool` retains one iframe per
`(session, port)` slot, LRU eviction past `MAX_IFRAME_SLOTS = 20` is the *only*
thing that drops one, and a dropped iframe is a reload the user experiences as
their preview resetting — scroll position, SPA route, form state, and the HMR
connection all go. A hidden slot is given Tailwind's `hidden`
(`display: none`) and is told `{ type: "visibility", visible: false }` over
postMessage, the cooperative contract in `docs/146-preview-visibility-contract`.

What `display: none` does **not** do is release the document's WebGL contexts.
Measured, not assumed: with four same-site child origins holding five contexts
each and three of the four rendered `display: none`, all twenty contexts stayed
charged against the process and four were force-lost anyway.

### The problem: one renderer for every open session

Preview origins are `{sessionId}--{port}.<host>` — subdomains of the one
registrable domain ShipIt itself is served from. A browser's process model keys
on **site**, not origin, so by default every open session's preview *and*
ShipIt's own UI share a single renderer process. That has two consequences:

1. **WebGL context exhaustion.** Blink's cap is 16 live contexts per *renderer
   process*, and past it the **oldest** are force-lost. So the preview that goes
   blank is typically the one the user has had open longest — broken by sessions
   they are not looking at. A production trace showed four preview origins in
   one renderer (pid 20524) and three `webglcontextlost` events in 4.6 s.
2. **Main-thread contention.** A heavy preview competes with ShipIt's own UI and
   with every other session's preview on one thread.

### The fix

`preview-proxy.ts` sets **`Origin-Agent-Cluster: ?1`** on every preview
response (`withOriginIsolation`). It requests an origin-keyed agent cluster,
which Chrome implements as origin-level *process* isolation — each preview
origin gets its own renderer, its own main thread, and its own 16-context
budget. It is a request rather than a promise: a browser may decline a
dedicated process under memory pressure, and one without origin-keyed process
isolation ignores it. The subdomain scheme is untouched
(`docs/175-preview-subdomain-only`), and no iframe lifecycle changes:
background slots stay mounted exactly as before.

**Whatever the upstream sent is replaced**, and every case variant is dropped
first so the field can't be emitted twice (a duplicate or list value is a
structured-header parse failure, which reads as *no* isolation request at all).
Respecting an app's own `Origin-Agent-Cluster` was considered and rejected: one
`?0` from an arbitrary dev server re-collapses every open session into one
renderer, and the resulting blank canvas appears in a *different* session from
the app that caused it, so this cannot be a per-app choice. The case for
respecting it — a security-headers middleware defaulting to `?0` — turns out
not to exist; Helmet and Hono's `secure-headers` both default to `?1`. The
override costs legacy `document.domain` relaxation (already off by default in
current Chrome) and same-site *cross-origin* `SharedArrayBuffer` /
`WebAssembly.Module` transfer between two different preview origins. Same-origin
frames are unaffected, which is every ordinary preview.

Three details that are easy to get wrong, all recorded in the
`withOriginIsolation` docstring:

- The header must be on **every document response for the origin, including the
  connecting page** (`docs/286-preview-connect-without-gate`). An origin's
  agent-cluster key is fixed by its first document and held for the whole
  browsing-context group, and a preview opened before its dev server is
  listening gets the connecting page first. Measured, not assumed: with the
  header on the app page but *not* on the connecting page that preceded it,
  four origins that each reloaded into a marked page still ended up in **zero**
  extra renderers — the reload buys nothing, because the key was already fixed.
  With the header on both, the same four origins got four renderers.
- **`window.originAgentCluster` does not test it.** Chrome makes documents
  origin-keyed *logically* by default, so it reads `true` with or without the
  header. Only counting renderer processes distinguishes the two.
- It needs a **potentially-trustworthy origin**. HTTPS and `*.localhost`
  qualify, so production and local development get isolation. The Tailscale
  sslip override (`docs/216`, `docs/254-local-bind-and-tailnet-access`) serves
  previews over plain http, where the header is ignored and behaviour is
  unchanged.

### Measurement

Reproduced in headless Chromium against a probe server: one parent document
embedding N iframes on `https://{a,b,c,d}.example.com`, resolved with
`--host-resolver-rules=MAP * 127.0.0.1`, five WebGL contexts per child.
Renderer processes counted from `ps` on `--type=renderer`; memory as summed
PSS, not RSS, so pages shared between processes are not counted once each.

| 4 origins × 5 contexts | renderer processes | `webglcontextlost` | oldest origin's live contexts |
|---|---|---|---|
| Without the header | 1 (all co-located) | **4** | 1 of 5 |
| With `Origin-Agent-Cluster: ?1` | 4 (one each) | **0** | 5 of 5 |

Both numbers that define the bug move, and the instrument demonstrably produces
a positive as well as a negative (`docs/265`).

Cost of splitting, measured separately with **zero** WebGL contexts so it is
process overhead alone and not the memory of contexts that are no longer
force-lost, with PIDs scoped to the launched browser by its throwaway
`--user-data-dir`, three runs per arm (spread ≤1 MiB): 8 previews go from
**157 MiB to 246 MiB summed PSS — ≈11 MiB per preview origin**.

### Is `MAX_IFRAME_SLOTS = 20` still right?

Asked because each retained slot can now cost a renderer process, where before
it cost a document in a process that already existed. **Assessed, and the answer
is yes — 20 stays.** Note the cap counts `(session, port)` pairs, not sessions,
so a three-service stack consumes three slots and the ceiling is more reachable
than "20 sessions" suggests.

1. **The cap was never implicated.** The production trace that motivated the
   isolation work had four live origins against a cap of 20. Lowering it would
   not have prevented a single `webglcontextlost` event in that trace.
2. **The one mechanism that could make 20 actively dangerous does not bite.**
   If a browser refused dedicated processes past its own renderer limit, a large
   pool would silently undo the isolation. Measured 4 → 20 origins: Chrome grants
   every one its own renderer, linearly, no reuse. And the instrument is not
   blind to reuse — forcing `--renderer-process-limit=3` with 8 origins does
   produce sharing (7 processes, not 8), so a zero here is a real zero. Even at
   that absurd limit, `webglcontextlost` stayed **0**: the degradation is
   graceful, not a cliff.
3. **The saving is small and only in the worst case.** A completely full pool
   costs ~230 MiB of renderer overhead above baseline (slope 11.4 MiB/origin
   over the 4 → 20 sweep). Halving the cap saves ~115 MiB *only* when the pool
   is full, and nothing at all in the ordinary case where it never fills.
4. **The cost of lowering it is certain, not conditional.** Eviction is a
   preview reset — scroll position, SPA route, form state, and the HMR
   connection — paid every time the user cycles through more `(session, port)`
   pairs than the cap. That is the regression the pool docstring exists to
   prevent, traded for memory the user is not short of.

**The finding worth acting on is a different one.** `dropSlot` has exactly two
callers — LRU eviction and the planning#394 service-takeover case — so nothing
releases a slot when a *background* session's preview stops or its container is
reclaimed. Those slots hold a renderer process for a document that is already
doomed: `PreviewFrame` reloads a retained slot when the service it was waiting
on comes back (planning#478), precisely so the user does not return to a stale
page. So for a reclaimed session, retention is **provably worthless** — the
document is thrown away on return regardless.

Releasing on liveness would be strictly better than lowering the cap, because it
evicts by *whether retention can still pay off* rather than by recency, and so
never destroys a preview that could have been restored intact. **Implemented —
see "Releasing a stopped session's slots" below.**

### Releasing a stopped session's slots

planning#496. A retained slot earns its renderer process only while the preview
it holds is still being served. Once a session's Compose stack is torn down, the
document is talking to containers that no longer exist and `PreviewFrame`
reloads the slot when the services return (planning#478) rather than showing the
stale page — so the process is held for a document that is already forfeit. The
server now says so and the browser drops the slot.

**Which teardowns count is the whole difficulty, and the obvious answers are
both wrong.** Two were checked at the source and rejected before the third:

- **Runner disposal is not it.** `ContainerSessionRunner.dispose()` says in as
  many words that it does *not* stop worker resources — "the container stays
  alive and a new runner may reconnect to it. Stopping the preview would force a
  full restart on reconnect." A runner going away tells you nothing about the
  preview.
- **`container_destroyed` alone is not it either.** It fires on both teardown
  shapes, including `destroyAgentContainer()` (`preserveChildResources`), which
  exists precisely so a worker refresh does not interrupt the preview stack.
- **And "the container was reclaimed" is not it**, which is where planning#496's
  original framing was wrong. The idle enforcer is *tiered*: **tier 1** stops the
  agent container and keeps the previews running — it tells the user "The preview
  is still running" — and only **tier 2** stops the surviving stacks. The common
  idle reclamation deliberately keeps previews alive, so the prize is smaller
  than that issue assumed, and a listener that fired on tier 1 would destroy
  exactly the preview tier 1 exists to preserve.

So the signal is the narrow one: `container_destroyed` gained a
`previewsStopped` flag, read straight off the same `!preserveChildResources`
condition that gates the Compose sweep so the two cannot drift, and the SSE
event **`session_previews_stopped`** is broadcast from the two places where
previews genuinely stop — a full container teardown, and tier 2's
`services.stop`.

On the client, `notifyPreviewsStopped` → `useReleaseStoppedPreviews` →
`IframePool.dropSessionSlots`, which routes every removal through `dropSlot` so
a slot leaving the pool still has one cleanup path. Two properties are
load-bearing and both are pinned by tests:

- **The active session is never touched.** Its preview dying is already handled
  where the user can see it (the planning#478 waiting overlay), and pulling the
  iframe out from under the user is the failure mode the pool exists to prevent.
  This can only ever reclaim background slots.
- **A miss is benign.** A viewer that misses the event (an SSE interruption)
  keeps the slot until LRU evicts it, which is the behaviour that shipped
  before. That is why this is transition-keyed with no reconciling snapshot,
  unlike docs/285's runner incarnation, where missing the signal strands a
  viewer permanently and the authoritative snapshot is the recovery path.

**Not covered:** a preview stopped some other way — `shipit service stop`, a
service that crashes — while the session is in the background. The pane already
handles that for the *active* session, and extending the announcement to every
service transition would put the pool back in the business of judging liveness
per service rather than per teardown.

### Limits

- **An already-open tab is not repaired.** An origin's agent-cluster key is
  fixed for the life of its browsing-context group, so a session whose preview
  origin was site-keyed before this shipped stays that way. A fresh tab picks up
  the new keying; a reload within the same group may not.
- **A service worker can answer a navigation without reaching the proxy.** A
  cache-first preview serving its own first document from cache commits that
  document with no header, and opts its origin out. Recorded in
  `src/server/shipit-docs/preview.md` so the agent building such an app knows.
- Neither is worth engineering around here: both are narrow, both self-correct
  on a fresh browsing context, and the alternative is an origin-versioning
  scheme that changes preview URLs — which `docs/175-preview-subdomain-only`
  rules out.

## Key files

- `src/server/orchestrator/preview-proxy.ts` — `withOriginIsolation`, applied at every preview response path
- `src/client/hooks/useIframePool.ts` — LRU slot retention; background iframes stay mounted; `dropSessionSlots`
- `src/client/hooks/usePreviewsStopped.ts` — the `session_previews_stopped` channel and the active-session guard
- `src/server/orchestrator/bootstrap-managers.ts` — `announcePreviewsStopped`, wired to the two teardowns that stop previews
- `src/server/port-scanner.ts` — `checkPort`, `scanPorts`, `DEFAULT_SCAN_PORTS`
- `src/server/vite-manager.ts` — Vite lifecycle, wrapper config with error plugin
- `src/server/vite-error-plugin.ts` — Error capture script injection
- `src/server/index.ts` — `runPortScan()`, `getPreviewStatus()`, periodic scan interval
- `src/client/hooks/usePreviewErrors.ts` — Error dedup, buffer
- `src/client/components/PreviewFrame.tsx` — Iframe, port selector, error badge/panel, auto-fix toggle
- `src/client/App.tsx` — Preview state, `selectedPort`, auto-fix effect with guardrails
