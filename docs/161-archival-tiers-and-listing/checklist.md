# 161 — Checklist

## Part 1 — Listing decoupled from disk
- [ ] Add `diskTier` (`hot|light|evicted`) and `userArchived` columns + migration from `archived`
- [ ] Add `diskTier` / `userArchived` to `SessionInfo` (`domain-types.ts`)
- [ ] Flip `SessionManager.list()` off `archived` onto the `visibleInSidebar` predicate
- [ ] Implement `reopenedAfterMerge` (`lastUsedAt > mergedAt`) and top-N merged view cap in the service layer
- [ ] Make `markMergedAndPruneExcess` a *listing* prune (no `fs.rm`), not a disk prune
- [ ] Sidebar grouping: Active vs Recently merged; restore-on-select for non-`hot` sessions
- [ ] Reflect `diskTier` in `AllSessionsDialog`

## Part 2 — Disk cleanup tiers (no new cron)
- [ ] Bump `lastUsedAt` on viewer attach (so opening a session resets the ladder), in addition to turn start/end
- [ ] `container stop`: keep on existing idle-container enforcer (`docs/063`, cap-driven, event-driven) — no change to its trigger
- [ ] Add tier-escalation logic to `disk-janitor.ts`: `hot → light` after `IDLE_LIGHT`, `light → evicted` after `IDLE_EVICT`, by `lastUsedAt` age
- [ ] Invoke the same janitor escalation on-demand before session create / container start (lazy reclaim, covers long-uptime boxes without a timer)
- [ ] Update `disk-janitor.ts` docstring: tier escalation is the one steadily-accumulating item, justified by frequent prod restarts + on-demand pass
- [ ] `hot → light` effect: drop `node_modules`/build via compose volume removal; keep checkout
- [ ] `light → evicted` effect: existing workspace `fs.rm` path
- [ ] Disk-pressure pass: LRU escalation between low/high water marks, checked on-demand (no timer), guards still apply
- [ ] Remove disk reclamation from the merge path — merge becomes listing-only (no `fs.rm`)
- [ ] Define constants (`IDLE_LIGHT`, `IDLE_EVICT`, `DISK_FREE_LOW/HIGH`) next to `MAX_MERGED_SESSIONS_PER_REPO`
- [ ] Guards: not-running, no-attached-viewer, clean-tree (auto-commit + push before `evicted`)
- [ ] Preserve parent/child breadcrumb guards
- [ ] User-archive action: `userArchived = true` + `evicted` cleanup, cascade to children

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
