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

1. `parseShipitLink` resolves the href to `{ service, path, params, hash }`.
2. The service name is resolved against `preview-store.services`. A name no
   declared service matches → a toast saying so (req 10). A **declared but
   stopped** service is started instead (req 12) — see below.
3. The port becomes the selected port, and the target path is written into
   `previewPaths[sessionId:port]` — the map the iframe pool already reads when
   it creates a slot, so a preview that is not open yet simply *starts* on the
   target page.
4. A live slot is navigated instead, by asking the injected preview script to
   `location.assign(path)`. The iframe is cross-origin, so the parent cannot
   drive it directly; this reuses the existing `shipit-toolbar` command channel
   that already carries `back` / `reload`.
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

A start can fail (a bad compose file, a missing secret). That surfaces where
service failures already surface — `composeError`, the service's own error state
in the drawer — not as a second toast from this feature.

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
| `src/server/orchestrator/preview-proxy.ts` | `navigate` command in the injected script |
| `src/server/shared/agent-interface-sdk/bootstrap.ts` | `window.shipit.links` |
| `src/server/shipit-docs/chat-links.md` | Agent-facing reference |

## Non-goals

- Auto-linkifying bare prose. Both schemes are explicit; there is no pattern to
  guess and no false-positive gate to build.

An earlier draft listed "starting a stopped service on click" here, reasoning
that booting a container exceeds what a link's appearance promises. The
requester overruled it; it is req 12.
