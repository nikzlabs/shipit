---
description: Decouple session *visibility* in the sidebar from *disk reclamation*, replace the single destructive archive with graduated cleanup tiers, and guarantee a restored session is based on fresh origin/main instead of a stale bare-cache snapshot.
---

# 161 — Archival tiers and activity-based session listing

> **Status note (Parts 1–3 shipped):** Part 1 (listing decoupled from disk),
> Part 2 (the disk-idle escalation ladder), and Part 3 (fresh-fetch restore) are
> implemented. `markMergedAndPruneExcess` is listing-only (no `fs.rm`, no
> auto-archive); demotion out of the sidebar is the `filterVisibleInSidebar`
> predicate's job. The full `hot → light → evicted` ladder now exists
> (`escalateDiskTiers` in `disk-janitor.ts`): `hot → light` drops the
> per-session `node_modules`/build volumes while keeping the checkout, and
> `light → evicted` wipes the workspace (after auto-commit + push remediation of
> a dirty tree). The pass is fired async after each session activation
> (`kickDiskEscalation` in `index.ts`), never on the start path, and folds in a
> disk-pressure LRU sweep. A `light` session restores by simply being selected
> (`activateSession` flips it back to `hot`; the normal `agent.install` /
> dep-cache path re-materializes deps). The sidebar-grouping /
> `AllSessionsDialog` UI polish has now landed too: `RepoGroup` splits each
> repo's sessions into an **Active** group and a demoted **Recently merged**
> subheader (a reopened merged session rejoins Active), and `SessionItem`
> surfaces a `DiskTierBadge` for non-`hot` tiers so an `evicted`-but-listed
> session reads as "restores on open." The two previously-deferred integration
> tests (reopened-reappears-in-`list()`, and `evicted`-restore-cut-from-fresh-
> `origin/main`) are now in place too — see `checklist.md`.

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
reopenedAfterMerge = mergedAt != null
                     AND Date.parse(lastUsedAt) > Date.parse(mergedAt)
```

**Evaluate in JS, not SQL.** `merged_at` and `last_used_at` are stored in
*incompatible* string formats — `markMerged` writes `datetime('now')`
(`"YYYY-MM-DD HH:MM:SS"`, space-separated, no zone) while `track`/`markStarted`
write `toISOString()` (`"YYYY-MM-DDThh:mm:ss.sssZ"`). A lexical/SQL `>` is wrong:
`'T'` (0x54) > `' '` (0x20), so an ISO `lastUsedAt` at the *same* wall-clock
second as `mergedAt` always sorts greater, falsely marking a never-reopened
just-merged session as reopened. Parse both with `Date.parse` — exactly what the
existing `activityMs` helper does (`services/session.ts:418-419`, which documents
this same hazard).

`lastUsedAt` is bumped at **turn start** (and end) — and **only** by turn
activity, never by merely opening the session (see Part 2: a separate
`lastViewedAt` drives the disk-idle clock). So `reopenedAfterMerge` becomes true
the instant the user *sends a message* in a merged session — not when they just
click in to look — which is the precise answer to "I went back to a merged
session to start a follow-up PR." Listing the session for a passive view would
strand it in Active forever.

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
  - **The top-N ranking includes user-archived merged sessions** (then drops
    them from the result). An archived merged session keeps occupying its
    chronological slot, so manually archiving one of the N visible merged
    sessions lowers the visible count to N-1 instead of pulling a previously
    demoted session up into the freed slot — which read as "archiving did
    nothing, it's always 3." The slot self-heals: as newer PRs merge, they push
    the archived session past rank N and the cap fills back up with fresh merges.
    `filterVisibleInSidebar` therefore receives archived rows (`list()` only
    filters `warm`) and excludes them via its own `!userArchived` guard.
- **Not listed** — everything else. Reachable through the existing
  **All Sessions** dialog (`AllSessionsDialog.tsx`, `/api/sessions/all` →
  `listAll()`), which already shows every non-warm session.

Within-group ordering (`SessionSidebar.tsx` `repoGroups` comparator): the
per-repo sort uses `archived || userArchived` as the **primary** key so an
archived row never sits above a live one — live > merged > archived. Because the
parent/child renderer (`childrenByParent` in `RepoGroup`) buckets a parent's
children in this same sorted order, the archived-primary key also sinks archived
children below their live siblings *within a parent's brood*. (The Active vs
Recently-merged visual split is rendered as two separate blocks, so a — rare —
archived-but-unmerged session still sinks to the bottom of the Active block
rather than below the Recently-merged block; archived sidebar rows are in
practice also merged, so they share and sink within the Recently-merged group.)

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

**Parent/child clusters are exempt from the merged cap** (docs/117 invariant,
preserved here). The cap is a form of automatic archiving, and a spawned
parent/child cluster must only leave the sidebar via an explicit user archive —
which `archiveSession` cascades from parent to children. So
`filterVisibleInSidebar` never lets the cap demote (a) a session that still has a
live, non-user-archived child, or (b) a child whose parent is still live. The
relationships are derived from `parentSessionId` over the same input list; the
exemption only rescues a session the cap would otherwise drop, so user-archiving
(and its cascade) is unaffected. This restores behavior that originally lived as
explicit guards in `markMergedAndPruneExcess` and was dropped when listing moved
to this predicate.

---

## Part 2 — Disk cleanup tiers

Replace the single destructive archive with a graduated ladder. Each rung
reclaims more disk and costs more to restore. We only descend when guards pass
(see below).

| Tier | On disk | Container | Reclaims | Restore cost | When |
|---|---|---|---|---|---|
| **`hot`** | full checkout + `node_modules` + build artifacts | may be running/idle | — | none | default / active |
| **`light`** *(new, soft)* | full checkout, **`node_modules` + build artifacts dropped** | stopped | the bulk of the disk (deps dominate) | re-run `agent.install` / restore from dep-cache; **branch, checkout, and uncommitted work preserved** | idle ≥ `IDLE_LIGHT`, or disk-pressure |
| **`evicted`** | **workspace wiped**, restore via clone-from-cache | destroyed | everything | full clone + fetch (today's "archived" cost) | idle ≥ `IDLE_EVICT`, disk-pressure, or user-archive |

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

### What is *not* a trigger

- **Merge is never a disk trigger.** Detecting a merged PR only updates
  `mergedAt` (and deletes the remote head branch, as today). It changes
  *listing*, never *disk*. A just-merged session stays `hot` on disk until it
  goes idle like any other session. This is the core fix for "merge wiped my
  workspace."
- **The merged view cap (`MAX_MERGED_SESSIONS_PER_REPO`) is never a disk
  trigger.** Falling outside the top-N only removes a session from the sidebar;
  its disk follows the same idle ladder as everything else.
- **WebSocket disconnect / browser close is never a trigger.** Per the
  WS-lifecycle invariant in `CLAUDE.md`, a socket close only calls
  `detachFromRunner()` (decrements `viewerCount`). It starts the *grace clock*
  for container stop but never directly changes a disk tier.

### No new cron — reuse the two triggers we already have

We deliberately do **not** add a new periodic sweep. Every transition hangs off a
mechanism that already exists, so there is no extra timer to own:

1. **The idle-container enforcer** *(`docs/063`, event-driven)* — already fires on
   viewer disconnect and agent-finish when the idle-container cap is exceeded. It
   owns the **container stop** rung.
2. **`disk-janitor.ts`** *(runs once at orchestrator startup)* — already the home
   for all other disk reclamation. It owns the **`hot → light`** and
   **`light → evicted`** escalations, evaluated by `lastUsedAt` age, exactly like
   it already prunes caches by `last_used_at`.
3. **User actions / session select** *(event-driven)* — own archive and restore.

"Idle age" for the disk ladder means `now - max(Date.parse(lastUsedAt),
Date.parse(lastViewedAt))`. `lastUsedAt` tracks **turn activity only** (it must
stay that way — Part 1's `reopenedAfterMerge` predicate keys on it, and a
viewer-attach bump there would promote a merely-opened merged session to Active
forever). To keep "don't escalate a session I just had open" working without
corrupting that predicate, **viewer attach bumps a separate `lastViewedAt`
column** that *only* the disk ladder reads. The "no attached viewer" guard
already prevents escalating a currently-open session; `lastViewedAt` additionally
keeps a recently-closed one warm.

### Consequence of janitor-cadence escalation (read before accepting)

Tier escalation is the **one** disk task that accumulates *steadily* — unlike the
janitor's existing items, which only exist when an earlier teardown crashed (see
its docstring: "None of them accumulate steadily").

**Important: prod does *not* auto-deploy on push — deploys are triggered
manually.** (The current `disk-janitor.ts` docstring claims "ShipIt's prod box
auto-deploys on push (so startup is frequent in practice)" — that assumption is
stale and must be corrected when this lands.) So a startup-only janitor can go a
long time between runs on prod, and idle `node_modules` would pile up unbounded in
the meantime. **Startup-only is therefore not sufficient by itself** — the
on-demand pass below is the *primary* steady-state reclaim, not a long-uptime
fallback. The startup run remains as the post-(unclean-)restart safety net.

**On-demand trigger — *after* session start, asynchronously.** When a session is
started/activated, kick the same age-based escalation pass **after** the session
is up and the user has control — never on the start path itself, so we don't add
latency to session start. It's a fire-and-forget background pass (reads the DB +
a `statfs`, applies guarded transitions to *other* idle sessions). Rationale:
starting a session is exactly when we consume disk, so it's the natural moment to
reclaim from the long idle tail — but the reclaim must not block the thing the
user is waiting for. No cron, no added start latency. If sustained pressure ever
outpaces this, promoting the pass to a real timer is a later, isolated change —
but we start cron-free per the explicit decision.

### The transitions

Each row: the move, the **trigger**, the **condition**, the **guards** (all must
pass), and the **effect**.

| Move | Trigger | Condition | Guards | Effect |
|---|---|---|---|---|
| **container running → stopped** *(within `hot`)* | idle-container enforcer (`docs/063`, event-driven) | idle-container cap exceeded | not running; `viewerCount === 0` | dispose runner / stop container; **disk untouched**, deps preserved, instant restart |
| **`hot` → `light`** | disk-janitor pass (startup safety-net + **async after each session start**) | idle ≥ `IDLE_LIGHT` (~24h), **or** disk-pressure pass selects it (LRU) | not running; `viewerCount === 0` | `ServiceManager.stop({ removeVolumes: true })` — drop `node_modules`/build volumes; keep checkout, branch, uncommitted edits; `diskTier = light` |
| **`light` → `evicted`** | disk-janitor pass (startup + async after session start) | idle ≥ `IDLE_EVICT` (~14–30d), **or** disk-pressure pass selects it (LRU) | not running; `viewerCount === 0`; **clean tree** (else auto-commit + push first) | `fs.rm` workspace; destroy container; `diskTier = evicted` |
| **any tier → `evicted` + `userArchived`** | explicit user "Archive" action | user clicked archive | not running (else confirm/decline); dirty tree → auto-commit + push first | `userArchived = true`; run the `evicted` cleanup; cascade to children (existing) |
| **`light` → `hot`** | user selects / messages the session | — | — | reinstall deps (`agent.install` / dep-cache); start container; `diskTier = hot`. Branch + checkout + uncommitted work intact |
| **`evicted` → `hot`** | user selects / messages the session (incl. unarchive) | — | — | force-fresh fetch + clone-from-cache, new branch off current `origin/main` (Part 3); `diskTier = hot` |

**Disk-pressure pass.** Folded into the same janitor logic: when the async
after-start pass observes free disk below a low-water mark (a `statfs`, not a
timer), it escalates the **least-recently-used** eligible sessions (`hot → light`,
then `light → evicted`) until free space crosses a high-water mark — regardless of
whether they've hit `IDLE_LIGHT` / `IDLE_EVICT`. Keeps the time thresholds
generous while still reclaiming under pressure. Guards still apply.

### Guards (the gate every automatic descent passes)

A transition's guard column above references these. **No automatic trigger may
override them.** Explicit user-archive may override "no viewer" and (with a
confirm) "running", but still auto-commits dirty work rather than losing it.

- **Not running** — `runnerRegistry.get(id)?.running` is false. *(exists today,
  `services/session.ts:434`)*
- **No attached viewer** — `viewerCount === 0`. A session open in a tab is in use
  even with no agent turn mid-flight. *(new — closes the main "auto-archive broke
  my open session" gap)*
- **No uncommitted / unpushed work** — required only for `evicted` (the
  destructive rung); `light` preserves the tree so it skips this guard. *(new)*
  Two implementation details the janitor pass must handle, because at `light` the
  **container is stopped** — there is no worker to run git through:
  - *Evaluate + remediate on the on-disk checkout directly.* A `light` session
    still has its workspace checkout on disk (only `node_modules`/build artifacts
    were dropped), so the janitor operates the git state via `RepoGit` /
    `simpleGit(workspaceDir)` from the orchestrator — the same way it already
    shells git for cache work — not via the (stopped) container. If dirty,
    auto-commit on the session branch, then `git push origin <branch>`.
  - *Durability check must verify `origin`, not the bare cache.* A fresh push
    lands on `origin`; the bare cache only learns the new tip on its next
    `fetchCache` of that branch, so "branch tip present in the bare cache" can be
    **false immediately after a successful push** and would wrongly block (or, if
    skipped, evict before the work is recoverable). The correct gate is **"the
    auto-commit was pushed to `origin` successfully"** (a recoverable state —
    `evicted → hot` re-clones from the cache, which `ensureBareCache` refreshes
    from `origin`). If the push fails (offline / no GitHub auth), **do not
    evict** — leave the session at `light` so the local commit survives on disk.
- **Breadcrumb guards** — not a parent with live children, not an un-merged
  child. Preserve existing logic (`services/session.ts:441-453`).

### Proposed constants (tunable; co-locate with `MAX_MERGED_SESSIONS_PER_REPO`)

| Constant | Meaning | Proposed default |
|---|---|---|
| `maxIdleContainers` | container-stop cap (exists, `docs/063`) | 5 |
| `IDLE_LIGHT` | idle before `hot → light` (janitor) | 24 h |
| `IDLE_EVICT` | idle before `light → evicted` (janitor) | 14 d |
| `DISK_FREE_LOW` / `DISK_FREE_HIGH` | disk-pressure water marks (checked on-demand, no timer) | host-tuned |
| `DISK_JANITOR_ARCHIVED_WORKSPACE_DAYS` | janitor backstop for `evicted` (exists) | 30 d (prod) |

Container stop is governed by the existing `maxIdleContainers` cap, not a time
threshold, so there is no `IDLE_STOP` constant.

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
  - Force a **fresh fetch** before cloning. The call site already exists —
    `unarchiveSession` calls `cacheGit.fetchCache()` before `cloneFromCache`
    (`services/session.ts:173-174`); the only change is passing `ttlMs = 0` so the
    60s TTL can't skip it. The enforceable contract is **"the fetch actually ran
    (TTL bypassed) and did not error"** — *not* "HEAD advanced." An unchanged HEAD
    is the normal, correct case when `origin/main` simply hasn't moved since the
    last fetch; asserting advancement would spuriously fail restores on a quiet
    repo. (`fetchCache` already *logs* `advanced`/`unchanged` at
    `repo-git.ts:175-183` — keep it as a log, not an assertion.)
  - Base the new branch on the **freshly fetched** `origin/<defaultBranch>`
    (`getDefaultBranch` → `origin/main`), which is exactly the right base for a
    follow-up PR off a merged session.
  - This builds on [[157-session-branch-stale-from-main]] (the refspec fix that
    lets `fetch --all` actually advance `refs/heads/main`). 157 fixed *session
    create*; this doc extends the same guarantee to *restore*, which currently
    relies on a possibly-skipped TTL fetch.

Surfacing / failure handling: if the `fetchCache(0)` fails (offline / GitHub
down), restore **must fall through to clone-from-cache** with a **logged,
user-visible** staleness warning — not abort the restore. Note the current
retry loop (`services/session.ts:171-183`) wraps `fetchCache` + `cloneFromCache`
together and only retries on clone/lock errors; a thrown `fetchCache(0)` there
would be retried 3× and then rethrown, aborting restore. The implementation must
separate the two: a failed fetch is caught and downgraded to "serve cached
`main` + warn," while clone failures keep their retry. Same principle as 157's
"surface staleness in bootstrap."

---

## Data model changes

- **`diskTier` column** on the session row: `'hot' | 'light' | 'evicted'`,
  default `'hot'`. Replaces the disk meaning of `archived`.
- **`userArchived` column**: boolean, the explicit user "hide this" action.
  Replaces the visibility meaning of `archived`.
- **`lastViewedAt` column**: ISO timestamp bumped on viewer attach; read *only*
  by the disk-idle ladder (see Part 2). Never read by the listing predicate.
- `SessionInfo` (`domain-types.ts:64`) gains `diskTier`, `userArchived`,
  `lastViewedAt`; `archived?` is kept read-only/derived until clients migrate.

### `archived` is two meanings — split every consumer deliberately

Today `archived` is read with *two different intents*. A single derivation
formula (`diskTier === 'evicted' && userArchived`) is **wrong** because some
callers mean "hidden from the user" and others mean "workspace not on disk." Each
consumer must be reassigned explicitly:

| Caller | Current meaning | New predicate |
|---|---|---|
| `list()` filter (`sessions.ts:72`) | hidden | `visibleInSidebar` (Part 1) |
| `findAllByRemoteUrl` cache-retention (`services/session.ts:331`) | repo still referenced | **must count `evicted` sessions** as live refs — they restore via the cache. Drop the `archived = 0` filter here, or it deletes the bare cache out from under a restorable session. |
| `listMergedNotArchived[ByRemoteUrl]` (`sessions.ts:206,217`) | merged + still shown | `merged_at IS NOT NULL AND NOT userArchived` |
| `unarchiveSession` precondition (`services/session.ts:136`) | is restorable | `diskTier === 'evicted' OR userArchived` |
| child-spawn guards (`child-sessions.ts:148,476,632`) | parent/child retired | `userArchived` (an `evicted`-but-listed session can still spawn) |
| headless guard (`headless-sessions.ts:91`) | session gone | `userArchived` |
| settings/title/startup (`settings.ts:329`, `startup-tasks.ts:167`) | active | `!userArchived` |

The breadcrumb guards in `markMergedAndPruneExcess` (`services/session.ts:441-453`)
are unaffected — they gate the *listing* prune, which no longer touches disk.

### Migration (auto-archive vs user-archive can't be perfectly told apart)

Today a single `archived = 1` is written by **both** explicit user-archive **and**
the auto-prune in `markMergedAndPruneExcess` (`services/session.ts:454`); the
schema records no discriminator. Mapping *all* `archived = 1 → userArchived = 1`
is wrong: it would permanently hide every auto-pruned merged session (the one
state that force-removes from the sidebar regardless of activity), so reopening
one could never return it to Active.

Use the one fact we *do* know — **auto-prune only ever archives merged sessions**
(it iterates `listMergedNotArchivedByRemoteUrl`):

- `archived = 1 AND merged_at IS NULL` → **definitely** user-archived (auto never
  touches unmerged) → `userArchived = 1, diskTier = 'evicted'`.
- `archived = 1 AND merged_at IS NOT NULL` → **ambiguous** (auto-pruned, or a user
  who hid a merged session). Default to `userArchived = 0, diskTier = 'evicted'`
  so it follows the listing predicate: it stays out of the sidebar while idle
  (old merged, outside the top-N view cap → "Not listed"), but correctly returns
  to Active if reopened. This is the safe default — the worst case is a merged
  session the user *meant* to hide remains reachable from All Sessions, which is
  strictly better than stranding reopened work.
- `archived = 0` → `userArchived = 0, diskTier = 'hot'`.

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
