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

## Part 4 — Collapsible "Recently resolved" + cap bump
- [x] Raise `MAX_MERGED_SESSIONS_PER_REPO` 3 → 5 (`sessions.ts`); cap tests made cap-aware (track the constant, not a literal 3)
- [x] `repo-store`: `collapsedResolved: Set<repoUrl>` + `toggleResolvedCollapsed`, hydrated from / persisted to localStorage (`shipit-collapsed-resolved`), mirroring `collapsedRepos`
- [x] `local-storage.ts`: `get/saveCollapsedResolved`
- [x] `RepoGroup` ("Recently resolved" sub-header → toggle button, caret-next-to-text, full-row hit target; render gate `{!isResolvedCollapsed && resolved}`); expanded by default
- [x] `SessionSidebar` wires `collapsedResolved` / `toggleResolvedCollapsed` into `RepoGroup`
- [x] Placement variants prototyped in `mocks/resolved-collapse-placement.html` (chosen: caret-next-to-text, variant E)
- [x] Tests: sub-section expanded by default; click collapses the resolved rows, flips the toggle to Expand, records per-repo state (`SessionSidebar.test.tsx`)

## Tests
- [x] Unit: `filterVisibleInSidebar` / `reopenedAfterMerge` predicate cases (`sessions.test.ts`)
- [x] Unit: `archive`/`unarchive` set `userArchived` + `diskTier`; `listArchived`/`listAll`/`list` semantics
- [x] Unit: `markMergedAndPruneExcess` no longer archives/disposes excess (`session-merge.test.ts`)
- [x] Unit: disk-janitor preserves a hot merged session's branch when it fell out of `list()` (`disk-janitor.test.ts`)
- [x] Integration: merged session reopened (new turn) reappears in `list()` — `sessions.test.ts` drives the full `SessionManager.list()` path (SQL `user_archived=0 AND warm=0` filter + `fromRow` + `filterVisibleInSidebar`): an old merged session beyond the cap is excluded, then bumping `last_used_at` past `merged_at` re-includes it
- [x] Unit: escalation ladder + guards block destructive descent for running/open/recent sessions; dirty-tree push failure keeps a session at `light`; disk-pressure LRU sweep (`disk-tier-escalation.test.ts`)
- [x] Integration: `evicted` restore branch tip equals current `origin/main` tip — `session-restore-freshness.test.ts` runs `unarchiveSession` end-to-end against a real file:// remote + bare cache: the remote advances after the cache is built, and the restored workspace's branch tip and `origin/main` both equal the advanced head (proves `fetchCache(0)` ran before clone and the branch is cut from fresh main)
- [x] Migration semantics covered by archive/unarchive unit tests; disk-janitor tests insert `disk_tier='evicted'` rows directly

## SHI-294 — blocked eviction (durability of the destructive rung)
- [x] Gate the wipe on a clean tree *after* the remediation attempt, not on `autoCommit`'s returned hash (three null paths, only "nothing to commit" is safe to wipe)
- [x] Also block on a CLEAN checkout with a merge/rebase mid-flight — `autoCommit`'s conflict branch never runs when the tree is clean
- [x] Run the `origin` durability check unconditionally (`tipIsOnOrigin` + push), not only when this pass created a commit — a commit whose push failed leaves a clean tree the next pass would have wiped
- [x] `blocked-by-dirty` outcome + `evictBlockedByDirty` counter, distinct from `blocked-by-push`
- [x] Bound the pin: both blocked outcomes reclaim the regenerable dep caches — `overlay/` upper **and** the `.install-done` marker, which must move together (`reclaimBlockedSessionCaches`) — never the checkout
- [x] Persisted `system_notice` naming the cause (redacted findings / conflicted paths), once per session per process, marked only after the append succeeds (`notifiedEvictBlocked`)
- [x] Key the durability check + push off the CHECKED-OUT branch, never `session.branch` — a detached HEAD pushes a different ref and "succeeds" while HEAD stays local; a detached HEAD is never evictable
- [x] Re-read the row + re-run `canAutoDescend` immediately before BOTH destructive steps — the wipe and the blocked-path cache reclaim (the guards were evaluated before seconds of pacing + git/network work)
- [x] An already-missing checkout is recorded as `evicted` (when a remote can restore it) instead of pinned at `light`, where activation's `light → hot` shortcut 404s the bind-mount
- [x] Tests: each null cause pinned separately — secret refusal, unresolved merge state, clean-tree rebase, the benign nothing-to-commit race (which must still evict), a failed push surviving a SECOND pass, a remote-less session never evicting, warn-once across passes (`disk-tier-escalation.test.ts`, `evict-blocked-notice.test.ts`, `disk-utils.test.ts`)
