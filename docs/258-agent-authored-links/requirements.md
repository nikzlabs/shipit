# Agent-authored links into the Preview and the Present tab — requirements

What the feature must do, in the requester's terms. Design and mechanism live in
[`plan.md`](./plan.md).

## Context

The agent can already *act* on a user-built app: an app running in the Preview,
or a presented HTML artifact, can talk back to the agent through the Agent
Interface SDK (docs/242). The gap is the return direction. When the agent wants
to say "this item needs your attention", the only thing it can produce is prose.
The worked example the requester gave: a user builds a custom requirements
manager, edits requirements through the agent, and the agent replies pointing at
one requirement — with no way to make that pointer clickable.

## Requirements

1. The agent can write a clickable pointer in chat, and **chooses how it
   renders**: as an inline link, as a badge, or as a button. The choice is the
   agent's per pointer — one message can carry a link in a sentence and a button
   beneath it.
2. Clicking it opens the linked destination **in the Preview**.
3. Clicking it opens the linked destination **in a presented file** (Present tab).
4. Both destinations are supported by the same feature; neither is a follow-up.
5. A pointer **can** address a specific place in the destination — the item the
   agent is pointing at — as well as the app or the artifact as a whole.
6. The feature is generic. It serves apps the *user* built (the requirements
   manager is one example), so it must not be tied to any ShipIt-owned domain
   such as issues, files, or PRs.
7. The agent authors a link as an **ordinary markdown link** whose address is a
   ShipIt URL scheme. No new tool call, and a link can sit anywhere prose can.
8. A Preview destination is addressed by **path plus the service name**. A port
   is never required of the agent.
9. A Present destination is addressed by the artifact's **file path plus a URL
   fragment**; the fragment is what names the place inside it. This works for
   **rendered HTML and for markdown** artifacts.
10. A pointer that cannot be opened **stays clickable** and, on click, says why
    instead of doing nothing. The explanation appears as a **toast**, the same
    way for both destinations. This is **best effort**: ShipIt reports the
    failures it can determine, and does not build machinery to detect the rest.
    A pointer that appears to open successfully is treated as having opened.
11. A pointer can also make the destination page **react** in its own
    JavaScript — highlight the item, open a drawer, switch a filter — rather
    than only being scrolled to an anchor. This applies to the **Preview**
    (req 2), where the page reacts by reading the query parameters and fragment
    from its own URL. ShipIt adds no API for this. A presented artifact (req 3)
    cannot react this way and is not expected to; anything that elaborate
    belongs in a preview service, not a single page.
12. If the pointer names a service that is **not running, ShipIt starts it
    first** and then opens the destination. A stopped service is not by itself a
    reason to report a pointer as unopenable (req 10); a start that *fails* is.
13. Clicking a pointer at a place **inside the page the Preview is already on
    navigates within that page** — it does not reload it. The user must not see
    the app blink and rebuild itself to be taken to an item on the page in front
    of them.

## The page-facing contract

What a user's page can rely on. It is deliberately small, and **ShipIt adds no
API of its own** — no `window.shipit` surface, no new SDK.

- **In the Preview**, a pointer navigates the page to the URL the agent wrote,
  so the payload is the URL: the page reads `location.search` and
  `location.hash` and listens for `hashchange`. Standard web APIs, nothing
  ShipIt-specific to learn (req 11).
- **In a presented artifact**, ShipIt scrolls to the fragment itself (req 9).
  The page is not told anything and cannot react in script.

The one thing this cannot express is a **repeat click on the same pointer**:
identical URL, so no navigation and no event. Accepted — a page that needs to
respond to every click is a page that should be a preview service.

## Open questions

_None._

## Resolved questions

- **2026-08-10 — Must a click navigate within the page rather than reload it?**
  Reported by the requester against the shipped feature: *"pressing a link in
  the conversation to open in the preview seems to reload the preview page, not
  navigate within the page (visible blink)"*. Recorded as req 13. What ShipIt
  can honour is bounded by the web platform, and the boundary is now stated in
  [`plan.md`](./plan.md): a destination differing only by fragment is a
  same-document navigation and never reloads; a different path or query is a
  cross-document navigation and loads, unless the page's own router intercepts
  it. Making *those* same-document too would need ShipIt to guess that the page
  is client-routed, and a page that guesses wrong renders stale content under a
  changed URL — worse than the blink.

- **2026-08-09 — Which failures must req 10's toast cover?** Req 10 said "for
  any reason", which ShipIt cannot honour literally: some failures need a
  correlated request/result protocol, handshake timeouts and proxy correlation
  to observe, and some are undetectable even then — a route that loads and shows
  the app's own "not found" screen is indistinguishable from one that opened
  correctly. Offered narrowing it to what ShipIt can determine, or building that
  subsystem. Answer: *"yes best effort"*. Recorded in req 10. The failures ShipIt
  reports are listed in [`plan.md`](./plan.md); that list is a design decision
  and may grow without changing this requirement.

- **2026-08-09 — Does the feature need a ShipIt API for page reaction, or is the
  URL enough?** The requester: *"do we actually need a special API? The page JS
  could use the location API, no?"* — then, once told that a presented artifact
  is mounted from `srcDoc` and has no URL to read: *"drop the API, the presented
  artifacts wouldn't be able to react with JS. I think it is fair, this
  capability is for more complicated cases that should be in a more permanent
  preview service, not a single page."* Answer: **no ShipIt API at all.** Req 11
  is now Preview-only and carried by the page's own URL; presented artifacts
  scroll (req 9) but do not react. The planned `window.shipit.links` surface is
  cut entirely, so the Agent Interface SDK is unchanged by this feature.

- **2026-08-09 — Do reqs 3, 9 and 11 apply to presented artifacts that are not
  HTML?** Raised by the cross-backend review: only rendered HTML has a channel
  into the page (`PresentPane.tsx:80`), so other kinds could be focused but not
  scrolled-into or messaged. Offered HTML-only, or per-kind behaviour. Answer:
  *"also markdown, links should work there. But if it is complicated,
  html-only"*. It is not complicated — markdown renders in ShipIt's own DOM, so
  the scroll needs no SDK — so **markdown is in**, recorded in req 9. Page
  messaging (req 11) stays where page JavaScript exists, which markdown has
  none of.

- **2026-08-09 — Must a pointer always address a specific place, or is that
  optional?** The first draft of req 5 turned the requester's example ("here is
  the item that needs attention") into a universal rule, which also forbade
  pointing at an app as a whole. Flagged as an agent inference by both the agent
  and the cross-backend review. Answer: *"yes, it is optional"*. Req 5 states a
  capability, not a restriction.

- **2026-08-09 — Should a click start a stopped service?** The design had
  recorded the opposite as a non-goal, on the agent's own reasoning that a click
  which boots a container is a bigger action than a link's appearance promises.
  The requester overrode it: *"another requirement: if the service is not
  running, it is started first"*. Recorded as req 12, and the non-goal is
  withdrawn.

- **2026-08-09 — Where does the "why" appear when a destination is unavailable
  (req 10)?** Raised by the requester against req 10, which said a dead pointer
  explains itself but not where the explanation lands. Offered a transient
  toast, an inline note beside the clicked pointer, or the destination panel's
  own empty state. Answer: **a toast**. Folded into req 10, including that both
  destinations report the same way.

- **2026-08-09 — Should the agent choose how a pointer renders?** The first
  draft of req 1 said only "renders as a link". The requester: *"maybe could be
  parameterized to be rendered as a link, as a badge or as a button"*. Answer:
  **the agent picks the form per pointer, from link / badge / button**. Recorded
  in req 1. How the agent expresses that choice is a design question, not a
  requirement.

- **2026-08-09 — How does the agent author the link?** Offered a markdown link
  with a ShipIt URL scheme, a dedicated card-emitting tool, or both. Answer:
  **the markdown link**. Recorded as req 7; the card tool was not adopted.

- **2026-08-09 — How is a Preview destination addressed?** Offered path-only
  against the current preview, path plus optional port/service, or a full
  preview URL. Answer: **path plus the service name — "port shouldn't be
  needed"**. Recorded as req 8: the agent names a service, never a port, and
  ShipIt resolves the port itself.

- **2026-08-09 — How does a link point inside a presented artifact?** Offered
  file path plus URL fragment, file path only, or fragment plus a structured
  SDK message to the artifact. Answer: **file path plus URL fragment**.
  Recorded as req 9.

- **2026-08-09 — Should a link also message the destination page?** The
  question above offered an SDK-message variant as an alternative to the
  fragment and it was not chosen; the requester then asked for it explicitly
  ("I like the idea to also allow sending a message to the page that would be
  handled by JS, add as a requirement"). Answer: **both**. Recorded as req 11 —
  additive to req 9, not a replacement, and it covers the Preview as well as
  presented artifacts.

- **2026-08-09 — What happens when the destination is unavailable?** Offered
  degrading to plain text, staying clickable and explaining on click, or
  recovering the target on click. Answer: **stay clickable, show why on
  click**. Recorded as req 10 — deliberately unlike the issue badges, which go
  plain text, because the agent authored this link on purpose and a silently
  vanished link would read as a bug.

## Non-requirements

- Linking to ShipIt-owned destinations. Repo files and tracker issues already
  work (`remarkLinkifyPaths`, `remarkLinkifyIssues`); PRs have their own
  affordances and are not part of this feature either way.
- Auto-detecting link targets in bare prose. Nothing was asked for beyond an
  explicitly authored link.
