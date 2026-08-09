---
issue: planning#334
title: Agent-authored links into the Preview and the Present tab
description: A markdown link the agent writes that opens a place in the user's own app or presented artifact, and tells that page about the click.
---

# Agent-authored links — design

Implements [`requirements.md`](./requirements.md). Requirements are cited as
`(req N)`.

## The gap

An app the user built can already talk *to* the agent: the Agent Interface SDK
(docs/242) injects `window.shipit` into the active Preview page and the active
rendered Present artifact, and page JavaScript sends a composed instruction back.
The return direction has no affordance at all. The agent can say "requirement 7
needs attention" but cannot make "requirement 7" a thing you click (req 1).

Two link pipelines already exist in chat and neither fits: `remarkLinkifyPaths`
addresses repo files and `remarkLinkifyIssues` addresses tracker issues. Both
point at ShipIt-owned destinations. Nothing points into the user's own app
(req 6).

## Shape

Two URL schemes, written as ordinary markdown links (req 7):


```markdown
[requirement 7](shipit-preview://web/requirements/7?highlight=7)
[REQ-7](shipit-present:/persist/requirements.html?item=7#req-7)
```

- **`shipit-preview://<service>/<path>`** — the authority is the **Compose
  service name**, never a port (req 8). ShipIt resolves the name against the
  running services and finds the port itself.
- **`shipit-present:<file path>`** — the file path is already the artifact's
  identity in the Present carousel, so it needs no new identifier (req 9).

Both accept a query string and a fragment, and those two carry the payload:

- The **fragment** names the place inside the destination (req 9).
- The **query params + fragment** are delivered to the destination page as a
  `link` event on `window.shipit` (req 11).

That is the whole syntax. No new tool, no new card, no new persisted message
type — a pointer is text in an existing assistant message, so it survives
history reload for free.

### Choosing the rendered form (req 1)

One reserved query parameter, `shipit-render=link|badge|button`, defaulting to
`link`:

```markdown
Two need attention: [REQ-7](shipit-present:/persist/reqs.html#req-7) and
[REQ-9](shipit-present:/persist/reqs.html#req-9).

[Open the failing one](shipit-present:/persist/reqs.html?shipit-render=button#req-7)
```

It is stripped before the payload reaches the page, so a page never sees ShipIt's
own presentation knob among its parameters. The `shipit-` prefix is what makes
that strip safe to state as a rule rather than a special case.

Markdown gives no other place to put this. The link *title* is a tooltip and
already used; a scheme variant (`shipit-present+button:`) multiplies the schemes;
and a distinct markdown syntax would not survive the existing remark pipeline.
A reserved parameter costs one line in the parser and reads acceptably in raw
markdown, which is what the agent authors.

**Badge and button are presentation only.** All three forms parse, resolve and
click identically; the form selects a component in `MarkdownLink` and nothing
else. A button renders as a block-level affordance, a badge as an inline pill
matching `IssueBadge`'s line-box discipline (`text-[0.85em]`, `leading-none`, no
vertical padding — a badge must not push prose lines apart), and a link as
ordinary prose link styling.

### Why the payload rides the URL

Req 9 and req 11 could each have grown their own mechanism — a fragment for
scrolling, a separate structured payload for page JS. They collapse into one:
the parsed URL *is* the payload. A page that only wants the anchor uses the
fragment; a page that wants to react uses the same parsed values through the
SDK. One thing for the agent to author, one thing to document.

## Flow

### Preview (req 2)

0. The destination panel is revealed first, for **both** flows: select the right
   tab, flip the mobile layout to the workspace column, close the mobile
   sidebar. Without this the click resolves a destination the user cannot see —
   the Preview renders only when its tab is selected (`App.tsx:1555`), and so
   does Present (`App.tsx:1819`). `PresentToolChip` already does exactly this
   three-call sequence (`message-tools.tsx:436`); this feature reuses it rather
   than inventing a second way to reveal a panel.
1. `parseShipitLink` resolves the href to `{ service, path, params, hash }`.
2. The service name is resolved against `preview-store.services`. A name no
   declared service matches → a toast saying so (req 10). A **declared but
   stopped** service is started instead (req 12) — see below.
3. The port becomes the selected port, and the target path is written into
   `previewPaths[sessionId:port]` — the map the iframe pool already reads when
   it creates a slot, so a preview that is not open yet simply *starts* on the
   target page.
4. A live slot is navigated by **assigning the iframe's `src`** to the resolved
   destination URL. An earlier draft added a `navigate` command to the injected
   preview script, on the belief that a parent cannot navigate a cross-origin
   iframe. That is wrong: cross-origin blocks *reading* `location` and calling
   `history`, not assigning `src`, and `PreviewFrame.tsx:407` already does it.
   The command would also have widened an injected listener that checks neither
   `event.source` nor origin (`preview-proxy.ts:106`) — a new message type on an
   unauthenticated channel, to do something the parent can already do.
5. The link event is delivered to the page (req 11) — immediately when no
   navigation was needed, otherwise on the next SDK handshake from that slot,
   since navigating tears down the old `window.shipit`.

### Present (req 3)

1. `parseShipitLink` resolves the href to `{ filePath, params, hash }`.
2. The carousel is focused on the artifact with that path. No such artifact →
   a toast saying it was never presented (req 10).
3. The link event is delivered to the artifact's sandboxed frame, on its SDK
   handshake if it is still mounting.

### Starting a stopped service (req 12)

**A stopped service already knows its port.** Services are seeded from the
compose file with the port extracted and `status: "stopped"`
(`service-manager.ts:915`), so the port is a *declared* value, not a runtime
discovery. Every resolution step above therefore works unchanged on a stopped
service: the slot key `sessionId:port` is computable at click time, and
`previewPaths` can be written before anything is running.

So req 12 adds exactly one thing to the flow: when the resolved service's status
is not `running` or `starting`, send `{ type: "start_service", name }`.

`start_service` is a **WebSocket** message and the socket is held by `App`, which
threads `send` down as props (`PreviewServicesDrawer.tsx:526`). A markdown link
click handler is nowhere near it, and a module-level `send` singleton would be a
new global for one call site — so `App`, which already owns both the socket and
the store, sends it off the stored intent.

Nothing then needs to wait. The service comes up, `service_status` lands, the
health poller creates the slot, and the slot's URL is built from the path the
click already wrote into `previewPaths`. The destination survives the wait
because the click recorded a *destination*, not a navigation to perform at click
time — the same property that makes step 3 work for a preview that is merely not
open yet. Req 12 needs no second mechanism and no waiting UI: the click switches
to the Preview tab, where the service's own startup state already renders.

Status handling is three-way and the middle case matters: `stopped`/`error` →
send `start_service`; `starting` → wait without re-sending (a click that arrives
during a boot must not queue a second start); `running` → navigate now.

A start that fails is a pointer that could not be opened, so it produces the
req 10 toast like any other failure — *not* only the service's own error state in
the drawer. Two failure paths are easy to miss: `send()` returns `false` when the
socket isn't open (`useWebSocket.ts:151`), and a server-side start failure comes
back as a generic WS error that currently renders as a transcript error bubble
(`service-handlers.ts:26`, `error.ts:5`). The first is a direct return value to
check; the second needs the intent to notice that its service reached `error`.
The drawer keeps showing what it always showed — this adds the toast the click
promised, it does not move compose diagnostics.

### Present rendering

A presented artifact renders from `srcDoc` in an opaque-origin iframe, so the
parent cannot set `location.hash` on it and a fragment in the frame URL would do
nothing. The fragment therefore arrives *as data* and the SDK does the scroll —
which is the same delivery req 11 needs, so the Present side has exactly one
mechanism rather than two.

## The `links` SDK surface

Mirrors `visibility`, which already solves the same late-subscriber problem:

```ts
await window.shipit?.ready;
window.shipit.links.subscribe((link) => {
  // { path, params, hash }
  highlightRequirement(link.params.item);
});
```

- `links.current` holds the last link, `null` before any.
- `subscribe` immediately replays the current link, then fires on each new one,
  and returns an unsubscribe function. The replay is load-bearing, not a
  nicety: clicking a Present link *mounts* the artifact, so the event exists
  before any page script has run.
- Before notifying subscribers the SDK scrolls to `document.getElementById(hash)`
  when one exists, so a plain anchor works with no page code at all (req 9). A
  page that wants different behaviour scrolls where it likes in its own handler.

**The scroll cannot fire on receipt.** The SDK is injected into `<head>`
(`RenderedFrame.tsx:56`) and posts `ready` immediately (`bootstrap.ts:150`), so
for a Present artifact — where the click is what mounts the frame — the link
arrives before the document has parsed and `getElementById` returns null. The
promised no-JavaScript anchor would silently do nothing, which is the whole
feature for a page with no script. So the SDK retains the hash and scrolls on
`DOMContentLoaded`, attempting immediately only when `readyState` is already
past loading. Both orderings need a test; the early one is the default case.

## Unavailable destinations (req 10)

A pointer always renders and always accepts a click; a dead one explains itself
in a toast (`ui-store.setToast`, `variant: "error"`) rather than silently doing
nothing. Two cases reach it — a service name nothing declares, and an artifact
path that was never presented — and both name the thing that was missing, since
"couldn't open that" tells the user nothing they can act on. A *stopped* service
is not one of these cases (req 12). This is
deliberately *unlike* `IssueBadge`, which degrades to plain text — that gate
exists because issue references are pattern-matched out of ordinary prose and
may not be references at all. Here the agent wrote the link on purpose, so
hiding it would misreport the agent's intent as a rendering decision.

## Parsing and the origin contract

The href is agent-authored and becomes both an iframe navigation and data
crossing into a frame, so the parser is a gate, not a formatter:

- **Reject, never repair.** `sanitizePreviewPath` truncates an overlong value
  (`preview-store.ts:296`), which is right for a path a page *reported* about
  itself and wrong for a destination someone authored — a truncated destination
  is a different destination. A pointer that fails any rule is unopenable and
  gets the req 10 toast.
- Exact scheme match; strict length caps; no credentials and no port in the
  preview authority (the authority is a service name — req 8 says a port is
  never part of the address, so one appearing there is a malformed pointer).
- Exact match against a **declared** service name; no prefix or fuzzy matching.
- The same validated string is what gets stored in `previewPaths` and what gets
  navigated to. Validating one and using the other is how these bugs happen.
- `shipit-render` is allowlisted to `link|badge|button`, and it is the only
  parameter stripped before delivery. Anything else is the page's.
- Preview frames get an **exact** `targetOrigin`, as the visibility messages
  already do (`PreviewFrame.tsx:252`). Present frames are opaque-origin, where
  `"*"` is the only expressible target — that stays acceptable only because the
  existing browser-supplied `event.source` check and the SDK's locked
  `parentOrigin` (`bootstrap.ts:56`) are preserved, not loosened.

## Branch order in `MarkdownLink`

The ShipIt-scheme branch must run **before** the repo-file branch
(`message-markdown.tsx:187`): `shipit-present:/persist/x.html` has no `://`, so
`parseRepoFileLink` would happily read it as a repo path and open a file preview
(`repo-file-link.ts:38`). Same class of collision as the tracker-URL branch,
which is ordered ahead of repo files for exactly this reason.

All three rendered forms follow the repo-file branch's pattern of carrying **no
real `href`**. A custom-protocol href would put `shipit-present:...` in the
status bar on hover and hand it to the OS protocol handler on middle-click or
"open in new tab". The click handler is the whole behaviour; `role="button"` and
`tabIndex` restore the keyboard affordance.

## Key files

| File | Role |
|---|---|
| `src/client/utils/shipit-link.ts` | Scheme constants + `parseShipitLink` |
| `src/client/utils/open-shipit-link.ts` | The click action: resolve, focus, navigate, deliver |
| `src/client/components/message-markdown.tsx` | `urlTransform` passthrough + the `MarkdownLink` branch |
| `src/client/stores/preview-store.ts` | `pendingNavigation` handoff to the iframe pool + `App` |
| `src/client/App.tsx` | Sends `start_service` for an intent naming a stopped service (req 12) |
| `src/client/stores/present-store.ts` | `focusByPath`, `pendingLink` |
| `src/client/components/PreviewFrame/PreviewFrame.tsx` | Navigate the live slot, deliver on handshake |
| `src/client/components/PresentPane.tsx` | Deliver to the artifact frame |
| `src/server/shared/agent-interface-sdk/bootstrap.ts` | `window.shipit.links` |
| `src/server/shipit-docs/chat-links.md` | Agent-facing reference |

## Non-goals

- Auto-linkifying bare prose. Both schemes are explicit; there is no pattern to
  guess and no false-positive gate to build.

- A `navigate` command in the injected preview script. Assigning the iframe
  `src` does the same job with no new message type on an unauthenticated
  channel.

An earlier draft listed "starting a stopped service on click" here, reasoning
that booting a container exceeds what a link's appearance promises. The
requester overruled it; it is req 12.
