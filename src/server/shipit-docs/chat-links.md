# Chat links — pointing the user at a place in their app or artifact

You can write a link in chat that, when clicked, opens the Preview or the
Present tab **at a specific place**. It is an ordinary markdown link with a
ShipIt URL scheme — no tool call, and it can sit anywhere prose can.

```markdown
Two requirements need attention: [REQ-7](shipit-present:/persist/reqs.html#req-7)
and [REQ-9](shipit-present:/persist/reqs.html#req-9).

The failing check is on [the run detail page](shipit-preview://web/runs/1183?highlight=step-4).
```

Use these when you are telling the user about something they can *look at* in
their own app or in an artifact you presented. Prose that names an item without
linking it makes them go find it by hand.

## The two schemes

### `shipit-preview://<service>/<path>` — a place in a running app

The authority is the **Compose service name** from `docker-compose.yml`, never a
port. ShipIt resolves the port itself, selects the Preview tab and navigates
there. If the service is **stopped, ShipIt starts it first** and opens the
destination once it is up.

```markdown
[the settings page](shipit-preview://web/settings)
[requirement 7](shipit-preview://web/requirements?focus=7#req-7)
[the app](shipit-preview://web)          <!-- no path: the app as a whole -->
```

The path, query string and fragment are the URL the page is navigated to, so
**the page can react to a click in its own JavaScript** by reading
`location.search` / `location.hash` and listening for `hashchange`. That is the
whole mechanism — standard web APIs, and ShipIt adds no API of its own. When you
build a page that should highlight or filter in response to a pointer, have it
read its own URL.

One consequence worth knowing: clicking the *same* pointer twice changes no URL,
so the page sees no second event. A page that must respond to every click should
key off something that varies (e.g. include a changing parameter).

### `shipit-present:<file path>#<fragment>` — a place in a presented artifact

The file path is the one you passed to the `present` tool; the artifact must
already have been presented (a pointer never reads a new file from disk). ShipIt
selects the Present tab, focuses that artifact, and scrolls to the fragment.

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

A presented artifact **cannot react in JavaScript** to a click; it is scrolled,
nothing more. If you need a page that reacts, build it as a Compose service and
point at it with `shipit-preview://`. SVG and image artifacts are focused but
have no place inside them to address.

## Choosing how the link looks

Add the reserved `shipit-render` parameter to render the pointer as a badge or a
block button instead of an inline link. It defaults to `link`, and ShipIt strips
it before the page sees the URL.

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

Both schemes are live **only in your own chat messages**. They are inert in PR
descriptions, issue bodies, comments and review text, which ShipIt renders but
did not author.
