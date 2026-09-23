# Chat links — pointing the user at a place in their app or artifact

You can write a link in chat that, when clicked, opens the Preview or the
Present tab **at a specific place**. It is an ordinary markdown link with a
ShipIt URL scheme — no tool call, and it can sit anywhere prose can. The same
two schemes work inside an artifact you presented; see "Pointers inside a
presented artifact".

```markdown
Two requirements need attention: [REQ-7](shipit-present:/persist/reqs.html#req-7)
and [REQ-9](shipit-present:/persist/reqs.html#req-9).

The failing check is on [the run detail page](shipit-preview://web/runs/1183?highlight=step-4).
```

Reach for these when the user would otherwise have to go find the thing by
hand — a specific item, a specific route, a section of a long artifact.

## The two schemes

### `shipit-preview://<service>/<path>` — a place in a running app

The authority is the **Compose service name** from `docker-compose.yml`, never a
port. ShipIt resolves the port itself, selects the Preview tab and navigates
there. If the service is **stopped, ShipIt starts it first** and opens the
destination once it is up.

```markdown
[the settings page](shipit-preview://web/settings)
[requirement 7](shipit-preview://web/requirements?focus=7#req-7)
[the app](shipit-preview://web)
```

The path, query string and fragment are the URL the page is navigated to, so
**the page can react to a click in its own JavaScript** by reading
`location.search` / `location.hash` and listening for `hashchange`. That is the
whole mechanism — standard web APIs, and ShipIt adds no API of its own. When you
build a page that should highlight or filter in response to a pointer, have it
read its own URL.

**A pointer at a place inside the page the user is already on does not reload
it.** When the destination is on the **same path**, ShipIt navigates within the
page: the fragment changes in place, and a changed query string is written with
`history.pushState` followed by a `popstate` event. No request, no blink, no
in-page state lost. This assumes your page routes on the History API — which any
page that reacts to its own URL should — because a page that reads
`location.search` only once at load will keep showing its old content under the
new URL. A destination on a **different path** is a real navigation and loads a
new document, exactly as typing it would.

One consequence worth knowing: clicking the *same* pointer twice is a no-op —
the page is already at that URL, so ShipIt does not navigate (reloading would
throw away whatever state the app holds) and the page sees no second event. A
page that must respond to every click should key off something that varies.

#### Embedding a service instead of linking to it

The same address works as an **`<iframe src>`**. The service then renders *inside*
the page rather than taking the reader to it — a style guide holding a live
component, a requirements sheet holding the viewer that produced its images.

```html
<iframe src="shipit-preview://assetgen/embed.html?id=char%2Fminer%231&angle=front"></iframe>
```

This works in **a page one of the project's own Compose services serves** — the
app in the Preview. It is not available inside a presented artifact: an artifact
is rendered in a sandboxed frame, and anything framed inside one inherits that
sandbox, so it would lose its origin, its storage, and `fetch` to its own server.

- **Only the service name.** ShipIt resolves the port and the origin. A
  hard-coded `host:port` is an address the user's browser usually cannot open,
  and it changes per session.
- **Static markup and dynamic elements are the same.** ShipIt resolves `src` in
  the live DOM, so an iframe your framework creates later is resolved exactly as
  a literal tag is. You need no JavaScript of your own.
- **A stopped service is started** the first time the embed is scrolled into
  view, and the frame shows ShipIt's connecting page until it answers. Nothing
  starts while the Preview is behind another tab.
- **An unknown service name is left unresolved** and explained in the page's own
  console. Nothing is toasted — the embed had no click behind it.
- **The embedded page is an ordinary cross-origin document**: its own origin, its
  own storage, `fetch` to its own server. If your app sends `X-Frame-Options` or
  a CSP with `frame-ancestors`/`frame-src`, it refuses to be framed; ShipIt does
  not rewrite your headers.
- **`window.shipit` is not available to the embedded page.** Only the top-level
  previewed page can reach the agent, so put an SDK call in the embedder, never
  in the embed.
- `shipit-render` selects how a *pointer* looks and means nothing here.

A chat pointer never targets an embed. It names a service, so ShipIt opens that
service's **own** Preview, replacing what is on screen.

#### A framed document must subscribe to its own address

This is the trap worth stating once, plainly. A pointer at a place inside the
page the Preview is already on does **not** reload it: the fragment changes in
place, and a changed query string is `pushState` plus a `popstate`. So a document
that reads `location.search` once at load keeps showing its old view under the
new address, **silently** — and every address of a single-path viewer is that
case, so the second pointer and every one after it appear dead.

A document built to be framed subscribes:

```js
function render() {
  const params = new URLSearchParams(location.search);
  // …draw the view this address asks for
}
addEventListener("popstate", render);
addEventListener("hashchange", render);
render();
```

To move an embed's address from the embedding page, set the iframe's `src` — that
is a full load — or have your two pages agree on a `postMessage` of your own.

### `shipit-present:<file path>#<fragment>` — a place in a presented artifact

The file path is the one you passed to the `present` tool; the artifact must
already have been presented (a pointer never reads a new file from disk). ShipIt
selects the Present tab, focuses that artifact, and scrolls to the fragment.

Workspace-relative paths and absolute `/workspace/` paths match the same
artifact: `design/plan.md`, `./design/plan.md`, and `/workspace/design/plan.md`
are interchangeable, whichever form you passed to `present`. This match is
limited to the current session. Other absolute paths stay distinct:
`/persist/plan.md` is not `persist/plan.md` inside the workspace.

```markdown
[REQ-7](shipit-present:/persist/requirements.html#req-7)
[the risks section](shipit-present:docs/258-agent-authored-links/plan.md#unopenable-pointers)
```

Fragments work for **rendered HTML** and **markdown** artifacts:

- **HTML** — the fragment is an element `id`. Give the elements you intend to
  point at stable ids when you write the artifact.
- **Markdown** — the fragment matches a **heading**, by this slug: take the
  heading's text, lowercase it, drop everything that is not a letter, digit,
  space or hyphen, turn runs of whitespace into single hyphens, and trim
  hyphens from the ends. So `## Open questions?` is `#open-questions`.
  **Duplicate headings resolve to the first one** — there are no `-1`/`-2`
  suffixes.

Pointing at the *same* place twice in a rendered HTML artifact does nothing the
second time, for the same reason: re-scrolling would mean rebuilding the
document and discarding any state its own scripts hold. A different fragment
always works.

A presented artifact **cannot react in JavaScript** to a click; it is scrolled,
nothing more. If you need a page that reacts, build it as a Compose service and
point at it with `shipit-preview://`. SVG and image artifacts are focused but
have no place inside them to address.

## Pointers inside a presented artifact

Both schemes also work **from inside an artifact you presented** — write an
ordinary `<a href="…">` in the HTML, or a markdown link in the `.md`, and a click
opens the destination exactly as a pointer in chat does, starting a stopped
service and toasting an unopenable one just the same.

```html
<a href="shipit-preview://web/runs/1183?highlight=step-4">open run 1183</a>
```

This is what makes an artifact a control surface for the running app: a summary
table whose rows link into the page that produced them, a requirements doc whose
items open the app at that item. Style the link however the artifact does — it
is the artifact's own element, so `shipit-render` means nothing there and ShipIt
adds no class to it.

Two limits. It works for **rendered HTML and markdown** artifacts, the same two
kinds a fragment addresses; an SVG's own `<a>` is left to the browser. And a
**middle-click does nothing** — ShipIt has no second tab to open a destination
in, so the click is swallowed rather than handed to the OS. A ⌘/Ctrl-click opens
it here like an ordinary one.

## Choosing how the link looks

Add the reserved `shipit-render` parameter to render the pointer as a badge or a
block button instead of an inline link. It defaults to `link`, and ShipIt strips
it before the page sees the URL.

Write it in the query string, before the `#fragment` — that is where a URL puts
a query. Written **after** the fragment it also works: the name is ShipIt's, so
ShipIt reads it and removes it from either position. Everything else in the
fragment is left exactly as you wrote it, so a hash router's own query
(`#/items?focus=7`) reaches the page untouched.

| Value | Looks like | Use for |
|---|---|---|
| `link` (default) | prose link | a pointer inside a sentence |
| `badge` | small inline pill | an identifier — `REQ-7`, `run 1183` |
| `button` | block-level button | the one action you want them to take |

```markdown
[Open the failing requirement](shipit-present:/persist/reqs.html?shipit-render=button#req-7)
```

## When a link can't be opened

A pointer always stays clickable. If ShipIt can tell the destination is
unreachable — no service by that name, no artifact presented from that path, a
service that failed to start, a fragment matching no heading — clicking shows a
toast saying which thing was missing. Not every failure is detectable: a path
that loads your app's own "not found" page looks exactly like one that worked.
So point at destinations you know exist.

Both schemes are live **only in your own chat messages and in artifacts you
presented**. They are inert in PR descriptions, issue bodies, comments, review
text and repository files opened in the file viewer — all content ShipIt renders
but did not author.
