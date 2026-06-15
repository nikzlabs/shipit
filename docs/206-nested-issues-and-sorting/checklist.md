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
- [x] `IssuesViewer.tsx` (mobile card): indent-only child cards (4px/level, cap 3), no tree affordances
- [x] Group-by section-header mode (None / Priority / Status / Assignee)
- [x] Persist collapse state globally in localStorage (`shipit-issue-collapsed`, keyed by issue id)
- [x] Persist sort/group prefs globally in localStorage (`shipit-issue-sort`)
- [x] Update `shipit-docs/issues.md` for Linear parent fields in `shipit issue view --json`
- [x] Tests: viewer render (nesting/disclosure/orphan/modal), store persistence, sort-core unit — all green; lint + typecheck clean

Notes / accepted v1 edges:
- Collapse is reachable only via the **desktop** disclosure (mobile/card layout has none, per design). A parent collapsed on desktop then viewed in a very narrow panel stays collapsed with no inline expand — acceptable; widen the panel to expand.
- Sort/group prefs persist globally (not per-tracker) for v1 — a single order across Linear/GitHub. Per-tracker split deferred.
