# Checklist — nested issues + two-level sorting

Status: **implemented.** Prototype + design landed first; the production code is now in place (client-side sort/nesting + Linear `parent` mapping).

- [x] Interactive prototype (`mockup.html`) — recursive nesting, two-level sort, orphan promotion, modal editor, mobile indent-only cards
- [x] Design doc (`plan.md`) with data-model + sorting decisions (deep nesting, GitHub-flat, modal — all confirmed)
- [x] Add `parentId` / `parentIdentifier` / `updatedAt` to `TrackerIssue` (`domain-types.ts`)
- [x] Linear adapter: select + map `parent { id identifier }` and `updatedAt`
- [x] GitHub adapter: **no change** — stays flat (no parent data)
- [x] `issues-sort.ts`: comparator (primary → secondary → identifier) + **recursive** tree builder + orphan promotion + cycle guard + grouping (`issues-sort.test.ts`, 18 cases)
- [x] `IssuesSortModal.tsx`: sliders icon → modal with two-level sort + group-by
- [x] Sliders icon in the top bar with dirty dot + active-order tooltip
- [x] `IssuesViewer.tsx` (table): recursive disclosure rows, title-cell depth indent, child-count pill, orphan hint
- [x] `IssuesViewer.tsx` (mobile card): collapsible, **default-collapsed** parents with a "N nested issues" toggle; child cards indented 4px/level (cap 3)
- [x] Width-driven layout: `useNarrowContainer` picks narrow (default-collapsed) vs wide (default-expanded) sections at the `@sm` (384px) breakpoint
- [x] Group-by section-header mode (None / Priority / Status / Assignee)
- [x] Persist collapse overrides globally in localStorage (`shipit-issue-collapsed`, `{id: boolean}`; legacy array migrated)
- [x] Persist sort/group prefs globally in localStorage (`shipit-issue-sort`)
- [x] Update `shipit-docs/issues.md` for Linear parent fields in `shipit issue view --json`
- [x] Tests: viewer render (nesting/disclosure/orphan/modal), store persistence, sort-core unit — all green; lint + typecheck clean

Notes / accepted v1 edges:
- Collapse works on **both** layouts: desktop via the disclosure caret (default expanded), mobile/card via the "N nested issues" toggle (default collapsed). One persisted override map drives both; only the untouched default differs by width.
- An explicit toggle is **global across layouts** (collapsing on desktop also reads collapsed on mobile, and vice-versa). Only untouched parents follow the per-layout default. If strict per-layout independence is ever wanted, split the override map in two.
- Sort/group prefs persist globally (not per-tracker) for v1 — a single order across Linear/GitHub. Per-tracker split deferred.
