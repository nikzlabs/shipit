# 161 — Checklist

## Part 1 — Listing decoupled from disk
- [x] Add `diskTier` (`hot|light|evicted`), `userArchived`, `lastViewedAt` columns (only `hot`/`evicted` wired this slice)
- [x] Add `diskTier` / `userArchived` / `lastViewedAt` to `SessionInfo` (`domain-types.ts`)
- [x] Migration: split `archived` by `merged_at` (unmerged→`userArchived=1`; merged→`userArchived=0`); both `diskTier='evicted'`
- [x] Reassign every `archived` consumer per the data-model table (visibility=`userArchived` vs disk-present=`diskTier`); **fixed `findAllByRemoteUrl` cache-retention to count `evicted` sessions**; `findChildren`→`user_archived`; disk-janitor volume/network/branch sweeps→`listAll()` minus `evicted`
- [x] Flip `SessionManager.list()` off `archived` onto the `filterVisibleInSidebar` predicate
- [x] Implement `reopenedAfterMerge` as `Date.parse(lastUsedAt) > Date.parse(mergedAt)` **in JS, not SQL** (format-incompatible columns); plus top-N merged view cap in `filterVisibleInSidebar`
- [x] Make `markMergedAndPruneExcess` a *listing* prune (no `fs.rm`, no archive, no runner disposal)
- [ ] Sidebar grouping: Active vs Recently merged (deferred — sidebar content unchanged this slice; restore-on-select handled in `AllSessionsDialog`, extended to cover `diskTier === 'evicted'`)
- [ ] Reflect `diskTier` in `AllSessionsDialog` (deferred — in this slice every `evicted` session is also `userArchived`, so the existing archived UI is equivalent)

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
- [x] `evicted` restore forces a fresh fetch (`fetchCache(ttlMs = 0)`); contract is "fetch ran + didn't error", NOT "HEAD advanced" (unchanged HEAD is normal)
- [x] Separate fetch from clone in the retry loop: failed fetch → fall through to clone-from-cache + staleness warning (don't abort restore); clone errors keep their 3× retry
- [x] Base restored branch on freshly-fetched `origin/<defaultBranch>` (already in place)
- [ ] `light` restore reinstalls deps, preserves branch + checkout + uncommitted work (Part 2)

## Tests
- [x] Unit: `filterVisibleInSidebar` / `reopenedAfterMerge` predicate cases (`sessions.test.ts`)
- [x] Unit: `archive`/`unarchive` set `userArchived` + `diskTier`; `listArchived`/`listAll`/`list` semantics
- [x] Unit: `markMergedAndPruneExcess` no longer archives/disposes excess (`session-merge.test.ts`)
- [x] Unit: disk-janitor preserves a hot merged session's branch when it fell out of `list()` (`disk-janitor.test.ts`)
- [ ] Integration: merged session reopened (new turn) reappears in `list()` (deferred)
- [ ] Integration: guards block destructive descent for running/open/dirty sessions (Part 2)
- [ ] Integration: `evicted` restore branch tip equals current `origin/main` tip (deferred)
- [x] Migration semantics covered by archive/unarchive unit tests; disk-janitor tests insert `disk_tier='evicted'` rows directly
