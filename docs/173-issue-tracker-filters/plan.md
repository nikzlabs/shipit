---
title: Issue tracker filters & search
description: Tracker-agnostic status/priority filters (multi-select) and free-text search for the inline Issues tab, applied client-side over the normalized issue list so every current and future tracker gets them for free.
---

# Issue tracker filters & search

Builds on `docs/170-inline-tracker-issues` (SHI-67), which shipped the read-only,
priority-sorted Issues tab with a Linear sub-tab. That list has no way to narrow
itself: as soon as a team has more than a screenful of open issues, finding "the
auth bug I want to start a session on" means scrolling. This doc adds the three
narrowing affordances a list needs — **status filter**, **priority filter**
(both multi-select, non-exclusive), and **free-text search** — in a way that
works for *any* tracker, not just Linear.

## Why this stays inside the "no triage UI" line

`docs/170` explicitly makes a **non-goal** of "a triage/query UI … no JQL /
Linear-view / GitHub-query builder." That rejection is about not rebuilding the
tracker's own query language with worse fidelity. This feature does **not** cross
that line, and the distinction is the whole design:

- We do **not** push filters to the tracker's query API (no Linear GraphQL
  `filter:`, no GitHub `is:open label:` syntax). Chasing per-tracker query
  surfaces is exactly what 170 warns against — we'd always be a worse version of
  the real thing, and we'd need new code per tracker.
- We filter **client-side over the already-fetched, normalized `TrackerIssue[]`**.
  This is list ergonomics (find a row in a list you already have), not triage
  (decide what should be in the list). It's the same category as filtering a
  file tree or a session list — a property of *our* list view, not a query
  delegated to the upstream system.

So the discipline 170 asked for is preserved: triage still happens in the
tracker; ShipIt just makes its own already-prioritized list navigable.

## Tracker-agnostic by construction

The central design choice: **filtering is a pure function of `TrackerIssue[]`**,
the normalized domain type every adapter already returns
(`src/server/shared/types/domain-types.ts`). Nothing in the filter layer knows
about Linear, GitHub, Jira, or GraphQL. Any tracker that implements the existing
`Tracker.listIssues()` contract gets status/priority/search **for free** the day
its adapter is registered — no new filter code, no per-tracker translation.

This falls out naturally from how the two facets already map onto the normalized
type:

| Facet | Normalized field | Why it's tracker-agnostic |
|---|---|---|
| **Priority** | `priority.level` — fixed enum `urgent\|high\|medium\|low\|none` | Every adapter maps its native priority into this 5-value enum (`mapLinearPriority` does it for Linear). So priority filter options are a **fixed, hardcoded** set of chips that mean the same thing across trackers. |
| **Status** | `status.name` (freeform) + optional `status.type` | Status *names* are tracker-specific strings ("In Review", "Triage", "Blocked"). We can't hardcode them. So status filter options are **derived at runtime** from the distinct `status.name` values present in the loaded list — whatever the tracker returns shows up automatically. |
| **Search** | `identifier` + `title` (+ `description`) | Plain substring match on fields every issue has. |

The asymmetry — priority chips are fixed, status chips are derived — is the
mechanism that keeps this generic. A future Jira adapter that returns statuses
like "To Do / In Progress / Done" needs zero filter changes; those names just
appear as derived status chips.

### Where `status.type` fits

Linear (and GitHub, and most trackers) also expose a coarse **status category**
on `status.type` ("backlog", "unstarted", "started", "completed", "canceled").
v1 filters on `status.name` because that's what the user reads in the row. We
keep `status.type` in mind as a future grouping key (e.g. cluster derived status
chips under their category), but do not build category-level filtering in v1 —
the list already excludes completed/canceled server-side, so the remaining
spread of names is small enough that name-level chips are enough.

## Why client-side (and not a new query param)

`docs/170` established the refresh model: **fetch the full list on tab open +
manual refresh**, `first: 100` issues into `issuesByTracker[tracker]`. The whole
normalized list is already in the store. Given that:

- **Client-side is instant** — no round-trip per keystroke or chip toggle, which
  matches the snappy feel filtering should have.
- **Client-side is tracker-agnostic for free** — see above. A server-side filter
  param would force each adapter to translate our filter model into its native
  query language, which is precisely the per-tracker query-surface sprawl 170
  rejects.
- **The data's already here** — filtering data you already hold is strictly
  simpler than re-fetching a subset.

The one real limitation: with the `first: 100` cap, filtering only sees the first
100 issues. That cap predates this doc and is acceptable for v1 (a single team's
open, non-completed issues rarely exceed 100). If it ever bites, the fix is to
raise/paginate the fetch in the adapter — orthogonal to this feature. We
**`log` nothing silently**: the header count makes truncation visible ("100
issues" with more upstream is the existing behavior, unchanged).

## UX

A **filter bar** sits between the sub-tab switcher and the list in
`IssuesViewer`:

```
┌─────────────────────────────────────────────┐
│  [🔍 Search issues…        ]  Priority ▾  Status ▾ │   ← filter bar (new)
├─────────────────────────────────────────────┤
│  SHI-67  [Urgent]                            │
│  Inline tracker Issues tab                   │
│  In Progress · Nik                           │
│  …                                           │
```

- **Search input** — a debounced (~150ms) text box, case-insensitive substring
  match over `identifier` + `title` + `description`. A clear (✕) affordance when
  non-empty.
- **Priority ▾** — a popover with a fixed checklist of the 5 levels (Urgent /
  High / Medium / Low / No priority), multi-select. The trigger shows a count
  badge when any are active ("Priority · 2").
- **Status ▾** — a popover with a checklist of the **distinct status names found
  in the current list**, multi-select. Same count-badge treatment. Disabled/empty
  when the loaded issues carry no status.
- **Header count** updates to **"N of M issues"** when any filter is active (M =
  loaded total, N = after filtering), falling back to the existing "M issues"
  when no filter is active.
- **Empty-filtered state** — when filters exclude everything, show "No issues
  match your filters" with a **Clear filters** button, distinct from the
  existing "No open issues in this team" empty state (which means the *list* is
  empty, not the filter).

### Filter combination semantics

Standard faceted-search semantics:

- **Within a facet: OR.** Selecting Urgent + High shows issues that are Urgent
  *or* High. Selecting two statuses shows either.
- **Across facets: AND.** Priority ∈ {Urgent, High} **and** Status ∈ {In
  Progress} **and** title/identifier matches the search text.
- **Empty facet = no constraint.** No priorities selected means "any priority,"
  not "no issues."

## State & data flow

Filter state lives in `issues-store.ts` alongside the existing list state. The
sort is unchanged — the list stays priority-sorted; filtering only removes rows.

```
issuesByTracker[tracker]  (normalized TrackerIssue[], priority-sorted)
        │
        ├── filters: { query, priorities:Set<level>, statuses:Set<name> }   (new store state)
        │
        ▼
  selectFilteredIssues(issues, filters)   (pure selector — the tracker-agnostic core)
        │
        ▼
   IssuesViewer renders filtered rows + "N of M" count
```

### Per-tracker vs global filter state

- **Search text** and **priority** selections are normalized/universal, so they
  **persist across sub-tab switches** (switching Linear → GitHub keeps your
  "Urgent only" view).
- **Status** selections are tracker-specific names, so on a sub-tab switch the
  status set is **pruned to names that exist in the newly-active list** (stale
  names from another tracker silently drop). Simplest correct behavior; avoids a
  status chip that matches nothing.
- A single top-level **Clear filters** resets all three.

The derived status options and the filtered list are computed with **stable
memoized selectors** — note the docs/170 gotcha (`IssuesPanel.test.tsx`):
Zustand selectors here must return stable references or they loop into React
error #185. Any derived array (filtered issues, distinct status names) must be
memoized (`useMemo` in the panel, or a cached selector) and fall back to a
shared module-level constant when empty, exactly like `EMPTY_ISSUES`.

## Key files

Client (all changes are client-side — this is the point):

- `src/client/stores/issues-store.ts` — add `filters` state
  (`query: string`, `priorities: Set<IssuePriorityLevel>`,
  `statuses: Set<string>`) + actions (`setQuery`, `togglePriority`,
  `toggleStatus`, `clearFilters`); prune `statuses` on `setActiveTracker` /
  after `fetchIssues`.
- `src/client/components/issues-filter.ts` (new) — pure
  `filterIssues(issues, filters)` and `distinctStatuses(issues)` helpers. The
  tracker-agnostic core; unit-tested in isolation.
- `src/client/components/IssuesFilterBar.tsx` (new) — the search box + two
  multi-select popovers + count badges (presentational).
- `src/client/components/IssuesViewer.tsx` — render the filter bar, the "N of M"
  count, and the empty-filtered state; accept filter props/handlers.
- `src/client/components/IssuesPanel.tsx` — select filter state, compute the
  memoized filtered list + distinct statuses (stable refs!), wire handlers.

Server: **none.** No route, type, or adapter change. The existing
`GET /api/issues` and the normalized `TrackerIssue` are sufficient. (This is the
strongest evidence the design is tracker-agnostic: adding filters touches zero
tracker code.)

Tests:

- `src/client/components/issues-filter.test.ts` (new) — the filter/search/derive
  helpers: OR-within / AND-across semantics, case-insensitive search across
  identifier+title+description, empty-facet = no constraint, distinct-status
  derivation, priority enum coverage.
- `src/client/components/IssuesViewer.test.tsx` — filter bar renders, count
  shows "N of M", empty-filtered state + Clear button.
- `src/client/components/IssuesPanel.test.tsx` — status pruning on tracker
  switch; stable-reference regression (no React #185 with filters active).

## Non-goals (v1)

- **No server-side / upstream-query filtering.** No Linear `filter:`, no GitHub
  search syntax — that's the per-tracker query sprawl docs/170 rejects.
- **No label / assignee / custom-field facets (yet).** `TrackerIssue` has no
  `labels` field today; adding label filtering means extending the normalized
  type *and* every adapter. Deferred — assignee filtering is the most likely
  fast-follow since `assignee.name` is already on the type.
- **No saved filters / shareable filter URLs.** Filter state is ephemeral
  session UI state, not persisted.
- **No status-category (`status.type`) grouping.** Kept as a future enhancement
  (cluster derived status chips by category); v1 uses flat name-level chips.
- **No raising the `first: 100` fetch cap.** Orthogonal; revisit only if a team
  routinely exceeds it.

## Relationship to existing docs

- **`docs/170-inline-tracker-issues`** (SHI-67) — the Issues tab this extends.
  Reuses its normalized `TrackerIssue` type, its store, and its "fetch full list
  on open" model. This doc adds list ergonomics on top without touching the
  tracker abstraction.
- **`docs/168-tracker-backed-priorities`** (SHI-28, Done) — established the
  normalized priority enum that makes the priority facet tracker-agnostic.
- **`docs/156-issue-to-session`** — unaffected; this is purely the pull-side
  list view.
