# Agent-authored links into the Preview and the Present tab — requirements

What the feature must do, in the requester's terms. Design and mechanism will
live in `plan.md` (not written yet — questions below are open).

## Context

The agent can already *act* on a user-built app: an app running in the Preview,
or a presented HTML artifact, can talk back to the agent through the Agent
Interface SDK (docs/242). The gap is the return direction. When the agent wants
to say "this item needs your attention", the only thing it can produce is prose.
The worked example the requester gave: a user builds a custom requirements
manager, edits requirements through the agent, and the agent replies pointing at
one requirement — with no way to make that pointer clickable.

## Requirements

1. The agent can write a link in chat that renders as a link.
2. Clicking it opens the linked destination **in the Preview**.
3. Clicking it opens the linked destination **in a presented file** (Present tab).
4. Both destinations are supported by the same feature; neither is a follow-up.
5. The link addresses a **specific place** in the destination — the item the
   agent is pointing at — not just the app or the artifact as a whole.
6. The feature is generic. It serves apps the *user* built (the requirements
   manager is one example), so it must not be tied to any ShipIt-owned domain
   such as issues, files, or PRs.

## Open questions

- **How does the agent author the link?** A plain markdown link with a ShipIt
  URL scheme (`[REQ-7](shipit-preview:/requirements/7)`), or a dedicated tool
  that emits a card?
- **How is a Preview destination addressed?** Path only (resolved against the
  preview the user is on), or path plus an explicit port/service?
- **How is a Present destination addressed, and what identifies a place inside
  it?** The artifact's file path is its identity today; pointing *inside* it
  needs something more (a URL fragment, most likely).
- **What happens when the destination is not available** — the artifact was
  never presented, or no preview is running?

## Resolved questions

_None yet._

## Non-requirements

- Linking to ShipIt-owned destinations (repo files, issues, PRs). Those already
  work — `remarkLinkifyPaths` and `remarkLinkifyIssues` cover them.
- Auto-detecting link targets in bare prose. Nothing was asked for beyond an
  explicitly authored link.
