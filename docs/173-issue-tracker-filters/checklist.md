# Issue tracker filters & search — checklist

## Core (tracker-agnostic, client-side)

- [x] `issues-filter.ts` — pure `filterIssues(issues, filters)` (OR-within-facet,
      AND-across-facet, case-insensitive search over identifier+title+description)
- [x] `issues-filter.ts` — `distinctStatuses(issues)` deriving status chips from
      the loaded list
- [x] `issues-filter.ts` — `distinctAssignees(issues)` deriving assignee chips
      (avatar + name + count) plus the synthetic Unassigned bucket
- [x] Unit tests for the filter/derive helpers

## Store

- [x] Add `filters` state to `issues-store.ts` (`query`, `priorities:Set`,
      `statuses:Set`, `assignees:Set` with an Unassigned sentinel)
- [x] Actions: `setQuery`, `togglePriority`, `toggleStatus`, `toggleAssignee`,
      `clearFilters`
- [x] Prune `statuses` + `assignees` to valid values on `setActiveTracker` /
      after `fetchIssues` (Unassigned sentinel always survives)
- [x] Persist `query` + `priorities` across sub-tab switches; reset on `reset()`

## UI — desktop

- [x] `IssuesFilterBar.tsx` — debounced search box + Priority/Status/Assignee
      multi-select popovers + active-count badges
- [x] `IssuesViewer.tsx` — merged top bar with "N of M issues" count; render
      filter bar + empty-filtered state with Clear-filters button
- [x] `IssuesViewer.tsx` — table layout: sticky column-header row + grid rows;
      restructure `IssueRow` into Issue / Title / Priority / Status / Assignee /
      action columns (Issue column links to the original issue)
- [x] Title column is widest + wraps to two lines; optional dim description preview
- [x] Responsive degradation: drop Assignee then Status on narrow widths; Title
      and the action never drop

## UI — mobile

- [x] Below the breakpoint, table collapses to stacked cards (`max-md:` variants,
      one `IssuesViewer`, not a separate component)
- [x] Filter bar wraps: full-width search row + horizontally-scrollable facet
      chip row; count stays in the top bar (consistent with desktop; Refresh
      collapses to icon-only on the narrowest widths)
- [x] Card: identifier + priority on line 1, 2-line title, status · assignee meta,
      full-width Start session button

## Plumbing

- [x] `IssuesPanel.tsx` — memoized filtered list + distinct statuses + distinct
      assignees (stable refs, no React #185), wire handlers

## Tests

- [x] `issues-filter.test.ts` — semantics, search, distinct-status/assignee,
      Unassigned bucket
- [x] `IssuesViewer.test.tsx` — three facets, count, empty-filtered state
- [x] `IssuesPanel.test.tsx` — status/assignee pruning on tracker switch +
      stable-ref regression
- [x] `npm run lint:dev` + `npm run typecheck` clean

## Persistence across reloads (follow-up)

- [x] `getSavedIssueFilters` / `saveIssueFilters` in `utils/local-storage.ts`
      (Set ↔ array serialization, priority-enum validation on read)
- [x] Initialize store `filters` from `localStorage`; single `subscribe` persists
      on every `filters` change (direct edits + prune)
- [x] Tests: localStorage round-trip (Sets restored), invalid-priority drop,
      corrupt/empty fallback, store-change auto-persist

## Docs

- [x] Update `docs/170` plan if the filter bar changes its described layout
