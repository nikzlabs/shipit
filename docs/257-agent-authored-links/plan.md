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
  session's *declared* services and finds the port itself; whether that service
  happens to be running is a separate question (req 12).
- **`shipit-present:<file path>`** — the file path is already the artifact's
  identity in the Present carousel, so it needs no new identifier.

Both accept a query string and a fragment, and those two carry the payload:

- The **fragment** names the place inside the destination (req 9).
- The **query params + fragment** are delivered to the destination page as a
  `link` event on `window.shipit`, wherever page JavaScript exists (req 11).

Both are optional. A pointer with neither addresses the destination as a whole,
which req 5 explicitly permits.

That is the whole syntax. No new tool, no new card, no new persisted message
type — a pointer is text in an existing assistant message, so it survives
history reload for free.

### Why the payload rides the URL

Req 9 and req 11 could each have grown their own mechanism — a fragment for
scrolling, a separate structured payload for page JS. They collapse into one:
the parsed URL *is* the payload. A page that only wants the anchor uses the
fragment; a page that wants to react uses the same parsed values through the
SDK. One thing for the agent to author, one thing to document.

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

## Flow

### Resolve first, then reveal

The click resolves the destination **before** touching the user's panel, and
reveals only once there is something actionable to show. Revealing first would
mean a malformed pointer or a missing artifact replaces whatever the user was
looking at and *then* apologises with a toast.

Revealing means: select the right tab, flip the mobile layout to the workspace
column, close the mobile sidebar. `PresentToolChip` already performs exactly
that three-call sequence (`message-tools.tsx:436`); this extracts a
`revealWorkspaceTab(tab)` helper both use rather than duplicating three store
calls.

The two panels differ in a way that matters for delivery timing: `PreviewFrame`
is **always mounted** and merely hidden via CSS (`App.tsx:1665`), while
`PresentPane` is **conditionally mounted** (`App.tsx:1819`) — it does not exist
until its tab is selected. So a Present pointer must reveal before it can expect
any frame or DOM to deliver into.

A stopped-but-valid service is actionable, so it reveals *before* the start is
sent — that is how the user sees the service booting instead of a blank pause.

### Preview (req 2)

1. `parseShipitLink` resolves the href to `{ service, path, params, hash }`.
2. The service name is matched exactly against `preview-store.services`. No
   declared service by that name, or one with no declared port → req 10 toast.
3. The click records an **intent** (below) and selects the port.
4. A live slot is navigated by **assigning the iframe's `src`** to the resolved
   destination URL.
5. A service that is not running is started first (req 12), below.

There is no delivery step. The page's reaction (req 11) is the URL it is now
at — `location.search`, `location.hash`, `hashchange` — so navigating *is* the
delivery. This is why the Preview needs nothing from the Agent Interface SDK.

#### The intent, and why it is not `previewPaths`

An earlier draft wrote the destination straight into
`previewPaths[sessionId:port]`, reusing the map the iframe pool reads when it
creates a slot. That map is the wrong home: it means *"the last path this page
reported about itself"*, and a live page writes to it at any time through the
injected `path` message (`PreviewFrame.tsx:295`). A document still on screen
during a pending start or navigation can therefore overwrite the destination
before it is ever used — the queued destination and the observed location are
two different facts and must not share a slot.

So a click records:

```ts
{ sessionId, slotKey, service, targetPath, payload, clickId, phase }
```

- **`sessionId`** — the intent is cancelled on a session switch. It describes a
  destination in one session and means nothing in another.
- **`clickId`** — every click gets a fresh one, and **last click wins**. Two
  rapid pointers, especially to different services, resolve to the most recent;
  an earlier intent that has not completed is dropped, not queued.
- **`phase`** — `starting` | `navigating` | `delivering`, so a click arriving
  during a boot can wait rather than re-sending a start.
- Re-clicking the *same* pointer is a new intent with a new `clickId`, and
  delivers the SDK event again. Clicks are not coalesced: clicking "requirement
  7" twice means the user asked twice, and a page that highlights on each click
  should highlight again.

The desired path is used when creating the slot; the reported path is committed
to `previewPaths` only after the new document loads, which keeps that map's
existing meaning intact.

**Stale service messages.** `service_list` and `service_status` handlers ignore
their `sessionId` today (`service-list.ts:5`, `service-status.ts:5`), so an
intent must check the session itself rather than trusting that a status belongs
to the session it is waiting on.

**On step 4.** An earlier draft added a `navigate` command to the injected
preview script, on the belief that a parent cannot navigate a cross-origin
iframe. That is wrong: cross-origin blocks *reading* `location` and calling
`history`, not assigning `src`, and `PreviewFrame.tsx:407` already does it. The
command would also have widened an injected listener that checks neither
`event.source` nor origin (`preview-proxy.ts:106`) — a new message type on an
unauthenticated channel, to do something the parent can already do.

### Present (req 3)

1. `parseShipitLink` resolves the href to `{ filePath, params, hash }`.
2. The artifact with that path is focused. No such artifact → req 10 toast
   naming the path.
3. The fragment and payload are delivered — by a different mechanism per
   artifact kind, below.

Focusing has to do more than move the carousel index, because three pane states
can leave a pointer pointing at nothing on screen:

- **The gallery.** `focusById` does not close it today (`present-store.ts:240`),
  and with the grid open there is no rendered artifact at all — no SDK frame, no
  markdown DOM. `focusByPath` closes the gallery.
- **Source view.** `viewMode` is local `PresentPane` state that resets only when
  `activePresentId` changes (`PresentPane.tsx:130`), so re-clicking a pointer to
  the *already-active* artifact would leave it showing source and deliver
  nothing. A pointer addresses a place in the **rendered** artifact, so
  delivering one switches to rendered mode. This is a deliberate choice over
  preserving the user's source view: the pointer's whole meaning is "look at
  this thing", and honouring the view mode would silently drop the request.
- **Content not fetched yet.** Bytes load lazily (`PresentPane.tsx:183`), and a
  pointer commonly *is* what first shows the artifact. Delivery waits for the
  content and the matching DOM/frame; a fetch failure is a req 10 outcome.

### Starting a stopped service (req 12)

**A stopped service already knows its port.** Services are seeded from the
compose file with the port extracted and `status: "stopped"`
(`service-manager.ts:915`), and `service_list` carries that port to the client
verbatim (`compose-attach-replay.ts:56`). The port is a *declared* value, not a
runtime discovery. Every resolution step above therefore works unchanged on a
stopped service: the slot key `sessionId:port` is computable at click time, and
`previewPaths` can be written before anything is running.

So req 12 adds exactly one thing to the flow: when the resolved service's status
is not `running` or `starting`, send `{ type: "start_service", name }`.

`start_service` is a **WebSocket** message and the socket is held by `App`, which
threads `send` down as props (`PreviewServicesDrawer.tsx:526`). A markdown link
click handler is nowhere near it, and a module-level `send` singleton would be a
new global for one call site — so `App`, which already owns both the socket and
the store, sends it off the stored intent.

Status handling is three-way and the middle case matters: `stopped`/`error` →
send `start_service`; `starting` → wait without re-sending (a click arriving
during a boot must not queue a second start); `running` → navigate now.

**The intent must reselect its own port when the target reaches `running`.**
This is the part that does not fall out for free. Starting a service emits a
`preview_status` carrying only the ports currently running
(`container-session-runner.ts:704`), and the client's handler clears
`selectedPort` when the selected one isn't among them
(`preview-status.ts:22`). In a session where service A is already running and
the pointer targets stopped service B, the panel therefore stays on A after B
starts, unless Compose ordering happens to put B first. So the intent watches
for *its* service reaching `running` and selects that port explicitly —
`selectedPort` is a view of the present, never durable pending state.

Guard test: A running, click a pointer to stopped B, B starts, B becomes the
active slot at the authored path.

Once the port is selected the rest follows: the health poller creates the slot,
and the slot URL is built from the intent's `targetPath`. The destination
survives the wait because the click recorded a *destination*, not a navigation
to perform at click time — the same property that makes a not-yet-open preview
work. The user watches it boot on the Preview tab, revealed before the start
was sent.

### Present delivery — two mechanisms, by artifact kind

Only *rendered HTML* runs inside a frame with the SDK (`PresentPane.tsx:80`).
Markdown takes a different path entirely, and that is what makes req 9's
markdown support cheap:

- **Markdown** renders in ShipIt's **own DOM** (`MarkdownReviewView` →
  `MarkdownSelectionComments`), not in an iframe. So the pane scrolls to the
  fragment itself: query a Present-only container ref for `h1`–`h6`, slug each
  heading's text, scroll the match into view. No SDK, no postMessage, no
  handshake timing. Req 11 does not apply — a markdown artifact has no scripts.

  No ref is exposed through that stack today, so this adds one — a dedicated
  Present container ref, not a reach into `MarkdownSelectionComments`' internals.

  **The slug algorithm is a contract, not an implementation detail**, because the
  agent has to author fragments that match it. One tested function: take the
  heading's rendered `textContent` (so inline code and emphasis contribute their
  text), lowercase, strip anything that is not alphanumeric/space/hyphen,
  collapse whitespace runs to single hyphens, trim leading and trailing hyphens.
  No de-duplication suffixes — **duplicate headings resolve to the first match**,
  which is stated in the agent-facing docs rather than left to be discovered.
  The fragment is percent-decoded before matching. No match is a req 10 outcome,
  never a silent success.

  This deliberately does **not** add `id` attributes in the markdown renderer.
  That renderer is shared with chat, PR bodies and docs, so slugging headings
  there would change every markdown surface in the app to serve one pane. Text
  matching at click time is confined to the Present pane and needs no new
  dependency (`rehype-slug` would be one, and the dependency policy makes that a
  deliberate act rather than a convenience).

- **Rendered HTML** gets a **scroll script injected into the `srcDoc`**, the way
  the CSP meta already is (`RenderedFrame.tsx:56`). The artifact is mounted from
  `srcDoc` with `sandbox="allow-scripts"` and no `allow-same-origin`
  (`RenderedFrame.tsx:88`), so its document URL is `about:srcdoc` on an opaque
  origin: there is no `location.hash` to set and no fragment the parent can
  navigate it to. With no API (req 11) there is also no channel to send one
  over — so the fragment is baked in when the frame is built:

  ```html
  <script>addEventListener("DOMContentLoaded",function(){
    var el=document.getElementById(FRAGMENT); if(el)el.scrollIntoView();
  })</script>
  ```

  The fragment is JSON-encoded into that string, never concatenated raw. A
  changed fragment re-renders the `srcDoc`, which remounts the frame — acceptable
  because a pointer click is a deliberate "show me this", and it keeps the whole
  mechanism to one injected script with no message passing, no handshake, and no
  public surface.

- **Everything else** — SVG, images — is focused and nothing more. There is no
  place inside an image to address. This is a design consequence of req 9
  naming HTML and markdown, not a requirement of its own: the human answered
  "also markdown", and nobody asked what an anchor into a PNG would mean.

## No SDK changes

An earlier design added `window.shipit.links` — a subscribe/replay channel
delivering `{ params, hash }` to both surfaces. It is **cut entirely**; the Agent
Interface SDK is untouched by this feature.

The reasoning that removed it is worth keeping, because it is what makes the
rest small. The Preview never needed it: a pointer navigates the page to the
authored URL, so `location` already carries the payload, and a page reacting to
`hashchange` is using the platform rather than a ShipIt API. That left presented
HTML as the channel's only justification — and the requester judged that a
single presented page reacting in script is the wrong shape for the capability
anyway ("that should be in a more permanent preview service").

What went with it: the deliver-on-handshake machinery in the Preview flow, the
replay semantics, the opaque-origin `postMessage` delivery and its
confidentiality caveat, a public API surface to document and never break, and
the `bootstrap.ts` changes. What survives is one injected scroll script.

The cost is stated in `requirements.md`: a repeat click on an identical pointer
changes no URL and therefore produces no event, and presented artifacts cannot
react in script at all.

**The scroll cannot fire on receipt**, though. The SDK is injected into `<head>`
(`RenderedFrame.tsx:56`), so for a Present artifact — where the click is what
mounts the frame — the link can arrive before the document has parsed and
`getElementById` returns null. The promised no-JavaScript anchor would silently
do nothing, which is the whole point for a page with no script. So the SDK
retains the hash and scrolls on `DOMContentLoaded`, attempting immediately only
when `readyState` is already past loading. Both orderings need a test; the early
one is the default case.

## Unopenable pointers (req 10)

> **Open question.** Req 10 says "for any reason", and ShipIt cannot honour that
> literally — see `requirements.md`. The table below is the set of failures
> ShipIt can determine locally; it is the proposal pending that answer, not a
> settled design.

A pointer always renders and always accepts a click; one that cannot be opened
explains itself in a toast (`ui-store.setToast`, `variant: "error"`) rather than
silently doing nothing:

| Cause | What the toast names |
|---|---|
| Malformed pointer (fails the parser's gate) | that the address is not valid |
| No declared service by that name | the service name |
| Declared service with no port to preview | the service name |
| `start_service` refused — `send()` returned false on a closed socket (`useWebSocket.ts:151`) | that the session is not connected |
| The service reached `error` after a start | the service name |
| No artifact presented from that path | the path |
| The artifact's content fetch failed | the path |
| Fragment matched no element / no markdown heading | the fragment |
| No preview URL can be built for this host (raw-IP host, `usePreviewHealthPoller.ts:43`) | that previews need a wildcard host |

Each names the missing thing, because "couldn't open that" gives the user
nothing to act on. A *stopped* service is not a failure — it is req 12.

**What this cannot cover, deliberately.** A route that loads and shows the app's
own "not found" screen is indistinguishable from a route that opened correctly;
so is a service that stays `starting` forever, or a `send()` that returns true
and is lost before the server receives it. Detecting those needs a correlated
request/result protocol, SDK acknowledgements and proxy correlation — a
subsystem, built to preserve a phrase. The open question above is whether to
narrow req 10 instead.

A server-side start failure currently comes back as a generic WS error that
renders as a transcript error bubble (`service-handlers.ts:26`, `error.ts:5`);
the intent notices its service reaching `error` and raises the toast. The
services drawer keeps showing what it always showed — this adds the toast the
click promised, it does not move compose diagnostics.

This is deliberately *unlike* `IssueBadge`, which degrades to plain text. That
gate exists because issue references are pattern-matched out of ordinary prose
and may not be references at all. Here the agent wrote the pointer on purpose,
so hiding it would misreport the agent's intent as a rendering decision.

## Where the schemes are live — an opt-in renderer capability

**The schemes must not be enabled globally.** `MarkdownContent` and its
`urlTransform` are shared far beyond assistant chat: PR descriptions and
comments, issue descriptions and comments, plan approvals, reviews, subagent
reports (`message-markdown.tsx:293`, `IssueDetail.tsx:342`,
`PrConversationSection.tsx:46`). Every one of those renders text ShipIt did not
author — a PR comment from a stranger, an issue description, a README quoted
into a review. Enabling the schemes there would let repository- or
tracker-authored markdown present a button that **starts a Compose service**
when clicked (req 12), which is exactly the untrusted-input boundary ShipIt
treats as sacred: ingested content is data, not instructions.

So ShipIt links are an explicit **renderer capability, default off**, switched on
only where the text is agent-authored — assistant chat messages
(`MessageList.tsx:316`). Everywhere else the href falls through to the existing
branches and renders as it does today.

Mechanically this means a second pair of module-level constants — a components
map and a `urlTransform` with the schemes enabled — selected by prop. Both must
stay **module-level**, because `MarkdownContent` is memoised on `text` alone on
the premise that its plugins and components are stable module constants
(`message-markdown.tsx:363`); building either per render would silently reinstate
the O(messages × tokens) re-parse that memo exists to prevent.

This is the one finding of the review that is a genuine security hole rather
than a gap, and it was invisible from the requirements: "the agent can write a
link" says nothing about who else renders markdown through the same component.

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
- A preview path begins with **exactly one** `/`. Backslashes and tab/CR/LF are
  rejected *before* URL resolution, not after: WHATWG parsing folds `\` into `/`
  and strips tab/CR/LF anywhere in the input, so `/\evil.example/x` resolves to
  a foreign host while passing a naive "starts with one slash" test. This is the
  same trap `sanitizePreviewPath` documents (`preview-store.ts:296`).
- **The service authority is read from the raw href, not `URL.hostname`**, which
  lowercases and canonicalises — that would quietly conflict with "exact
  declared service name" for any service whose compose name has uppercase.
  Matched exactly against the declared list; no prefix or fuzzy matching.
- A Present path is percent-decoded once and compared to the artifact's verbatim
  `filePath` (modulo a leading `./`). Matching only ever selects an
  **already-presented** entry; a pointer never causes a read of an arbitrary
  path from disk.
- Repeated query keys are **last-wins**, matching `URLSearchParams` iteration, so
  the parse has no case the agent can author that behaves unpredictably. A
  repeated `shipit-render` is a malformed pointer rather than last-wins, since
  it is ShipIt's own parameter and ambiguity there is a bug in the author.
- `hash` is stored **without** its leading `#` and percent-decoded once before
  `getElementById` / heading matching.
- The same validated string is what gets stored and what gets navigated to.
  Validating one and using the other is how these bugs happen.
- `shipit-render` is allowlisted to `link|badge|button` and stripped from **both**
  the SDK payload and the navigation URL. Stripping only the payload would still
  leave it visible to the page through `location.search`, contradicting the
  claim that a page never sees ShipIt's presentation knob.
- The fragment is JSON-encoded into the injected scroll script, never
  concatenated into it. That script is the only place a pointer's data enters a
  document ShipIt assembles.

**No cross-frame message carries pointer data.** Cutting the SDK channel removed
the whole outbound-delivery question with it: nothing is posted into the preview
frame, and nothing is posted into an opaque-origin artifact frame. The existing
inbound checks (`event.source`, the SDK's locked `parentOrigin`) are untouched
and unrelied-upon by this feature.

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
| `src/client/utils/open-shipit-link.ts` | The click action: reveal, resolve, navigate/focus, toast |
| `src/client/components/message-markdown.tsx` | The opt-in renderer capability: scheme-enabled components + `urlTransform`, the `MarkdownLink` branch, its three forms |
| `src/client/components/MessageList/MessageList.tsx` | Turns the capability on for assistant messages — and nowhere else |
| `src/client/stores/preview-store.ts` | The navigation intent (session, slot, service, path, payload, clickId, phase) |
| `src/client/App.tsx` | Sends `start_service` for an intent whose service is stopped (req 12) |
| `src/client/stores/present-store.ts` | `focusByPath`, `pendingLink` |
| `src/client/components/PreviewFrame/PreviewFrame.tsx` | Navigate the live slot |
| `src/client/components/PresentPane.tsx` | Scroll a markdown artifact; pass the fragment to the rendered frame |
| `src/client/components/FileContentView/RenderedFrame.tsx` | Inject the scroll script into an HTML artifact's `srcDoc` |
| `src/server/shipit-docs/chat-links.md` | Agent-facing reference |

## Non-goals

- Auto-linkifying bare prose. Both schemes are explicit; there is no pattern to
  guess and no false-positive gate to build.
- A `navigate` command in the injected preview script. Assigning the iframe
  `src` does the same job with no new message type on an unauthenticated
  channel.
- Addressing a place inside SVG, image or source-view artifacts (req 9).
