# Issue tracker filters & search — checklist

## Core (tracker-agnostic, client-side)

- [ ] `issues-filter.ts` — pure `filterIssues(issues, filters)` (OR-within-facet,
      AND-across-facet, case-insensitive search over identifier+title+description)
- [ ] `issues-filter.ts` — `distinctStatuses(issues)` deriving status chips from
      the loaded list
- [ ] Unit tests for the filter/derive helpers

## Store

- [ ] Add `filters` state to `issues-store.ts` (`query`, `priorities:Set`, `statuses:Set`)
- [ ] Actions: `setQuery`, `togglePriority`, `toggleStatus`, `clearFilters`
- [ ] Prune `statuses` to valid names on `setActiveTracker` / after `fetchIssues`
- [ ] Persist `query` + `priorities` across sub-tab switches; reset on `reset()`

## UI

- [ ] `IssuesFilterBar.tsx` — debounced search box + Priority/Status multi-select
      popovers + active-count badges
- [ ] `IssuesViewer.tsx` — render filter bar, "N of M issues" count, empty-filtered
      state with Clear-filters button
- [ ] `IssuesViewer.tsx` — table layout: sticky column-header row + grid rows;
      restructure `IssueRow` into Issue / Title / Priority / Status / Assignee /
      action columns (Issue column links to the original issue)
- [ ] Responsive degradation: drop Assignee then Status on narrow widths; Title
      and the action never drop
- [ ] `IssuesPanel.tsx` — memoized filtered list + distinct statuses (stable refs,
      no React #185), wire handlers

## Tests

- [ ] `IssuesViewer.test.tsx` — filter bar, count, empty-filtered state
- [ ] `IssuesPanel.test.tsx` — status pruning on tracker switch + stable-ref regression
- [ ] `npm run lint:dev` + `npm run typecheck` clean

## Docs

- [ ] Update `docs/170` plan if the filter bar changes its described layout
