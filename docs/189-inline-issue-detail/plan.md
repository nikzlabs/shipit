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
the list. The list **filter state** lives in the store, so the filtered view is
intact on return — but `IssuesViewer` itself fully unmounts behind the detail,
so its DOM `scrollTop` is gone. To land the user on the same row they left, the
viewer stashes its scroll offset into `issues-store.listScrollTop` on unmount
(a `useLayoutEffect` cleanup) and restores it on remount before paint (the same
effect's setup). Rows render synchronously from the cached list, so the
scrollable content already exists when the offset is restored — no jump, no
fetch wait. This was chosen over a dedicated ephemeral tab (the PR-tab pattern —
but PR is a per-session singleton, issues are a collection, so a re-targeting
tab adds churn) and over a modal (ShipIt reserves modals for settings-style
interruptions; content lives in panels).

## Four entry points, one path

All routes go through `issues-store.openIssue(ref)`:

1. **List row** — the whole row is a `role="button"` that opens the detail
   (seeded with the full `TrackerIssue` it already has, so the view paints
   instantly). The row no longer links out.
2. **`IssueRefCard`** (agent `shipit issue view`) — the card is now a button
   that opens the detail instead of an external anchor.
3. **`IssueWriteCard`** (agent `shipit issue comment/edit/...`) — the identifier
   chip opens the detail; the Undo button is untouched.
4. **Doc viewer issue chip** (`DocsViewer` — a doc's `issue:` frontmatter
   pointer, docs/168) — the chip was the last issue affordance still deep-linking
   out. It now opens the inline detail when `App.handleOpenIssue` is wired and the
   pointer resolves to a known tracker (via `parseIssueRef`). An unknown-shape
   pointer keeps the external link, since there's no inline view to open it in.

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

## Comment thread (follow-up, shipped)

Reading an issue now includes its **discussion**, and the user can reply without
leaving ShipIt — the same inline-beats-link-out stance applied to comments. This
was the first listed non-goal; it's now built, mirroring the PR detail tab's
`PrConversationSection` (read + post inline).

- **Tracker interface** grew `listComments(id)` → `TrackerComment[]`
  (oldest-first). The Linear adapter queries `issue.comments`; the GitHub adapter
  hits `GET issues/{n}/comments`. `TrackerComment` gained optional
  `author { name, avatarUrl }` + `createdAt` so a thread row can render; the
  write-path `addComment` now populates them too (so a just-posted comment
  appears with its author without a refetch).
- **Read route** `GET /api/issue/comments?tracker=&id=[&sessionId=]` →
  `listIssueCommentsForTracker` → `{ comments }` (`ListIssueCommentsResult`).
  Public, card-less, session-scoped for GitHub only — exactly like `GET /api/issue`.
- **User-post route** `POST /api/issue/comments { tracker, id, body, sessionId? }`
  → `addIssueCommentForTracker` → `{ comment }` (`PostIssueCommentResult`).
  Deliberately distinct from the agent's session-scoped `issue/comment` write:
  a user-typed comment lands in the thread it's visible in, so it emits **no**
  chat provenance card and has no undo. (The agent path keeps its card + Undo.)
- **Store** holds `comments` / `commentsLoading` / `commentsError`; `openIssue`
  fetches the thread alongside the detail (independently, so the body paints
  without waiting on it), `postComment` appends the returned comment, and a
  stale-response guard mirrors `fetchDetail`'s.
- **`IssueDetail`** renders the thread (avatar · author · relative-date ·
  markdown body) + a composer below the description.

### Anchor to a specific comment (SHI-103)

An opener can land the user on one comment, not just the issue. An optional
`anchorCommentId` rides through `openIssue` → `IssueSelection` → `IssueDetail`;
once the thread fetch lands, the detail view scrolls that comment's row into view
and briefly flashes it, then calls `clearAnchorComment` so a later refresh
doesn't re-anchor. The `IssueWriteCard` threads its undo snapshot's `commentId`
(present only for a `comment` write) into the `onOpen` payload, so clicking the
provenance card for a comment the agent just posted lands on that exact comment.
A stale/paged anchor that matches no loaded comment is consumed without
scrolling. This closes the last link-out gap: reading an issue *and its
discussion*, and landing on a specific comment, all stays inside ShipIt.

- **Store** — `IssueSelection`/`OpenIssueRef` carry optional `anchorCommentId`;
  `clearAnchorComment()` drops it after the view consumes it.
- **`IssueDetail`** — `IssueComments` keeps a per-row ref map; one effect scrolls
  to + highlights the anchored row (consuming the anchor), a second fades the
  highlight, decoupled so consuming the anchor doesn't tear down the fade timer.
- **`IssueWriteCard` → `MessageList` → `App.handleOpenIssue`** — the `onOpen`
  payload grew an optional `anchorCommentId`, passed straight to `openIssue`.

## Visual reference

`mockup.html` — the detail view's layout (header with back + deep link, status·
priority strip, title, assignee/labels meta, markdown body, footer Start-session
action). Self-contained dark-theme HTML.

## Key files

- `src/server/orchestrator/api-routes-issues.ts` — `GET /api/issue` (public read,
  no card) + `GET`/`POST /api/issue/comments` (thread read + user post).
- `src/server/orchestrator/services/issues.ts` — `getIssueForTracker()`,
  `listIssueCommentsForTracker()`, `addIssueCommentForTracker()`.
- `src/server/orchestrator/trackers/tracker.ts` + `linear/`,`github/` adapters —
  `listComments()`; `TrackerComment` carries author + `createdAt`.
- `src/server/shared/types/domain-types.ts` — `GetIssueResult`,
  `ListIssueCommentsResult`, `PostIssueCommentResult`, enriched `TrackerComment`.
- `src/client/stores/issues-store.ts` — `selected`/`detail` state,
  `openIssue`/`fetchDetail`/`closeIssue`, `issueLookupId()`.
- `src/client/components/IssueDetail.tsx` — the detail view (new); now also the
  comment thread + composer.
- `src/client/components/IssuesPanel.tsx` — list ⇄ detail branch.
- `src/client/components/IssuesViewer.tsx` — row opens detail (deep link removed).
- `src/client/components/IssueRefCard.tsx` / `IssueWriteCard.tsx` — open the
  detail instead of linking out.
- `src/client/components/DocsViewer.tsx` — the doc `issue:` chip opens the inline
  detail (via the `onOpenIssue` prop, wired to `App.handleOpenIssue`) for a
  known tracker; external link kept only for unknown-shape pointers.
- `src/client/components/MessageList.tsx` + `App.tsx` — thread `onOpenIssue`
  (switches the right panel to Issues, reveals it on mobile, then `openIssue`).

## Non-goals (follow-ups)

- **In-view editing/status changes.** Title/status/assignee/label writes still
  flow through the agent (`shipit issue ...`); the view is read + navigate +
  comment. (Comments are the one user-write affordance, matching the PR detail
  tab — see "Comment thread" above.)
