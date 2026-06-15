---
issue: https://linear.app/shipit-ai/issue/SHI-150
title: Nested issues + two-level sorting
description: Render sub-issues nested under their parent and let the user define a two-level (primary → secondary) sort order.
---

# Nested issues + two-level sorting

**Visual reference:** [`mockup.html`](./mockup.html) — interactive prototype (sort controls re-order live; disclosure triangles collapse parents).

## Why

Two gaps in the Issues panel (`IssuesViewer.tsx`):

1. **No hierarchy.** Linear sub-issues are flattened into one priority-sorted list, so the parent/child structure the user organized their work around is invisible. The data model (`TrackerIssue`) has no parent field at all.
2. **Fixed sort.** Ordering is hardcoded to `priority.sortOrder → identifier` (`services/issues.ts`, Linear adapter). There's no way to say "order by status, then priority."

This doc proposes nested rendering plus a user-defined **two-level** sort.

## Design decisions

### Nesting

- **Each issue renders once.** A sub-issue appears **only** under its parent — never also in the top-level list. This is the deliberate departure from Linear, which duplicates a sub-issue (once flat, once nested). One row per issue keeps counts honest and avoids the "why is this here twice" confusion.
- **Parents own a disclosure + child-count pill.** A parent shows a rotate-on-collapse triangle and a `N` pill; children indent one level with a tree elbow. Collapse state is client-side (per session, not persisted in v1).
- **One level deep, for now.** Linear allows arbitrary nesting; v1 renders a single parent→child level. Grandchildren attach to their nearest *rendered* ancestor. (Revisit if real data shows deep trees.)
- **Orphan promotion.** A child whose parent is **not in the current set** (parent is Done and `includeDone` is off, on another team, or beyond the 100-issue fetch cap) is **promoted to the top level** with a `↳ in SHI-300` hint, rather than silently dropped. This is the load-bearing edge case — the fetched window almost never contains every parent.

### Two-level sorting

- **Primary key, then secondary key, then `identifier` as the final tiebreak.** Each of the two axes has an independent direction toggle (asc/desc). Sort keys: **Priority, Status, Title, Last updated, Assignee**.
- **Status ordering** uses a workflow rank derived from the normalized `status.type` (`triage < backlog < unstarted < started < completed < canceled`), not alphabetical — so "Todo → In Progress → Done" sorts intuitively. Priority uses the existing `priority.sortOrder` (0 urgent … 4 none).
- **Children are sorted within their parent only.** The same comparator orders the sub-issues under each parent, but children are **excluded from the top-level sort** — the top level is ordered by parents (and orphans) alone. A high-priority child never reorders its parent.
- **Optional "Group by primary"** (toggle): render the primary key as sticky section headers instead of a sort axis; parents still nest inside each section. Secondary key orders within the section. This covers the "grouped correspondingly" half of the request without forcing grouping as the only mode.

### Persistence (later)

Sort preference (primary/secondary key + direction, group on/off) should persist **per tracker** so a Linear-vs-GitHub choice is remembered. v1 prototype keeps it in component state; productionizing means a small `settings-store` slice (client) — no server round-trip needed.

## Data model changes

`TrackerIssue` (`src/server/shared/types/domain-types.ts`) gains:

```ts
parentId?: string;        // tracker-internal id of the parent issue, when nested
parentIdentifier?: string; // human id ("SHI-90") — for the orphan hint without a second fetch
hasChildren?: boolean;    // hint so a leaf needs no children probe (Linear exposes children count)
```

**Adapters:**
- **Linear** (`trackers/linear/adapter.ts`): the issue query already can select `parent { id identifier }`; map it onto `parentId`/`parentIdentifier`. `children` count → `hasChildren`. The 100-issue cap means orphan promotion must be handled client-side (a parent can fall outside the window).
- **GitHub** (`trackers/github/`): GitHub's native **sub-issues** (GA 2024) expose parent/child via the REST `sub_issues` endpoints / GraphQL `parent`. Where available, map them; where not (older repos, task-list-only relationships), every issue is parentless and the list degrades to today's flat behavior. **No task-list-markdown parsing** — too lossy.

## Sorting surface

- The fixed sort in `services/issues.ts` becomes a **default**, with the real ordering applied client-side from the sort prefs (the full list is already in the client for filtering — `issues` vs `filteredIssues`). Keeping sort client-side avoids a refetch per sort change and reuses the loaded set.
- Build the parent→children tree from the flat `filteredIssues` after filtering, so filters and sort compose. A filtered-out parent with surviving children triggers orphan promotion.

## Key files (to touch when implemented)

- `src/server/shared/types/domain-types.ts` — `parentId` / `parentIdentifier` / `hasChildren` on `TrackerIssue`.
- `src/server/orchestrator/trackers/linear/adapter.ts` — select + map `parent`.
- `src/server/orchestrator/trackers/github/*` — map native sub-issues when present.
- `src/client/components/IssuesViewer.tsx` — tree build, disclosure rows, indentation, orphan hint.
- `src/client/components/IssuesSortControl.tsx` *(new)* — the two-dropdown sort bar.
- `src/client/components/issues-sort.ts` *(new)* — comparator + tree-builder (unit-tested).
- `src/client/stores/settings-store.ts` — persisted per-tracker sort prefs (later).
- `src/server/shipit-docs/issues.md` — note that `shipit issue view` surfaces parent/children (agent-facing).

## Open questions

- Deep nesting (>1 level): flatten-to-one or true recursion? Defer until data warrants.
- Should "Group by primary" persist independently of the sort axis, or is it mutually exclusive with using that key as a sort key? Prototype treats group as an overlay on the existing primary selection.
- GitHub: is the sub-issues API reliably present for our users' repos, or do we hide nesting on the GitHub tab until confirmed?
