---
issue: https://linear.app/shipit-ai/issue/SHI-100
title: Inline single-issue detail view
description: A master-detail issue view inside the Issues tab that the list rows and the agent's chat cards open, keeping issue reading inside ShipIt.
---

# Inline single-issue detail view (docs/189)

Bring **reading an issue** fully inside ShipIt. Before this, every per-issue
affordance — a list row's identifier, the agent's read card (`IssueRefCard`),
the agent's write card (`IssueWriteCard`) — deep-linked out to Linear/GitHub.
That violates the product's first principle (CLAUDE.md §1–2: *inline beats
link-out*). This adds a single-issue **detail view** as the detail half of the
Issues tab's master-detail layout, and re-points every entry point at it. The
deep link to the tracker survives as the one escape hatch **inside** the detail
view's header.

## Where it lives

A master-detail layout **inside the existing Issues tab** (`rightTab === "issues"`),
not a new tab or a modal. When an issue is selected, `IssuesPanel` swaps the
list (`IssuesViewer`) for the detail (`IssueDetail`); a back button returns to
the list, which stays mounted in the store so the filtered scroll position is
preserved. This was chosen over a dedicated ephemeral tab (the PR-tab pattern —
but PR is a per-session singleton, issues are a collection, so a re-targeting
tab adds churn) and over a modal (ShipIt reserves modals for settings-style
interruptions; content lives in panels).

## Three entry points, one path

All routes go through `issues-store.openIssue(ref)`:

1. **List row** — the whole row is a `role="button"` that opens the detail
   (seeded with the full `TrackerIssue` it already has, so the view paints
   instantly). The row no longer links out.
2. **`IssueRefCard`** (agent `shipit issue view`) — the card is now a button
   that opens the detail instead of an external anchor.
3. **`IssueWriteCard`** (agent `shipit issue comment/edit/...`) — the identifier
   chip opens the detail; the Undo button is untouched.

Cards only carry the display identifier (+ a native `issueId` on the write
card). `issueLookupId()` derives the tracker-native lookup id from the display
identifier (`owner/repo#42` → `42`; `SHI-28` → `SHI-28`), mirroring the server's
`parseIssueRef`, so a card can open the view without a resolution round-trip.

## Data flow

- New **public** read route `GET /api/issue?tracker=&id=[&sessionId=]` →
  `getIssueForTracker()` → `{ tracker, issue }` (`GetIssueResult`). It is the
  UI's own fetch: unlike the agent's session-scoped `issue/view` it emits **no**
  transcript card. `sessionId` only scopes the GitHub tracker to that session's
  repo, exactly like `GET /api/issues`.
- `getIssue()` hydrates the description, labels, assignee, and (Linear) the
  team's workflow states (`availableStatuses`) — strictly more than the list row.
- The store holds `selected` / `detail` / `detailLoading` / `detailError`.
  `openIssue` seeds `detail` from the row/card so the header/title paint before
  the fetch lands; `fetchDetail` then hydrates. A stale-response guard drops a
  fetch superseded by a newer `openIssue` (fast card-to-card clicks).

## Visual reference

`mockup.html` — the detail view's layout (header with back + deep link, status·
priority strip, title, assignee/labels meta, markdown body, footer Start-session
action). Self-contained dark-theme HTML.

## Key files

- `src/server/orchestrator/api-routes-issues.ts` — `GET /api/issue` (public read,
  no card).
- `src/server/orchestrator/services/issues.ts` — `getIssueForTracker()` (reused).
- `src/server/shared/types/domain-types.ts` — `GetIssueResult`.
- `src/client/stores/issues-store.ts` — `selected`/`detail` state,
  `openIssue`/`fetchDetail`/`closeIssue`, `issueLookupId()`.
- `src/client/components/IssueDetail.tsx` — the detail view (new).
- `src/client/components/IssuesPanel.tsx` — list ⇄ detail branch.
- `src/client/components/IssuesViewer.tsx` — row opens detail (deep link removed).
- `src/client/components/IssueRefCard.tsx` / `IssueWriteCard.tsx` — open the
  detail instead of linking out.
- `src/client/components/MessageList.tsx` + `App.tsx` — thread `onOpenIssue`
  (switches the right panel to Issues, reveals it on mobile, then `openIssue`).

## Non-goals (follow-ups)

- **Comments thread.** The detail view shows the description but not the issue's
  comment history — the `Tracker` interface has no `listComments` yet. A natural
  next step toward "more issue tracking inside ShipIt."
- **In-view editing/status changes.** Writes still flow through the agent
  (`shipit issue ...`); the view is read + navigate only.
