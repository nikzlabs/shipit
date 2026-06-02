# Checklist — Tracker-backed priorities (SHI-28)

## Decisions (settled in design)
- [x] Priority removed from docs
- [x] Status also removed from docs (tracker owns work-state)
- [x] Checklist UI kept and promoted to docs grouping key
- [x] Doc↔issue link via `issue:` frontmatter pointer
- [x] Docs list grouped by checklist state (Active vs Done-collapsed)
- [x] Issues view v1 = read + start session (no write-back)
- [x] Top-level Issues tab with one sub-tab per tracker (Linear, GitHub)
- [x] Repo → tracker mapping: hybrid (GitHub from git remote + optional shipit.yaml override; Linear in settings)
- [x] Refresh model: fetch on tab open + manual refresh button (no v1 poller)
- [x] Linear `issue:` pointer: always a full Linear URL

## Open decisions (deferred)
- [ ] Webhook/polling follow-up if fetch-on-open staleness proves insufficient

## Blocking pre-build decision
- [ ] Overturn docs/156's rejection of the in-ShipIt issue picker (amend 156's non-goal + rejected-alternative entries to cross-reference this doc)

## Doc side
- [ ] `markdown.ts`: stop parsing/validating `status` & `priority`
- [ ] `markdown.ts`: parse `issue:` pointer; keep checklist aggregation
- [ ] `domain-types.ts`: drop priority/status from doc surface, add `issue`
- [ ] DocsViewer: remove priority/status UI + sort
- [ ] DocsViewer: checklist-state grouping (Active / Done-collapsed)
- [ ] DocsViewer: linked-issue chip (identifier + priority + status) + jump-to-issue
- [ ] doc-paths.ts: re-base isTracked/hasTrackedSibling/hasTrackedPlanSibling off doc structure, not status (+ update doc-paths.test.ts)
- [ ] Audit all DocStatus/DocPriority/customStatus importers (markdown-frontmatter.ts, MarkdownSelectionComments.tsx, DocsViewer, markdown.ts, tests) so client compiles
- [ ] Delete parseStatusFromFrontmatter + customStatus concept (markdown.ts, domain-types.ts)
- [ ] Migration: parser/type change + field-stripping land together (or strip first) — never leave a half-migrated repo; add `issue:` where applicable
- [ ] Update `CLAUDE.md` design-docs/frontmatter sections
- [ ] Update `src/server/shipit-docs/design-docs.md` frontmatter schema

## Issues side
- [ ] `trackers/tracker.ts` interface (`listIssues`, `getIssue`, id/label)
- [ ] `trackers/registry.ts` (drives sub-tabs)
- [ ] Linear adapter (user OAuth + GraphQL)
- [ ] GitHub Issues adapter (reuse `GitHubAuthManager`)
- [ ] `GET /api/issues?tracker=...` route: GitHub repo from git remote (+ shipit.yaml override), Linear workspace from settings
- [ ] Manual refresh action + fetch-on-tab-open (no background poller)
- [ ] `IssuesViewer.tsx` (tab + sub-tab switcher + priority-sorted list)
- [ ] `issues-store.ts` (per-tracker lists, HTTP + SSE refresh)
- [ ] "Start session" row action → reuse `docs/156` session-from-issue seeding

## Tests
- [ ] `markdown.test.ts`: new frontmatter parsing (issue:, no status/priority)
- [ ] Tracker adapter unit tests (Linear, GitHub) with fakes
- [ ] Integration: `GET /api/issues` listing + auth gating
- [ ] Client: DocsViewer grouping + chip; IssuesViewer rendering
