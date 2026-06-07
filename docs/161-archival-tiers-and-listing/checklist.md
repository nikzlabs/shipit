# 161 — Checklist

## Part 1 — Listing decoupled from disk
- [x] Add `diskTier` (`hot|light|evicted`), `userArchived`, `lastViewedAt` columns (only `hot`/`evicted` wired this slice)
- [x] Add `diskTier` / `userArchived` / `lastViewedAt` to `SessionInfo` (`domain-types.ts`)
- [x] Migration: split `archived` by `merged_at` (unmerged→`userArchived=1`; merged→`userArchived=0`); both `diskTier='evicted'`
- [x] Reassign every `archived` consumer per the data-model table (visibility=`userArchived` vs disk-present=`diskTier`); **fixed `findAllByRemoteUrl` cache-retention to count `evicted` sessions**; `findChildren`→`user_archived`; disk-janitor volume/network/branch sweeps→`listAll()` minus `evicted`
- [x] Flip `SessionManager.list()` off `archived` onto the `filterVisibleInSidebar` predicate
- [x] Implement `reopenedAfterMerge` as `Date.parse(lastUsedAt) > Date.parse(mergedAt)` **in JS, not SQL** (format-incompatible columns); plus top-N merged view cap in `filterVisibleInSidebar`
- [x] Make `markMergedAndPruneExcess` a *listing* prune (no `fs.rm`, no archive, no runner disposal)
- [x] Sidebar grouping: Active vs Recently merged — `RepoGroup` splits top-level broods into an Active group and a demoted "Recently merged" subheader (`isRecentlyMerged` = `mergedAt && !reopenedAfterMerge`, client mirror of the server predicate). A reopened merged session rejoins Active and the sort no longer sinks it.
- [x] **Refine `reopenedAfterMerge` to key on branch advance, not `lastUsedAt`** — a no-op post-merge turn (answering a question, spawning a child) bumped `lastUsedAt` and falsely floated a merged session (and its merged children, grouped by parent status) back to Active. Added persisted `last_branch_commit_at`, stamped by `postTurnCommit`→`SessionManager.markBranchAdvanced` whenever a turn moves HEAD; predicate now compares it (server + client mirror) to `mergedAt`. Column not backfilled (would reproduce the bug). Coverage: predicate cases incl. "no-op turn bumps lastUsedAt but branch did not advance" (`sessions.test.ts`), client grouping cases (`SessionSidebar.test.tsx`), and the `list()` round-trip below.
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

## Part 2.1 — Turn on the pressure valve + merge-aware eviction (prod hit 100% disk)
- [x] Portable watermarks: `DISK_FREE_LOW_PCT` / `DISK_FREE_HIGH_PCT` (fractions of total disk) resolved at startup via `statfsTotalBytes` (`total = blocks × bsize`); `resolveDiskWatermarks` resolves each mark independently with `*_BYTES` taking precedence — backward compat preserved, override still no-ops unless both marks resolve
- [x] Merge-aware `light → evicted`: branch on `mergedAt` — merged → `IDLE_EVICT_MERGED_MS` (2d default), unmerged → `IDLE_EVICT_MS` (14d, unchanged); idle age stays `max(lastUsedAt, lastViewedAt)`; all guards + auto-commit/push-before-wipe unchanged (reclaim-only)
- [x] `DISK_IDLE_EVICT_MERGED_MS` wired through `index.ts` (`parseFloat || undefined`) and defaulted in `sessions.ts` (`IDLE_EVICT_MERGED_MS`)
- [x] Wired into prod: `deployment/vps/docker-compose.yml` sets `DISK_FREE_LOW_PCT=0.10`, `DISK_FREE_HIGH_PCT=0.20`, `DISK_IDLE_EVICT_MERGED_MS=172800000`; `DISK_IDLE_EVICT_MS` left at 14d default
- [x] Unit: `resolveDiskWatermarks` (`*_BYTES` precedence, `*_PCT × total` derivation, neither set → disabled, pct + unknown total → disabled); merge-aware eviction (merged past threshold evicts, unmerged same age does not, merged + recent view protected, merged + dirty committed+pushed before wipe) — `disk-tier-escalation.test.ts`

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
- [x] Integration: merged session reopened reappears in `list()` — `sessions.test.ts` drives the full `SessionManager.list()` path (SQL `user_archived=0 AND warm=0` filter + `fromRow` + `filterVisibleInSidebar`): an old merged session beyond the cap is excluded, a no-op `last_used_at` bump leaves it excluded (the docs/161 follow-up fix), and only stamping `last_branch_commit_at` past `merged_at` re-includes it
- [x] Unit: escalation ladder + guards block destructive descent for running/open/recent sessions; dirty-tree push failure keeps a session at `light`; disk-pressure LRU sweep (`disk-tier-escalation.test.ts`)
- [x] Integration: `evicted` restore branch tip equals current `origin/main` tip — `session-restore-freshness.test.ts` runs `unarchiveSession` end-to-end against a real file:// remote + bare cache: the remote advances after the cache is built, and the restored workspace's branch tip and `origin/main` both equal the advanced head (proves `fetchCache(0)` ran before clone and the branch is cut from fresh main)
- [x] Migration semantics covered by archive/unarchive unit tests; disk-janitor tests insert `disk_tier='evicted'` rows directly
