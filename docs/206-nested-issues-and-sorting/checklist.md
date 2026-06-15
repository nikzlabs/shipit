# Checklist — nested issues + two-level sorting

Status: **prototype only.** `mockup.html` + `plan.md` exist; no production code written yet.

- [x] Interactive prototype (`mockup.html`) — recursive nesting, two-level sort, orphan promotion, modal editor, mobile indent-only cards
- [x] Design doc (`plan.md`) with data-model + sorting decisions (deep nesting, GitHub-flat, modal — all confirmed)
- [ ] Add `parentId` / `parentIdentifier` / `hasChildren` to `TrackerIssue`
- [ ] Linear adapter: select + map `parent` and children count
- [ ] GitHub adapter: **no change** — stays flat (no parent data)
- [ ] `issues-sort.ts`: comparator (primary → secondary → identifier) + **recursive** tree builder + orphan promotion + unit tests
- [ ] `IssuesSortModal.tsx`: sliders icon → modal with two-level sort + group-by; active-order summary + dirty dot
- [ ] `IssuesViewer.tsx` (table): recursive disclosure rows, per-level tree spine, child-count pill, orphan hint
- [ ] `IssuesViewer.tsx` (mobile card): indent-only child cards (4px/level, cap 3) + left rule, no tree affordances
- [ ] Group-by section-header mode (None / Priority / Status / Assignee)
- [ ] Persist collapse state globally in localStorage (keyed by issue id; not session/repo scoped)
- [ ] Persist per-tracker sort/group prefs in `settings-store`
- [ ] Update `shipit-docs/issues.md` for Linear parent/children in `shipit issue view`
