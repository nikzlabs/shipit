---
title: Issue tracker filters & search
description: Tracker-agnostic status/priority/assignee filters (multi-select), free-text search, a tabular desktop layout (status, priority, assignee, issue-link as columns), and a card-based mobile layout for the inline Issues tab — all applied client-side over the normalized issue list so every current and future tracker gets them for free.
---

# Issue tracker filters & search

Builds on `docs/170-inline-tracker-issues` (TRACKER-67), which shipped the read-only,
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
| **Assignee** | `assignee.name` (+ a synthetic "Unassigned" bucket) | Like status, assignee names are data, not a fixed enum — the options are **derived** from the distinct `assignee.name` values in the loaded list, plus an explicit **Unassigned** option for issues with no `assignee`. Avatars (`assignee.avatarUrl`) render in the option rows when present. |
| **Search** | `identifier` + `title` (+ `description`) | Plain substring match on fields every issue has. |

The asymmetry — priority chips are fixed, status/assignee chips are derived — is
the mechanism that keeps this generic. A future Jira adapter that returns
statuses like "To Do / In Progress / Done" and its own set of assignees needs
zero filter changes; those values just appear as derived chips. **Unassigned**
is the one synthetic option we add, because "no assignee" is a filter users want
and isn't a value the tracker enumerates.

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

> **Visual reference:** [`mockup.html`](./mockup.html) is a static,
> self-contained prototype of every state described below — desktop table with
> the three facets and the assignee popover, plus the two mobile (card-collapse)
> states. Open it in a browser. It's committed alongside this doc on purpose: the
> Present-tab artifact it was built in is ephemeral, so the prototype is preserved
> here as reference, not just described in prose. The ASCII sketches below are the
> quick-glance version of it.

A **filter bar** sits directly below the merged top bar (see "Top bar" below) in
`IssuesViewer`, above the table:

```
┌──────────────────────────────────────────────────────────┐
│  Linear · SHI   GitHub            3 of 7 issues   ⟳ Refresh │  ← merged top bar
├──────────────────────────────────────────────────────────┤
│  [🔍 Search issues…   ]  Priority ▾  Status ▾  Assignee ▾   │  ← filter bar (new)
├──────────────────────────────────────────────────────────┤
│  ISSUE   TITLE                  PRIORITY  STATUS  ASSIGNEE  │  ← table header
│  TRACKER-67  Inline tracker Issues… [Urgent]  In Prog.  Nik   ⟶ │
```

- **Search input** — a debounced (~150ms) text box, case-insensitive substring
  match over `identifier` + `title` + `description`. A clear (✕) affordance when
  non-empty.
- **Priority ▾** — a popover with a fixed checklist of the 5 levels (Urgent /
  High / Medium / Low / No priority), multi-select. The trigger shows a count
  badge when any are active ("Priority · 2").
- **Status ▾** — a popover with a checklist of the **distinct status names found
  in the current list**, multi-select, each with a per-status count. Same
  count-badge treatment. Disabled/empty when the loaded issues carry no status.
- **Assignee ▾** — a popover with a checklist of the **distinct assignees found
  in the current list** (avatar + name + count), plus an explicit **Unassigned**
  row, multi-select. Same count-badge treatment.

### Top bar

The tracker sub-tabs, the issue count, and Refresh were recently merged into a
**single top bar** (sub-tabs left-aligned, count + Refresh right-aligned) — the
two-row header/sub-tab split in the original docs/170 build is gone. The filter
bar is its own row beneath that merged bar; the table follows.

- **The count** in the top bar updates to **"N of M issues"** when any filter is
  active (M = loaded total, N = after filtering), falling back to the existing
  "M issues" when no filter is active.
- **Empty-filtered state** — when filters exclude everything, show "No issues
  match your filters" with a **Clear filters** button, distinct from the
  existing "No open issues in this team" empty state (which means the *list* is
  empty, not the filter).

### Filter combination semantics

Standard faceted-search semantics:

- **Within a facet: OR.** Selecting Urgent + High shows issues that are Urgent
  *or* High. Selecting two statuses (or two assignees) shows either.
- **Across facets: AND.** Priority ∈ {Urgent, High} **and** Status ∈ {In
  Progress} **and** Assignee ∈ {Nik} **and** title/identifier matches the search
  text.
- **Empty facet = no constraint.** No priorities selected means "any priority,"
  not "no issues."

## Table layout

Today each row is a stacked "card" (identifier + priority badge on one line,
title below, status/assignee on a third line — see `IssueRow` in
`IssuesViewer.tsx`). With filters added, a **tabular** layout reads better: it
aligns the facets you're filtering on into scannable columns and pairs naturally
with the filter bar (filter a column → scan that column).

The list becomes a table with these columns:

| Column | Source | Notes |
|---|---|---|
| **Issue** | `identifier` → `url` | The existing external link (opens the issue in the tracker, `ArrowSquareOutIcon`). Becomes its own narrow, monospace column instead of sharing a line with priority. This is the "linked to the original issue" column. |
| **Title** | `title` (+ `description`) | The **widest** column — the only flex-grow one, all others fixed-width. The title **wraps to two lines** instead of truncating, with an optional dim one-line `description` preview beneath it; the extra room makes a row scannable without opening the issue. |
| **Priority** | `priority` | The existing `PriorityBadge`, now its own fixed-width column so badges align vertically and the priority filter maps to a visible column. |
| **Status** | `status.name` | Promoted from the third-line metadata into its own column. |
| **Assignee** | `assignee` | Avatar + name, its own column and a filterable facet; the first column to drop on narrow widths. |
| **(action)** | — | The per-row **Start session** button, right-aligned in a trailing column. |

Design constraints, to stay consistent with the codebase:

- **Tracker-agnostic columns.** Every column reads a field on the normalized
  `TrackerIssue` — no tracker-specific column ever appears. A tracker that omits
  `status`/`assignee` renders an empty cell, not a broken layout.
- **CSS, not a table lib.** Use a CSS grid (or fl-aligned rows) with Tailwind v4
  utilities and the existing `--color-*` tokens — no new dependency. A sticky
  header row labels the columns (`Issue · Title · Priority · Status · Assignee`).
  Keep the existing `divide-y divide-(--color-border-secondary)` row separators
  and `hover:bg-(--color-bg-hover)`.
- **Sort stays priority-first** (docs/170); columns are display-only in v1. The
  Priority and Status **headers are not sort toggles** yet — column-sort is a
  natural fast-follow but out of scope here (the list is already
  priority-sorted, and adding sortable headers reopens the sort model). Listed in
  Non-goals.
- **Responsive degradation (intermediate widths).** As the panel narrows (the
  Issues tab can be a side panel), drop the Assignee column first, then Status,
  collapsing back toward the identifier + title + priority + action core. Title
  never drops. Below a breakpoint the table collapses entirely to the mobile card
  layout (next section).
- **The filter bar's empty-filtered state** sits above the table, unchanged by
  the columnar layout.

`IssueRow` is restructured from a stacked flexbox into a grid row;
`IssuesViewer` gains the header row. No prop/data changes — same `TrackerIssue`
in, table out.

## Mobile / narrow layout

Below a width breakpoint (≈640px — phone, or a tight side panel), a six-column
grid stops being legible, so the layout **collapses back to a stacked card per
issue** — essentially the original docs/170 `IssueRow`, kept as the small-screen
branch:

```
┌───────────────────────────────┐
│ Linear · SHI  GitHub  7 issues ⟳│  ← top bar (count stays here, as on desktop)
├───────────────────────────────┤
│ [🔍 Search issues…           ] │  ← search on its own row
│ Priority▾  Status▾  Assignee▾  │  ← facets as a horizontally-scrollable chip row
├───────────────────────────────┤
│ TRACKER-67 ↗            [Urgent]   │
│ Inline tracker Issues tab…     │  (title, up to 2 lines)
│ In Progress · 🧑 Nik           │
│ [      🚀 Start session      ] │  (full-width)
└───────────────────────────────┘
```

Mobile-specific behavior:

- **Top bar is identical in structure to desktop:** sub-tabs left, the "N of M
  issues" count + Refresh right. The count deliberately **stays in the top bar**
  (not a separate row) so the count's position is consistent across breakpoints;
  on the narrowest widths Refresh collapses to an icon-only button to make room.
- **Filter bar wraps to two rows:** the search box gets a full-width row, and the
  three facets become a **horizontally-scrollable chip row** beneath it (chips,
  not dropdown buttons, so they're touch-sized and never overflow the viewport).
  Each chip opens the same multi-select popover (rendered inline/sheet-style on
  mobile) and shows its active-count pill.
- **Rows are cards, not grid rows.** Identifier + priority on the first line,
  title (up to two lines) below, a `status · assignee` meta line, and a
  **full-width Start session** button — easy to tap.
- **Same filter engine.** Mobile reuses the identical `filterIssues` /
  `distinctStatuses` / `distinctAssignees` helpers and store state; only the
  presentational shell differs (Tailwind responsive `max-md:` variants on one
  `IssuesViewer`, not a separate component). The "N of M" count and Clear-filters
  affordance carry over.

This is the responsive endpoint of the column-dropping ladder above: drop
Assignee → drop Status → collapse to cards.

## State & data flow

Filter state lives in `issues-store.ts` alongside the existing list state. The
sort is unchanged — the list stays priority-sorted; filtering only removes rows.

```
issuesByTracker[tracker]  (normalized TrackerIssue[], priority-sorted)
        │
        ├── filters: { query, priorities:Set<level>, statuses:Set<name>, assignees:Set<name|UNASSIGNED> }  (new store state)
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
- **Status** and **assignee** selections are tracker-specific (freeform names),
  so on a sub-tab switch each set is **pruned to values that exist in the
  newly-active list** (stale names from another tracker silently drop; the
  synthetic **Unassigned** value always survives). Simplest correct behavior;
  avoids a chip that matches nothing.
- A single top-level **Clear filters** resets all four facets + search.

**Persistence across reloads.** The whole `filters` object is workspace-scoped
reference state (it is *not* cleared on a session switch — `issues-store.reset()`
isn't part of `session-actions.ts`), so it persists to `localStorage` under
`shipit-issue-filters` and rehydrates on the next page load. The three facets are
`Set`s, so they serialize to arrays and back (`getSavedIssueFilters` /
`saveIssueFilters` in `utils/local-storage.ts`); priorities are validated against
the fixed enum on read, and stale freeform status/assignee values are pruned to
the loaded list by the first `fetchIssues` after rehydration — so restoring a
saved value before any fetch is safe. A single `useIssuesStore.subscribe` at the
bottom of the store persists on every `filters` change, covering both the direct
edits (`setQuery`/`toggle*`/`clearFilters`) and the prune that runs inside
`setActiveTracker`/`fetchIssues`, so no individual action has to remember to save.

The derived status/assignee options and the filtered list are computed with
**stable memoized selectors** — note the docs/170 gotcha (`IssuesPanel.test.tsx`):
Zustand selectors here must return stable references or they loop into React
error #185. Any derived array (filtered issues, distinct status names, distinct
assignees) must be memoized (`useMemo` in the panel, or a cached selector) and
fall back to a shared module-level constant when empty, exactly like
`EMPTY_ISSUES`.

## Key files

Client (all changes are client-side — this is the point):

- `src/client/stores/issues-store.ts` — add `filters` state
  (`query: string`, `priorities: Set<IssuePriorityLevel>`,
  `statuses: Set<string>`, `assignees: Set<string>` with a sentinel for
  Unassigned) + actions (`setQuery`, `togglePriority`, `toggleStatus`,
  `toggleAssignee`, `clearFilters`); prune `statuses`/`assignees` on
  `setActiveTracker` / after `fetchIssues`.
- `src/client/components/issues-filter.ts` (new) — pure
  `filterIssues(issues, filters)`, `distinctStatuses(issues)`, and
  `distinctAssignees(issues)` helpers. The tracker-agnostic core; unit-tested in
  isolation.
- `src/client/components/IssuesFilterBar.tsx` (new) — the search box + three
  multi-select popovers (Priority / Status / Assignee) + count badges
  (presentational). Renders as a single row on desktop and a search-row +
  scrollable chip-row on mobile (`max-md:` variants).
- `src/client/components/IssuesViewer.tsx` — render the merged top bar with the
  "N of M" count, the filter bar, the empty-filtered state, and the **table**
  (sticky column-header row + grid rows) that **collapses to stacked cards below
  the mobile breakpoint**; restructure `IssueRow` into a grid row (desktop) /
  card (mobile) with Issue / Title / Priority / Status / Assignee / action;
  accept filter props/handlers.
- `src/client/components/IssuesPanel.tsx` — select filter state, compute the
  memoized filtered list + distinct statuses + distinct assignees (stable refs!),
  wire handlers.

Server: **none.** No route, type, or adapter change. The existing
`GET /api/issues` and the normalized `TrackerIssue` are sufficient. (This is the
strongest evidence the design is tracker-agnostic: adding filters touches zero
tracker code.)

Tests:

- `src/client/components/issues-filter.test.ts` (new) — the filter/search/derive
  helpers: OR-within / AND-across semantics, case-insensitive search across
  identifier+title+description, empty-facet = no constraint, distinct-status and
  distinct-assignee derivation (incl. the synthetic Unassigned bucket), priority
  enum coverage.
- `src/client/components/IssuesViewer.test.tsx` — filter bar renders (three
  facets), count shows "N of M", empty-filtered state + Clear button.
- `src/client/components/IssuesPanel.test.tsx` — status/assignee pruning on
  tracker switch; stable-reference regression (no React #185 with filters
  active).

## Non-goals (v1)

- **No server-side / upstream-query filtering.** No Linear `filter:`, no GitHub
  search syntax — that's the per-tracker query sprawl docs/170 rejects.
- **No label / custom-field facets (yet).** `TrackerIssue` has no `labels` field
  today; adding label filtering means extending the normalized type *and* every
  adapter. Deferred. (Assignee filtering **is** in scope here — `assignee.name`
  is already on the normalized type, so it needs no adapter change.)
- **No saved filters / shareable filter URLs.** No named filter presets and no
  filter state encoded in the URL for sharing. Filters *do* persist across page
  reloads via `localStorage` (workspace-scoped, see **Persistence across
  reloads** above) — what's out of scope is multiple named views and
  shareable/linkable filter state.
- **No sortable column headers.** The table is display-only; the list stays
  priority-sorted (docs/170). Click-to-sort columns are a natural fast-follow but
  reopen the sort model, so they're deferred.
- **No status-category (`status.type`) grouping.** Kept as a future enhancement
  (cluster derived status chips by category); v1 uses flat name-level chips.
- **No raising the `first: 100` fetch cap.** Orthogonal; revisit only if a team
  routinely exceeds it.

## Relationship to existing docs

- **`docs/170-inline-tracker-issues`** (TRACKER-67) — the Issues tab this extends.
  Reuses its normalized `TrackerIssue` type, its store, and its "fetch full list
  on open" model. This doc adds list ergonomics on top without touching the
  tracker abstraction.
- **`docs/168-tracker-backed-priorities`** (TRACKER-28, Done) — established the
  normalized priority enum that makes the priority facet tracker-agnostic.
- **`docs/156-issue-to-session`** — unaffected; this is purely the pull-side
  list view.
