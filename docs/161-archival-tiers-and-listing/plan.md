---
status: planned
priority: high
description: Decouple session *visibility* in the sidebar from *disk reclamation*, replace the single destructive archive with graduated cleanup tiers, and guarantee a restored session is based on fresh origin/main instead of a stale bare-cache snapshot.
---

# 161 — Archival tiers and activity-based session listing

## Problem

Today a single boolean, `archived`, does three unrelated jobs at once:

1. **Hides the session from the sidebar** — `SessionManager.list()` is literally
   `SELECT … WHERE archived = 0 AND warm = 0` (`sessions.ts:70`).
2. **Reclaims all disk for the session** — `archiveSession` destroys the
   container, drops the compose named volumes, and `fs.rm`s the *entire*
   workspace checkout (`services/session.ts:248-344`).
3. **Is triggered automatically** the instant any PR in the repo merges, keeping
   only the 3 most-recently-active merged sessions per repo
   (`markMergedAndPruneExcess`, `services/session.ts:364`,
   `MAX_MERGED_SESSIONS_PER_REPO = 3`).

Because these three are fused, the product behaves badly:

- **Auto-archive breaks live work.** The only guard is `runner.running`
  (`services/session.ts:434`) — an instantaneous boolean. A session that is open
  in a tab, being reviewed, or about to receive a prompt — but with no agent turn
  mid-flight — is fair game. It gets force-disposed and its workspace wiped out
  from under the user.
- **Restore lands in a state nothing like where you left.** Unarchive re-clones
  from the bare cache onto a **new branch**, so `node_modules`, build artifacts,
  and any uncommitted work are gone. The filesystem is unrecognizable.
- **Restore can be based on stale `main`.** The clone is cut from the bare cache,
  and if the cache's fetch is skipped (TTL) or was historically frozen (the
  refspec bug fixed in [[157-session-branch-stale-from-main]]), the restored
  workspace is many commits behind `origin/main` — "some super-old state."
- **Demoting a merged session out of the sidebar requires deleting its disk.**
  The "keep 3 merged" rule is a *view* decision implemented as a *destructive
  disk* operation. There is no way to say "don't clutter my sidebar" without also
  saying "destroy this workspace."

The user's mental model is simple and correct: *the sidebar should reflect where
I'm working; merge is an event, not a tombstone; if I go back to a merged session
to open a follow-up PR, it should re-appear as active.* The current data model
can't express that.

## Design overview

Split the one overloaded flag into **two independent axes**, plus a graduated
cleanup ladder.

| Axis | Question it answers | Driven by | Stored as |
|---|---|---|---|
| **Listing tier** | Does it show in the active sidebar? | activity + merge state | *derived*, not stored |
| **Disk tier** | How much of it is on disk right now? | idle age + guards | `diskTier` column |
| **User-hidden** | Did the user explicitly hide it? | explicit action | `userArchived` column |

The golden rule: **listing tier and disk tier are orthogonal.** A session can be
listed in the sidebar while its disk has been reclaimed (selecting it restores on
demand), and a session can be fully on-disk but not listed (idle merged session
beyond the view cap). Visibility never destroys disk; disk reclamation never
hides a session.

---

## Part 1 — Listing logic (what the sidebar shows)

Listing is a **pure derivation** from session metadata — no new persisted state
beyond what already exists (`mergedAt`, `lastUsedAt`, `userArchived`,
`parentSessionId`). Define, per session:

```
reopenedAfterMerge = mergedAt != null AND lastUsedAt > mergedAt
```

`lastUsedAt` is bumped at **turn start** (and end), so the instant the user sends
a message in a merged session, `reopenedAfterMerge` becomes true. This is the
one-line answer to "I went back to a merged session to start a follow-up PR."

Sidebar visibility predicate (replaces `WHERE archived = 0`):

```
visibleInSidebar(s) =
      !s.userArchived
  AND !s.warm
  AND (
        s.mergedAt == null                       // active, never merged
     OR reopenedAfterMerge(s)                     // merged but worked-in since
     OR isAmongTopMergedForRepo(s, N = 3)         // recent merged, view cap
     )
```

Grouping in the sidebar:

- **Active** — `mergedAt == null` OR `reopenedAfterMerge`. Rendered as today
  (sorted by `lastUsedAt` desc). A reopened merged session rejoins this group
  automatically.
- **Recently merged** — `mergedAt != null AND !reopenedAfterMerge`, top `N` per
  repo by `mergedAt` desc. Rendered in the existing collapsed/demoted position
  (`SessionSidebar.tsx:700`). This is now a **pure view cap** — exceeding it has
  **zero disk consequence**; the overflow simply isn't in the sidebar.
- **Not listed** — everything else. Reachable through the existing
  **All Sessions** dialog (`AllSessionsDialog.tsx`, `/api/sessions/all` →
  `listAll()`), which already shows every non-warm session.

What changes in code:

- `SessionManager.list()` stops filtering on `archived`; it returns sessions
  matching `visibleInSidebar`. The `isAmongTopMergedForRepo` cap is computed in
  the service layer (it needs per-repo ranking, like
  `listMergedNotArchivedByRemoteUrl` does today).
- `diskTier` is **not** consulted for visibility. A disk-evicted session that is
  still recent (e.g. reopened, or within the merged cap) stays in the sidebar and
  restores when selected.

The user explicitly **hiding** a session (`userArchived = true`) is the only
thing that force-removes it from the sidebar regardless of activity — that's the
manual "archive" button, and it's reversible from All Sessions.

---

## Part 2 — Disk cleanup tiers

Replace the single destructive archive with a graduated ladder. Each rung
reclaims more disk and costs more to restore. We only descend when guards pass
(see below).

| Tier | On disk | Container | Reclaims | Restore cost | When |
|---|---|---|---|---|---|
| **`hot`** | full checkout + `node_modules` + build artifacts | may be running/idle | — | none | default / active |
| **`light`** *(new, soft)* | full checkout, **`node_modules` + build artifacts dropped** | stopped | the bulk of the disk (deps dominate) | re-run `agent.install` / restore from dep-cache; **branch, checkout, and uncommitted work preserved** | idle a while, or merged + idle |
| **`evicted`** | **workspace wiped**, restore via clone-from-cache | destroyed | everything | full clone + fetch (today's "archived" cost) | long-idle, or user-archived, or far beyond the merged view cap |

Notes:

- **`light` is the workhorse.** `node_modules` and build output are almost all of
  a session's disk; the source tree is tiny. Dropping them stops the container
  and frees most space while keeping the workspace **recognizable** and
  **uncommitted work intact** — directly fixing "the filesystem looks nothing
  like before." Restore is a dependency reinstall, not a re-clone, so the branch
  and local edits survive.
- **`evicted` is today's behavior**, kept as the final rung for genuinely cold
  sessions and explicit user-archive. It is the only tier that can lose
  uncommitted work, so it sits behind the strongest guards.
- Compose named-volume drop (`removeVolumesOnDispose`,
  `ServiceManager.stop({ removeVolumes: true })`) maps naturally to `light` (the
  declared `node_modules` volumes are exactly what we reclaim). Workspace `fs.rm`
  only happens at `evicted`.

### Cleanup triggers (gentle escalation, by idle age)

Driven by `lastUsedAt` age, **not** by merge events. Merge stops being a
destructive trigger entirely — it only changes ranking/listing.

1. **Container eviction** *(exists today)* — `viewerCount === 0 && !running`
   beyond the idle-container cap (`docs/063`). Stops the container; tier stays
   `hot` on disk.
2. **`hot` → `light`** — after `IDLE_LIGHT` (proposed default ~24h idle) **or**
   when a session is merged-and-idle and falls outside the active group. Cheap,
   reversible, no data loss.
3. **`light` → `evicted`** — after `IDLE_EVICT` (proposed default ~14–30d idle),
   or immediately on explicit user-archive, or when a merged session drops far
   below the view cap *and* has been idle past `IDLE_LIGHT`.
4. **Existing safety-net janitor** (`disk-janitor.ts`,
   `DISK_JANITOR_ARCHIVED_WORKSPACE_DAYS`) remains the backstop for `evicted`
   workspaces that outlive their welcome, plus orphan caches.

(Exact constants are tunable; the structure is the point. Thresholds live next to
`MAX_MERGED_SESSIONS_PER_REPO` so they're discoverable.)

### Guards before any destructive step

Every descent that could surprise the user is gated. **None** of these may be
overridden by an automatic trigger (explicit user-archive may override with a
confirm, but still respects "running"):

- **Not running** — `runnerRegistry.get(id)?.running` is false. *(exists)*
- **No attached viewer** — `viewerCount === 0`. A session open in a tab is in
  use even with no agent turn. *(new — closes the main "breaks live work" gap)*
- **No uncommitted / unpushed work** — the workspace is clean and its branch tip
  is in the bare cache. If dirty, either skip (for `light`/auto) or auto-commit
  to the session branch before `evicted` so nothing is silently lost. *(new)*
- **Not a parent with live children / not an un-merged child** — preserve the
  existing breadcrumb guards (`services/session.ts:441-453`).

`light` is safe enough that it needs only "not running" + "no viewer"; the
dirty-work guard matters most for `evicted`.

---

## Part 3 — Restore must be based on fresh `main`

When a session is selected and needs rehydration:

- **From `light`:** reinstall dependencies (`agent.install`, or restore from
  dep-cache). Keep the existing checkout, branch, and uncommitted edits. Fast and
  non-destructive — nothing else changes.
- **From `evicted`:** re-clone from the bare cache (today's `unarchiveSession`
  path, `services/session.ts:139-207`). **This path must guarantee the restored
  workspace is cut from up-to-date `origin/<defaultBranch>`, not a frozen cache
  snapshot.** Concretely:
  - Force a **fresh fetch** before cloning — do **not** let the 60s TTL skip it
    (`fetchCache(ttlMs = 0)` on the restore path), and assert HEAD advanced (the
    `readHead()` before/after logging already exists, `repo-git.ts:126`).
  - Base the new branch on the **freshly fetched** `origin/<defaultBranch>`
    (`getDefaultBranch` → `origin/main`), which is exactly the right base for a
    follow-up PR off a merged session.
  - This builds on [[157-session-branch-stale-from-main]] (the refspec fix that
    lets `fetch --all` actually advance `refs/heads/main`). 157 fixed *session
    create*; this doc extends the same guarantee to *restore*, which currently
    relies on a possibly-skipped TTL fetch.

Surfacing: if the fetch fails (offline / GitHub down), restore off the cache with
a **logged, user-visible** staleness warning rather than silently serving old
`main` — same principle as 157's "surface staleness in bootstrap."

---

## Data model changes

- **`diskTier` column** on the session row: `'hot' | 'light' | 'evicted'`,
  default `'hot'`. Replaces the disk meaning of `archived`.
- **`userArchived` column**: boolean, the explicit user "hide this" action.
  Replaces the visibility meaning of `archived`.
- **Migration:** existing `archived = 1` rows → `userArchived = 1`,
  `diskTier = 'evicted'` (they already have no workspace on disk). Existing
  `archived = 0` → `userArchived = 0`, `diskTier = 'hot'`. The old `archived`
  boolean can be derived (`diskTier === 'evicted' && userArchived`) during a
  transition window, then dropped.
- `SessionInfo` (`domain-types.ts:64`) gains `diskTier` and `userArchived`;
  `archived?` is kept read-only/derived until clients migrate.

---

## Why this honors the product principles

- **Inline / stay-on-surface (§1–2):** the sidebar reflects *where you work*, not
  *what GitHub did to a branch*. You never lose a session you're returning to.
- **No data-loss surprise:** demoting a session from the sidebar no longer
  destroys its workspace. Destruction is a separate, guarded, escalating process.
- **Restore fidelity:** `light` restores look like where you left; `evicted`
  restores are based on real, current `main`.

## Smallest first increment

If we land this in slices, the highest-value, lowest-risk first step is
**Part 1 + the `evicted` fetch-fresh fix**, with `diskTier` introduced but only
`hot`/`evicted` wired (i.e. today's two states renamed and decoupled):

1. Add `diskTier` / `userArchived`, migrate, flip `list()` to the activity
   predicate with `reopenedAfterMerge`.
2. Make `markMergedAndPruneExcess` a **listing** prune, not a disk prune — demote
   beyond the cap by listing only, and move disk eviction onto the idle ladder
   with the new guards.
3. Force-fresh fetch on the `evicted` restore path.

`light` (the soft tier) can follow as Part 2 once the decoupling is in place.

## Key files

- `src/server/orchestrator/sessions.ts` — `list()`, `listAll()`,
  `listMergedNotArchivedByRemoteUrl()`, schema/migration.
- `src/server/orchestrator/services/session.ts` — `archiveSession`,
  `unarchiveSession`, `markMergedAndPruneExcess`; new tier transitions + guards.
- `src/server/orchestrator/repo-git.ts` — `fetchCache` (TTL bypass on restore),
  `cloneFromCache`, `getDefaultBranch`, `readHead`.
- `src/server/orchestrator/disk-janitor.ts` — backstop sweep; align with tiers.
- `src/server/orchestrator/service-manager.ts` — volume drop for `light`.
- `src/client/components/SessionSidebar.tsx` — grouping (Active / Recently
  merged), restore-on-select affordance for non-`hot` sessions.
- `src/client/components/AllSessionsDialog.tsx` — unchanged surface for the
  long tail; reflect `diskTier`.
- `src/server/shared/types/domain-types.ts` — `SessionInfo` fields.

## Related

- [[157-session-branch-stale-from-main]] — refspec fix this doc extends to the
  restore path.
- `docs/042-archive-disk-cleanup` — the current archive + disk-janitor design
  this supersedes/extends.
- `docs/063-idle-container-cleanup` — container eviction, the first cleanup rung.
