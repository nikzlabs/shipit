# Issue tracker filters & search — checklist

## Core (tracker-agnostic, client-side)

- [ ] `issues-filter.ts` — pure `filterIssues(issues, filters)` (OR-within-facet,
      AND-across-facet, case-insensitive search over identifier+title+description)
- [ ] `issues-filter.ts` — `distinctStatuses(issues)` deriving status chips from
      the loaded list
- [ ] `issues-filter.ts` — `distinctAssignees(issues)` deriving assignee chips
      (avatar + name + count) plus the synthetic Unassigned bucket
- [ ] Unit tests for the filter/derive helpers

## Store

- [ ] Add `filters` state to `issues-store.ts` (`query`, `priorities:Set`,
      `statuses:Set`, `assignees:Set` with an Unassigned sentinel)
- [ ] Actions: `setQuery`, `togglePriority`, `toggleStatus`, `toggleAssignee`,
      `clearFilters`
- [ ] Prune `statuses` + `assignees` to valid values on `setActiveTracker` /
      after `fetchIssues` (Unassigned sentinel always survives)
- [ ] Persist `query` + `priorities` across sub-tab switches; reset on `reset()`

## UI — desktop

- [ ] `IssuesFilterBar.tsx` — debounced search box + Priority/Status/Assignee
      multi-select popovers + active-count badges
- [ ] `IssuesViewer.tsx` — merged top bar with "N of M issues" count; render
      filter bar + empty-filtered state with Clear-filters button
- [ ] `IssuesViewer.tsx` — table layout: sticky column-header row + grid rows;
      restructure `IssueRow` into Issue / Title / Priority / Status / Assignee /
      action columns (Issue column links to the original issue)
- [ ] Title column is widest + wraps to two lines; optional dim description preview
- [ ] Responsive degradation: drop Assignee then Status on narrow widths; Title
      and the action never drop

## UI — mobile

- [ ] Below the breakpoint, table collapses to stacked cards (`max-md:` variants,
      one `IssuesViewer`, not a separate component)
- [ ] Filter bar wraps: full-width search row + horizontally-scrollable facet
      chip row; count stays in the top bar (consistent with desktop; Refresh
      collapses to icon-only on the narrowest widths)
- [ ] Card: identifier + priority on line 1, 2-line title, status · assignee meta,
      full-width Start session button

## Plumbing

- [ ] `IssuesPanel.tsx` — memoized filtered list + distinct statuses + distinct
      assignees (stable refs, no React #185), wire handlers

## Tests

- [ ] `issues-filter.test.ts` — semantics, search, distinct-status/assignee,
      Unassigned bucket
- [ ] `IssuesViewer.test.tsx` — three facets, count, empty-filtered state
- [ ] `IssuesPanel.test.tsx` — status/assignee pruning on tracker switch +
      stable-ref regression
- [ ] `npm run lint:dev` + `npm run typecheck` clean

## Docs

- [ ] Update `docs/170` plan if the filter bar changes its described layout
