# 161 — Checklist

## Part 1 — Listing decoupled from disk
- [ ] Add `diskTier` (`hot|light|evicted`), `userArchived`, `lastViewedAt` columns
- [ ] Add `diskTier` / `userArchived` / `lastViewedAt` to `SessionInfo` (`domain-types.ts`)
- [ ] Migration: split `archived` by `merged_at` (unmerged→`userArchived=1`; merged→`userArchived=0`); both `diskTier='evicted'`
- [ ] Reassign every `archived` consumer per the data-model table (visibility=`userArchived` vs disk-present=`diskTier`); **fix `findAllByRemoteUrl` cache-retention to count `evicted` sessions**
- [ ] Flip `SessionManager.list()` off `archived` onto the `visibleInSidebar` predicate
- [ ] Implement `reopenedAfterMerge` as `Date.parse(lastUsedAt) > Date.parse(mergedAt)` **in JS, not SQL** (format-incompatible columns); plus top-N merged view cap in the service layer
- [ ] Make `markMergedAndPruneExcess` a *listing* prune (no `fs.rm`), not a disk prune
- [ ] Sidebar grouping: Active vs Recently merged; restore-on-select for non-`hot` sessions
- [ ] Reflect `diskTier` in `AllSessionsDialog`

## Part 2 — Disk cleanup tiers (no new cron)
- [ ] Bump a **separate `lastViewedAt`** on viewer attach (NOT `lastUsedAt` — that would corrupt `reopenedAfterMerge`); disk-idle age = `max(lastUsedAt, lastViewedAt)`
- [ ] `container stop`: keep on existing idle-container enforcer (`docs/063`, cap-driven, event-driven) — no change to its trigger
- [ ] Add tier-escalation logic to `disk-janitor.ts`: `hot → light` after `IDLE_LIGHT`, `light → evicted` after `IDLE_EVICT`, by `lastUsedAt` age
- [ ] Invoke the escalation pass **async, after each session start** (never on the start path — no added start latency); this is the primary steady-state reclaim since prod deploys manually
- [ ] Correct the `disk-janitor.ts` docstring's stale "auto-deploys on push / startup is frequent" claim — prod is manually deployed, so startup-only is insufficient; tier escalation is the one steadily-accumulating item
- [ ] `hot → light` effect: drop `node_modules`/build via compose volume removal; keep checkout
- [ ] `light → evicted` effect: existing workspace `fs.rm` path
- [ ] Disk-pressure pass: LRU escalation between low/high water marks, checked on-demand (no timer), guards still apply
- [ ] Remove disk reclamation from the merge path — merge becomes listing-only (no `fs.rm`)
- [ ] Define constants (`IDLE_LIGHT`, `IDLE_EVICT`, `DISK_FREE_LOW/HIGH`) next to `MAX_MERGED_SESSIONS_PER_REPO`
- [ ] Guards: not-running, no-attached-viewer, clean-tree before `evicted`
- [ ] `light → evicted` dirty-tree remediation runs git on the **on-disk checkout** via `simpleGit(workspaceDir)` (container is stopped); skip eviction if `git push origin` fails (keep local commit at `light`)
- [ ] Preserve parent/child breadcrumb guards
- [ ] User-archive action: `userArchived = true` + `evicted` cleanup, cascade to children

## Part 3 — Restore freshness
- [ ] `evicted` restore forces a fresh fetch (`fetchCache(ttlMs = 0)`); contract is "fetch ran + didn't error", NOT "HEAD advanced" (unchanged HEAD is normal)
- [ ] Separate fetch from clone in the retry loop: failed fetch → fall through to clone-from-cache + staleness warning (don't abort restore); clone errors keep their 3× retry
- [ ] Base restored branch on freshly-fetched `origin/<defaultBranch>`
- [ ] `light` restore reinstalls deps, preserves branch + checkout + uncommitted work

## Tests
- [ ] Unit: `visibleInSidebar` / `reopenedAfterMerge` predicate cases
- [ ] Integration: merged session reopened (new turn) reappears in `list()`
- [ ] Integration: auto-prune demotes from sidebar without wiping workspace
- [ ] Integration: guards block destructive descent for running/open/dirty sessions
- [ ] Integration: `evicted` restore branch tip equals current `origin/main` tip
- [ ] Migration test: existing `archived` rows map to `userArchived` + `evicted`
