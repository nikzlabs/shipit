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
- [ ] Single periodic idle-session sweep (extend `docs/063` enforcer): one transition per session per tick, idempotent
- [ ] Bump `lastUsedAt` on viewer attach (so opening a session resets the ladder), in addition to turn start/end
- [ ] `container stop` within `hot` after `IDLE_STOP` (disk untouched)
- [ ] Implement `hot → light` after `IDLE_LIGHT` (drop `node_modules`/build via compose volume removal; keep checkout)
- [ ] Implement `light → evicted` after `IDLE_EVICT` (existing workspace `fs.rm` path)
- [ ] Disk-pressure pass: LRU escalation between low/high water marks, guards still apply
- [ ] Remove disk reclamation from the merge path — merge becomes listing-only (no `fs.rm`)
- [ ] Define constants (`IDLE_STOP`, `IDLE_LIGHT`, `IDLE_EVICT`, `DISK_FREE_LOW/HIGH`) next to `MAX_MERGED_SESSIONS_PER_REPO`
- [ ] Guards: not-running, no-attached-viewer, clean-tree (auto-commit + push before `evicted`)
- [ ] Preserve parent/child breadcrumb guards
- [ ] User-archive action: `userArchived = true` + `evicted` cleanup, cascade to children
- [ ] Align `disk-janitor.ts` startup backstop with the tier model

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
