---
issue: https://linear.app/shipit-ai/issue/SHI-138
title: Intercept tracker issue URLs in markdown → open the in-app issue viewer
description: Linear/GitHub issue links in rendered markdown open ShipIt's inline Issues viewer instead of navigating out, gated on the tracker being connected.
---

# Intercept tracker issue URLs in markdown

When a Linear or GitHub **issue URL** appears as a link in rendered markdown —
`https://linear.app/shipit-ai/issue/SHI-137`,
`https://github.com/owner/repo/issues/42`, or the GitHub short form
`owner/repo#42` — clicking it opens ShipIt's **in-app Issues viewer** (the
master-detail panel, docs/189) instead of bouncing the browser out to
linear.app / github.com.

This is the "inline beats link-out" product principle (CLAUDE.md §1/§2): a
tracker issue URL is data ShipIt already renders inline, so we keep the user
inside ShipIt. The external link remains the **escape hatch** — used only when
we can't render it inline (the tracker isn't connected).

## Behavior

- **Connected tracker → open inline.** The click `preventDefault()`s, reveals
  the Issues tab (`setRightTab("issues")` + `setMobilePanel("preview")`), and
  loads the issue via `useIssuesStore.openIssue(...)`.
- **Disconnected (or cold) tracker → link out.** The anchor keeps its
  `target="_blank"` + the resolved absolute `href`, so the default navigation
  opens the upstream issue in a new tab. The connected state is warmed on app
  mount / session change (see below) so "cold" is rare in practice.
- **Only issue URLs.** PR URLs (`/pull/N`), Linear project URLs, and repo URLs
  are never intercepted — they keep opening externally. This falls out of
  reusing the shared `parseIssueRef`, whose regexes only match issue shapes.
- **Surfaces covered.** Every markdown surface shares one renderer, so this
  works in assistant chat, PR bodies/comments, the docs viewer, issue
  descriptions/comments, and markdown tooltips. Bare issue URLs in prose are
  covered too, because `remark-gfm` autolinks them into link nodes that the same
  renderer sees — no separate bare-pointer regex pass.

## Connected-tracker gating

`useIssuesStore.trackers` carries a `configured` boolean per tracker. The
decision is read at **click time** via `getState()` (not a hook subscription),
which keeps `MarkdownLink` render-pure and preserves the `MarkdownContent` memo.

The risk is a **cold** `trackers` list (the user never opened the Issues tab):
`configured` would read false and we'd wrongly link out. We warm it with a
mount/session-keyed `fetchTrackers()` effect in `App.tsx`, independent of the
Issues tab. It's keyed on `sessionId` because the GitHub tracker's `configured`
state resolves against the active session's repo binding (Linear is global);
`fetchTrackers` is idempotent and cheap.

## Classifier ordering

The tracker-issue branch in `MarkdownLink` is checked **before** the repo-file
branch. For absolute URLs the order is irrelevant (`parseRepoFileLink` returns
null for `scheme://` hrefs), but the GitHub short form `owner/repo#42` would
otherwise be misread by `parseRepoFileLink` as the path `owner/repo` at line 42.
Tracker-first resolves that, and the branch is gated on the tracker being
connected, which bounds any false-positive on relative-looking link text.

A bare Linear key (`SHI-28`) is intentionally **not** intercepted: it has no
derivable URL without the workspace slug (so no external fallback) and risks
false positives. `parseTrackerIssueLink` requires a usable absolute `url`.

## Key files

- `src/server/shared/issue-ref.ts` — shared `parseIssueRef` (reused, unchanged);
  distinguishes issue URLs from PR/project/repo URLs.
- `src/client/utils/tracker-link.ts` — `parseTrackerIssueLink`, the thin client
  classifier wrapping `parseIssueRef`; returns null for non-issue / unknown
  hrefs and for refs without a usable URL. Co-located `tracker-link.test.ts`.
- `src/client/components/message-markdown.tsx` — `MarkdownLink` gains the
  tracker-issue branch (first, before repo-file). Component test in
  `message-markdown.test.tsx`.
- `src/client/App.tsx` — `fetchTrackers()` warm-up effect keyed on `sessionId`.
- `src/client/stores/issues-store.ts` — `openIssue(OpenIssueRef)` opens the
  inline viewer; `trackers[].configured` drives the gate (unchanged).

## Related

- docs/170-inline-tracker-issues — the Issues tab + sub-tabs + `trackers`.
- docs/189-inline-issue-detail — the master-detail viewer `openIssue` drives.
