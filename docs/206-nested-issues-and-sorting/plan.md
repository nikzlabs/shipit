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
- **Parents own a disclosure + child-count pill.** A parent shows a rotate-on-collapse triangle and a `N` pill; children indent with a tree spine per level. Collapse state is client-side (per session, not persisted in v1).
- **Recursive — arbitrary depth.** Nesting recurses to any depth (decision: confirmed). Each level adds one indent step + tree spine; collapsing any node hides its whole subtree. The tree is built from the flat `filteredIssues` by walking `parentId` links, so depth is whatever the data declares.
- **Collapse state persists globally.** Collapsing a parent is saved to **localStorage**, keyed by issue id, **not scoped to a session or repo** (decision: confirmed) — the issue list itself isn't session- or repo-scoped, so its collapse state shouldn't be either. The tree stays as the user left it across reloads and across sessions. (Client-only; no server round-trip.)
- **Mobile (card layout, below `@sm`) drops the tree.** No disclosure triangles, no tree spines, no collapse/expand. A child card is simply **indented** with a **left rule** as the only nesting hint (decision: confirmed). The indent is deliberately **faint — 4px per level, capped at 3 levels** (decision: confirmed) — so it reads as a hint without eating the narrow column. The card layout already exists in `IssuesViewer` (`@sm` container query).
- **Orphan promotion.** A child whose parent is **not in the current set** (parent is Done and `includeDone` is off, on another team, or beyond the 100-issue fetch cap) is **promoted to the top level** with a `↳ in SHI-300` hint, rather than silently dropped. This is the load-bearing edge case — the fetched window almost never contains every parent. With recursion this applies at any level: a subtree whose root is missing reattaches at the nearest present ancestor, or the top level if none.

### Two-level sorting

- **Primary key, then secondary key, then `identifier` as the final tiebreak.** Each of the two axes has an independent direction toggle (asc/desc). Sort keys: **Priority, Status, Title, Last updated, Assignee**.
- **Status ordering** uses a workflow rank derived from the normalized `status.type` (`triage < backlog < unstarted < started < completed < canceled`), not alphabetical — so "Todo → In Progress → Done" sorts intuitively. Priority uses the existing `priority.sortOrder` (0 urgent … 4 none).
- **Children are sorted within their parent only.** The same comparator orders the sub-issues under each parent, but children are **excluded from the top-level sort** — the top level is ordered by parents (and orphans) alone. A high-priority child never reorders its parent.
- **Independent "Group by"** (None / Priority / Status / Assignee): render the chosen field as sticky section headers; parents still nest inside each section, ordered by the sort keys. With the editor in a modal there's room for grouping to be its **own field** rather than an overlay on the primary sort key.

### Surfacing the editor — modal behind an icon

The toolbar row already holds **search** and **filter** controls (`IssuesFilterBar`), so there's no room for two sort dropdowns + direction toggles + a group select inline (decision: confirmed). Instead:

- A **sliders icon button** sits at the end of the toolbar. Clicking it opens a **modal** with the full editor: *Sort by* (key + Asc/Desc) → *then by* (key + Asc/Desc) → *Group by* (field).
- The icon shows an **accent dot** when the active order differs from the default. The active order ("Priority ↑ → Status ↑") lives in the **icon's hover tooltip** — deliberately **no standing summary row**, so the toolbar stays one line tall (decision: vertical space in the side panel is scarce; the dot is the at-a-glance signal, the tooltip is the on-demand detail).
- Changes apply live; **Done** closes; **Reset to default** restores `priority → identifier`, no grouping.

### Persistence (later)

Sort preference (primary/secondary key + direction, group on/off) should persist **per tracker** so a Linear-vs-GitHub choice is remembered. v1 prototype keeps it in component state; productionizing means a small `settings-store` slice (client) — no server round-trip needed.

## Data model changes

`TrackerIssue` (`src/server/shared/types/domain-types.ts`) gains:

```ts
parentId?: string;         // tracker-internal id of the parent issue, when nested
parentIdentifier?: string; // human id ("SHI-90") — for the orphan hint without a second fetch
updatedAt?: string;        // ISO-8601 last-updated, for the "Last updated" sort key
```

(`hasChildren` was considered but dropped — the tree is built from the loaded
set, so a parent's children are derived from the rows in hand; a separate
"has children outside the window" hint isn't used in v1.)

**Adapters:**
- **Linear** (`trackers/linear/adapter.ts`): the issue query already can select `parent { id identifier }`; map it onto `parentId`/`parentIdentifier`. `children` count → `hasChildren`. The 100-issue cap means orphan promotion must be handled client-side (a parent can fall outside the window).
- **GitHub** (`trackers/github/`): **flat list, no work** (decision: confirmed). We don't surface GitHub parent/child relationships — every issue is parentless and the GitHub tab renders exactly today's flat behavior. No `parentId` mapping, no sub-issues API calls, no task-list parsing. Nesting is a Linear-only capability in this design.

## Sorting surface

- The fixed sort in `services/issues.ts` becomes a **default**, with the real ordering applied client-side from the sort prefs (the full list is already in the client for filtering — `issues` vs `filteredIssues`). Keeping sort client-side avoids a refetch per sort change and reuses the loaded set.
- Build the parent→children tree from the flat `filteredIssues` after filtering, so filters and sort compose. A filtered-out parent with surviving children triggers orphan promotion.

## Key files (as implemented)

- `src/server/shared/types/domain-types.ts` — `parentId` / `parentIdentifier` / `updatedAt` on `TrackerIssue`.
- `src/server/orchestrator/trackers/linear/adapter.ts` — selects + maps `parent { id identifier }` and `updatedAt`.
- GitHub adapter — **unchanged** (flat list; no parent data surfaced).
- `src/client/components/issues-sort.ts` *(new)* — `SortPrefs` types, `compareIssues` (primary → secondary → identifier), `buildIssueTree` (recursive + orphan promotion + cycle guard), `flattenTree`, `groupRoots`, `buildSections`. Unit-tested in `issues-sort.test.ts`.
- `src/client/components/IssuesSortModal.tsx` *(new)* — the sliders-icon-triggered dialog: two-level sort + group-by.
- `src/client/components/IssuesViewer.tsx` — renders `IssueSection[]` with group headers; per-row disclosure + title-cell depth indent (table) and whole-card indent (mobile); orphan hint; sliders button with dirty dot + tooltip.
- `src/client/components/IssuesPanel.tsx` — builds the sections (`buildSections(filteredIssues, sortPrefs, collapsed)`) and wires the sort/collapse store actions.
- `src/client/stores/issues-store.ts` — `sortPrefs` + `collapsed` state, `setSortPrefs` / `toggleCollapsed`, persisted via a store subscription.
- `src/client/utils/local-storage.ts` — `getSavedSortPrefs` / `saveSortPrefs` (`shipit-issue-sort`) + `getSavedIssueCollapsed` / `saveIssueCollapsed` (`shipit-issue-collapsed`), both global.
- `src/server/shipit-docs/issues.md` — notes Linear parent fields in `shipit issue view --json` (agent-facing).

### Implementation notes

- **Sort is client-side** over the already-loaded `filteredIssues`, so changing the order never refetches — the server's priority order is just the default. Filters and sort compose (a filtered-out parent with surviving children triggers orphan promotion).
- **Desktop vs mobile indent** is solved in one reflowing row: the title cell carries the disclosure + a depth-indent (`@sm` only, so table columns stay aligned), while the row's left padding carries the whole-card indent below `@sm` (capped at 3 levels × 4px). The disclosure is desktop-only; collapse is reachable only there (see checklist for the accepted narrow-panel edge).
- **Prefs persist globally** (not per-tracker for v1) — a single order across Linear/GitHub.

## Open questions

- Group-by + deep nesting: do grouped sections only group **top-level** issues (current prototype) — confirmed reasonable, but worth a sanity check on real data.
