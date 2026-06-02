# Checklist — Tracker-backed priorities (SHI-28)

## Decisions (settled in design)
- [x] Priority removed from docs
- [x] Status also removed from docs (tracker owns work-state)
- [x] Checklist UI kept and promoted to docs grouping key
- [x] Doc↔issue link via `issue:` frontmatter pointer
- [x] Docs list grouped by checklist state (Active vs Done-collapsed)
- [x] Issues view v1 = read + start session (no write-back)
- [x] Top-level Issues tab with one sub-tab per tracker (Linear, GitHub)

## Open decisions (before build)
- [ ] Repo → tracker mapping config location (shipit.yaml vs settings)
- [ ] Issue refresh cadence (poll vs webhook vs SSE)
- [ ] Linear `issue:` pointer disambiguation across teams/workspaces

## Doc side
- [ ] `markdown.ts`: stop parsing/validating `status` & `priority`
- [ ] `markdown.ts`: parse `issue:` pointer; keep checklist aggregation
- [ ] `domain-types.ts`: drop priority/status from doc surface, add `issue`
- [ ] DocsViewer: remove priority/status UI + sort
- [ ] DocsViewer: checklist-state grouping (Active / Done-collapsed)
- [ ] DocsViewer: linked-issue chip (identifier + priority + status) + jump-to-issue
- [ ] Migration: strip inert `status`/`priority` from existing docs, add `issue:` where applicable
- [ ] Update `CLAUDE.md` design-docs/frontmatter sections
- [ ] Update `src/server/shipit-docs/design-docs.md` frontmatter schema

## Issues side
- [ ] `trackers/tracker.ts` interface (`listIssues`, `getIssue`, id/label)
- [ ] `trackers/registry.ts` (drives sub-tabs)
- [ ] Linear adapter (user OAuth + GraphQL)
- [ ] GitHub Issues adapter (reuse `GitHubAuthManager`)
- [ ] `GET /api/issues?tracker=...` route + per-repo mapping resolution
- [ ] `IssuesViewer.tsx` (tab + sub-tab switcher + priority-sorted list)
- [ ] `issues-store.ts` (per-tracker lists, HTTP + SSE refresh)
- [ ] "Start session" row action → reuse `docs/156` session-from-issue seeding

## Tests
- [ ] `markdown.test.ts`: new frontmatter parsing (issue:, no status/priority)
- [ ] Tracker adapter unit tests (Linear, GitHub) with fakes
- [ ] Integration: `GET /api/issues` listing + auth gating
- [ ] Client: DocsViewer grouping + chip; IssuesViewer rendering
