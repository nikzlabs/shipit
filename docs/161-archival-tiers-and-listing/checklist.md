# 161 — Checklist

## Part 1 — Listing decoupled from disk
- [x] Add `diskTier` (`hot|light|evicted`), `userArchived`, `lastViewedAt` columns (only `hot`/`evicted` wired this slice)
- [x] Add `diskTier` / `userArchived` / `lastViewedAt` to `SessionInfo` (`domain-types.ts`)
- [x] Migration: split `archived` by `merged_at` (unmerged→`userArchived=1`; merged→`userArchived=0`); both `diskTier='evicted'`
- [x] Reassign every `archived` consumer per the data-model table (visibility=`userArchived` vs disk-present=`diskTier`); **fixed `findAllByRemoteUrl` cache-retention to count `evicted` sessions**; `findChildren`→`user_archived`; disk-janitor volume/network/branch sweeps→`listAll()` minus `evicted`
- [x] Flip `SessionManager.list()` off `archived` onto the `filterVisibleInSidebar` predicate
- [x] Implement `reopenedAfterMerge` as `Date.parse(lastUsedAt) > Date.parse(mergedAt)` **in JS, not SQL** (format-incompatible columns); plus top-N merged view cap in `filterVisibleInSidebar`
- [x] Make `markMergedAndPruneExcess` a *listing* prune (no `fs.rm`, no archive, no runner disposal)
- [x] Sidebar grouping: Active vs Recently merged — `RepoGroup` splits top-level broods into an Active group and a demoted "Recently merged" subheader (`isRecentlyMerged` = `mergedAt && !reopenedAfterMerge`, client mirror of the server predicate). A reopened merged session (lastUsedAt > mergedAt) rejoins Active and the sort no longer sinks it.
- [x] Reflect `diskTier` in `AllSessionsDialog` — shared `SessionItem` now renders a `DiskTierBadge` (`light` → "deps cleared", `evicted` → "workspace stored, restores on open"), suppressed on user-archived rows where the archive icon already conveys it. Now meaningful because Part 2's disk-idle ladder can evict without `userArchived`.

## Part 2 — Disk cleanup tiers (no new cron)
- [x] Bump a **separate `lastViewedAt`** on viewer attach (`SessionManager.setLastViewedAt`, called from `attachToRunner` in `index.ts`) — NOT `lastUsedAt`; disk-idle age = `max(lastUsedAt, lastViewedAt)` (`diskIdleAgeMs`)
- [x] `container stop`: kept on existing idle-container enforcer (`docs/063`, cap-driven, event-driven) — no change to its trigger
- [x] Add tier-escalation logic to `disk-janitor.ts` (`escalateDiskTiers`): `hot → light` after `IDLE_LIGHT_MS`, `light → evicted` after `IDLE_EVICT_MS`, by `max(lastUsedAt, lastViewedAt)` age
- [x] Invoke the escalation pass **async, after each session start** (`kickDiskEscalation(sid)` at the tail of `activateSession`; never on the start path) — the primary steady-state reclaim since prod deploys manually
- [x] Correct the `disk-janitor.ts` docstring's stale "auto-deploys on push / startup is frequent" claim — now states prod is manually deployed and that tier escalation lives in `escalateDiskTiers`, not the startup janitor
- [x] `hot → light` effect (`reclaimToLight`): drop `node_modules`/build via compose volume removal (`removeVolumesOnDispose` / `ServiceManager.stop({ removeVolumes: true })` fallback); keep checkout
- [x] `light → evicted` effect (`reclaimToEvicted`): workspace `fs.rm` + container destroy
- [x] Disk-pressure pass (`applyDiskPressure`): LRU escalation between low/high water marks, checked on-demand via `statfsFreeBytes` (no timer), guards still apply
- [x] Remove disk reclamation from the merge path — merge becomes listing-only (no `fs.rm`) — done in Part 1's `markMergedAndPruneExcess`
- [x] Define constants (`IDLE_LIGHT_MS`, `IDLE_EVICT_MS` in `sessions.ts`; `DISK_FREE_LOW/HIGH` via env, threaded through `kickDiskEscalation`) — co-located near `MAX_MERGED_SESSIONS_PER_REPO`
- [x] Guards (`canAutoDescend`): not-running, no-attached-viewer; clean-tree enforced inline before `evicted`
- [x] `light → evicted` dirty-tree remediation runs git on the **on-disk checkout** via `createGitManager(workspaceDir)` (container is stopped); skips eviction if `git push origin` fails (keeps local commit at `light`, reported as `evictBlockedByPush`)
- [x] Parent/child breadcrumbs preserved — the `evicted` rung keeps the session row + `parent_session_id`/metadata and restores via clone, so demotion never orphans a child (no destructive cascade like the old auto-archive)
- [x] User-archive action: `userArchived = true` + `evicted` cleanup, cascade to children — `archiveSession` + `SessionManager.archive` (unchanged, already correct)

## Part 3 — Restore freshness
- [x] `evicted` restore forces a fresh fetch (`fetchCache(ttlMs = 0)`); contract is "fetch ran + didn't error", NOT "HEAD advanced" (unchanged HEAD is normal)
- [x] Separate fetch from clone in the retry loop: failed fetch → fall through to clone-from-cache + staleness warning (don't abort restore); clone errors keep their 3× retry
- [x] Base restored branch on freshly-fetched `origin/<defaultBranch>` (already in place)
- [x] `light` restore reinstalls deps, preserves branch + checkout + uncommitted work — selecting a `light` session flips it back to `hot` in `activateSession`; the normal container boot + `agent.install` / dep-cache path re-materializes `node_modules`

## Tests
- [x] Unit: `filterVisibleInSidebar` / `reopenedAfterMerge` predicate cases (`sessions.test.ts`)
- [x] Unit: `archive`/`unarchive` set `userArchived` + `diskTier`; `listArchived`/`listAll`/`list` semantics
- [x] Unit: `markMergedAndPruneExcess` no longer archives/disposes excess (`session-merge.test.ts`)
- [x] Unit: disk-janitor preserves a hot merged session's branch when it fell out of `list()` (`disk-janitor.test.ts`)
- [x] Integration: merged session reopened (new turn) reappears in `list()` — `sessions.test.ts` drives the full `SessionManager.list()` path (SQL `user_archived=0 AND warm=0` filter + `fromRow` + `filterVisibleInSidebar`): an old merged session beyond the cap is excluded, then bumping `last_used_at` past `merged_at` re-includes it
- [x] Unit: escalation ladder + guards block destructive descent for running/open/recent sessions; dirty-tree push failure keeps a session at `light`; disk-pressure LRU sweep (`disk-tier-escalation.test.ts`)
- [x] Integration: `evicted` restore branch tip equals current `origin/main` tip — `session-restore-freshness.test.ts` runs `unarchiveSession` end-to-end against a real file:// remote + bare cache: the remote advances after the cache is built, and the restored workspace's branch tip and `origin/main` both equal the advanced head (proves `fetchCache(0)` ran before clone and the branch is cut from fresh main)
- [x] Migration semantics covered by archive/unarchive unit tests; disk-janitor tests insert `disk_tier='evicted'` rows directly
