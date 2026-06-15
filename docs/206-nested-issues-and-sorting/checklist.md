# Checklist — nested issues + two-level sorting

Status: **prototype only.** `mockup.html` + `plan.md` exist; no production code written yet.

- [x] Interactive prototype (`mockup.html`) — nesting, two-level sort, orphan promotion, group-by overlay
- [x] Design doc (`plan.md`) with data-model + sorting decisions
- [ ] Add `parentId` / `parentIdentifier` / `hasChildren` to `TrackerIssue`
- [ ] Linear adapter: select + map `parent` and children count
- [ ] GitHub adapter: map native sub-issues where present; degrade to flat otherwise
- [ ] `issues-sort.ts`: comparator (primary → secondary → identifier) + tree builder + unit tests
- [ ] `IssuesSortControl.tsx`: two-dropdown sort bar with direction toggles
- [ ] `IssuesViewer.tsx`: disclosure rows, indentation, child-count pill, orphan hint
- [ ] Group-by-primary section-header mode
- [ ] Persist per-tracker sort prefs in `settings-store`
- [ ] Update `shipit-docs/issues.md` for parent/children in `shipit issue view`
