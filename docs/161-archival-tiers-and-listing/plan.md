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

"Idle age" means `now - Date.parse(lastUsedAt)`. `lastUsedAt` is bumped at turn
start and end; we additionally bump it on **viewer attach**, so reopening a
session resets the ladder.

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
- **No uncommitted / unpushed work** — workspace clean **and** branch tip present
  in the bare cache. Required only for `evicted` (the destructive rung); if dirty,
  auto-commit + push to the session branch first so nothing is silently lost.
  `light` doesn't need this guard — it preserves the tree. *(new)*
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
