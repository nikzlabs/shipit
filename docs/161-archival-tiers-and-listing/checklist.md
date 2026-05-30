# 161 — Checklist

## Part 1 — Listing decoupled from disk
- [ ] Add `diskTier` (`hot|light|evicted`) and `userArchived` columns + migration from `archived`
- [ ] Add `diskTier` / `userArchived` to `SessionInfo` (`domain-types.ts`)
- [ ] Flip `SessionManager.list()` off `archived` onto the `visibleInSidebar` predicate
- [ ] Implement `reopenedAfterMerge` (`lastUsedAt > mergedAt`) and top-N merged view cap in the service layer
- [ ] Make `markMergedAndPruneExcess` a *listing* prune (no `fs.rm`), not a disk prune
- [ ] Sidebar grouping: Active vs Recently merged; restore-on-select for non-`hot` sessions
- [ ] Reflect `diskTier` in `AllSessionsDialog`

## Part 2 — Disk cleanup tiers
- [ ] Implement `hot → light` (drop `node_modules`/build via compose volume removal; keep checkout)
- [ ] Implement `light → evicted` (existing workspace `fs.rm` path)
- [ ] Idle ladder triggers (`IDLE_LIGHT`, `IDLE_EVICT`) by `lastUsedAt` age
- [ ] Guards: not-running, no-attached-viewer, no-uncommitted/unpushed-work (auto-commit before `evicted`)
- [ ] Preserve parent/child breadcrumb guards
- [ ] Align `disk-janitor.ts` backstop with the tier model

## Part 3 — Restore freshness
- [ ] `evicted` restore forces a fresh fetch (`fetchCache(ttlMs = 0)`) and asserts HEAD advanced
- [ ] Base restored branch on freshly-fetched `origin/<defaultBranch>`
- [ ] `light` restore reinstalls deps, preserves branch + checkout + uncommitted work
- [ ] Surface a user-visible staleness warning if the restore fetch fails (offline)

## Tests
- [ ] Unit: `visibleInSidebar` / `reopenedAfterMerge` predicate cases
- [ ] Integration: merged session reopened (new turn) reappears in `list()`
- [ ] Integration: auto-prune demotes from sidebar without wiping workspace
- [ ] Integration: guards block destructive descent for running/open/dirty sessions
- [ ] Integration: `evicted` restore branch tip equals current `origin/main` tip
- [ ] Migration test: existing `archived` rows map to `userArchived` + `evicted`
