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

## Implementation sequencing (across docs/156, 168, 164)

Dependency graph:

```
156 shared infra ──► 156 P0 (Linear push) ──► 156 P1 (GitHub /shipit push)
   │  (IssueTrackerProvider abstraction, per-deployment app registration,
   │   credential store, webhook endpoint,
   │   headless-sessions.create({issueRef}) seeding)
   │
   └──► 168 (this doc)
          ├─ 168a decoupling  ── no tracker dep, but RELEASES with 168b
          └─ 168b Issues tab  ── needs 156's auth + seeding primitive

164 (user bug filing) ── independent track (reuses existing user GitHub auth)
```

Order:
1. **156 shared infrastructure** — load-bearing base (provider abstraction, app
   registration, credential store, webhook, `headless-sessions.create({issueRef})`).
   Nothing tracker-related ships before this.
2. **156 P0 (Linear push)** — proves the foundation end-to-end on the primary tracker.
3. **168 (ships as one release)** — depends on step 1's auth + seeding; *extends*
   the tracker abstraction with the read/list capability 156 deliberately omitted.
   - **168a** (decoupling) and **168b** (Issues tab) must land together so there's
     never a window with priority gone from docs but no inline "what's next" surface
     (the §1/§2 rule this doc is built on). 168a is buildable in parallel with steps
     1–2 but is *released* with 168b.
4. **156 P1 (GitHub /shipit push)** — independent of 168; needs only step 1. Can run
   in parallel with step 3.
5. **164 (user bug filing)** — lowest coupling, lower priority (medium). Reuses
   ShipIt's existing user GitHub auth, not 156's webhook App, so parallelizable
   throughout; sequenced last by priority, not dependency.

Notes:
- 168's **GitHub issue listing** uses existing user GitHub auth, so the GitHub
  sub-tab works before 156 P1 exists; only the **Linear** half needs step 1's
  Linear app registration.
- The only hard serialization is **156-infra → 168**. Critical path:
  156 infra → 156 P0 → 168.

## Open decisions (deferred)
- [ ] Webhook/polling follow-up if fetch-on-open staleness proves insufficient

## Settled pre-build decisions
- [x] Overturn docs/156's rejection of the in-ShipIt issue picker — confirmed by the user; docs/156 non-goals, rejected-alternative entry, and "Push, not pull" section amended to cross-reference this doc

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
