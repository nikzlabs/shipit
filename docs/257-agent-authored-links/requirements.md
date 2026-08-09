# Agent-authored links into the Preview and the Present tab — requirements

What the feature must do, in the requester's terms. Design and mechanism live in
[`plan.md`](./plan.md), which is provisional while a question below is open.

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
5. The link addresses a **specific place** in the destination — the item the
   agent is pointing at — not just the app or the artifact as a whole.
6. The feature is generic. It serves apps the *user* built (the requirements
   manager is one example), so it must not be tied to any ShipIt-owned domain
   such as issues, files, or PRs.
7. The agent authors a link as an **ordinary markdown link** whose address is a
   ShipIt URL scheme. No new tool call, and a link can sit anywhere prose can.
8. A Preview destination is addressed by **path plus the service name**. A port
   is never required of the agent.
9. A Present destination is addressed by the artifact's **file path plus a URL
   fragment**; the fragment is what names the place inside it.
10. A link whose destination is unavailable **stays clickable** and, on click,
    says why instead of doing nothing.
11. A link can also **deliver a message to the destination page**, observable by
    that page's own JavaScript, so the page can respond to the click itself —
    highlight the item, open a drawer, switch a filter — rather than only being
    scrolled to an anchor. This applies to both destinations (req 2, req 3).

## Open questions

- **Where does the "why" appear when a destination is unavailable (req 10)?**
  Raised by the requester against req 10, which says a dead link explains itself
  but never said where the explanation lands. Candidates: a transient toast
  (ShipIt already has one); an inline note next to the clicked pointer in chat,
  where the user's attention already is; or the destination panel's own empty
  state, which is where the click promised to take them. Nothing is implemented
  while this is open.

## Resolved questions

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

- Linking to ShipIt-owned destinations (repo files, issues, PRs). Those already
  work — `remarkLinkifyPaths` and `remarkLinkifyIssues` cover them.
- Auto-detecting link targets in bare prose. Nothing was asked for beyond an
  explicitly authored link.
