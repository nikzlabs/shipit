---
issue: https://linear.app/shipit-ai/issue/SHI-132
description: Make grandchild (and deeper) spawned sessions visible in the sidebar by tracking a root-ancestor id, so a brood spawned across multiple levels still groups under one top-level session.
---

# 201 — Nested Child Session Visibility

## Summary

A spawned child session can itself spawn a child (`shipit session create` is
available to every agent, including one running inside a spawned session). When
it does, that **grandchild** is invisible in the sidebar — it is reachable only
by typing its URL directly. This doc fixes that by adding a single
**root-ancestor** field (`rootSessionId`) to `SessionInfo`, keying the sidebar's
visibility filter and visual nesting off the root instead of the immediate
parent, while keeping `parentSessionId` for true lineage/provenance.

This is the fix for the deferred item flagged in
[doc 117](../117-agent-spawned-sessions/plan.md) under *"Identity and the
`parentSessionId` chain"* (a child can spawn grandchildren; v1 only walked one
level and never drew a tree).

## Problem

The invisibility is **two independent one-level assumptions**, not one bug.
Fixing either layer alone leaves the grandchild invisible.

### 1. The server visibility filter only walks one level up

`filterVisibleInSidebar()` in `src/server/orchestrator/sessions.ts:177-179`
drives what `SessionManager.list()` (line 254-258) feeds into the `session_list`
SSE broadcast:

```ts
const exemptFromCap = (s: SessionInfo): boolean =>
  parentsWithLiveChildren.has(s.id) ||
  (s.parentSessionId !== undefined && liveIds.has(s.parentSessionId));
```

A grandchild's `parentSessionId` points at the *intermediate* child. While that
middle child is live, the grandchild is exempt from the merged-session view cap.
But the moment the middle child is merged/archived, the grandchild loses its
exemption and is filtered **out of the SSE payload entirely** — it never reaches
the client. The exemption never chains to the root ancestor. This is the
insidious half: it's state-dependent, so the grandchild can appear and then
vanish when an intermediate session resolves.

### 2. The client render is one level deep

`pushTree()` in `src/client/components/SessionSidebar.tsx:916-948` buckets
children by `parentSessionId`, then renders *top-level session → its direct
children → stop*. It is **not** recursive:

- The grandchild lands in `childrenByParent[middleChildId]`.
- `pushTree` is only ever called on top-level sessions; the middle child is
  rendered as a leaf inside the parent's child loop, so its bucket is never
  read.
- The orphan-fallback (`parentInGroup`, line 901) does **not** rescue it either:
  the grandchild's parent (the middle child) *is* in the group, so it is not
  treated as orphaned and never gets the top-level fallback render.

So even when the server does send the grandchild (intermediate child still
live), the client silently drops it.

### Why not just track the chain and walk it?

The data model stores a single scalar `parentSessionId` — it is a one-step link
(doc 117 reconstructs ancestry "by walking"). Walking the chain at render time
and at filter time is possible but makes both the server filter and the client's
collapse/active-grouping logic recursive and stateful for a depth that is, in
practice, shallow. The cheaper and more honest fix is to **precompute the root
once, at spawn time**, and treat the sidebar as the two-level *visual* surface it
already is.

## Design — Option C: track root ancestor + immediate parent

Add one optional persisted field alongside the existing `parentSessionId`:

```ts
interface SessionInfo {
  // ... existing ...
  parentSessionId?: string;  // immediate parent (unchanged) — lineage/provenance
  spawnedByTurn?: string;    // unchanged
  rootSessionId?: string;    // NEW — top-level ancestor of the spawn tree
}
```

Semantics:

- A top-level (user-created) session has `rootSessionId` **undefined** (it *is*
  its own root; we don't self-reference, to keep "is this a spawned session?"
  a simple `!!parentSessionId` check and avoid a migration backfill that
  rewrites every existing row).
- A session spawned by a parent gets
  `rootSessionId = parent.rootSessionId ?? parent.id`. That is: inherit the
  parent's root if the parent is itself spawned, otherwise the parent *is* the
  root. This is computed once, at spawn, with one extra field read — no walking.

### Where each layer changes

| Concern | Today (one-level) | Option C |
|---|---|---|
| Spawn linkage | `setParentSession(child, parentId, turn)` | also stamp `rootSessionId = parent.rootSessionId ?? parent.id` |
| Server visibility exemption | exempt if immediate parent is live | exempt if **root** is live (`liveIds.has(rootId)`) or session has live descendants |
| Client nesting | bucket by `parentSessionId`, render 1 level | bucket the whole brood by `rootSessionId`, render 1 visual indent level under the root |

### 1. Spawn flow (`services/child-sessions.ts` + `graduate-session.ts`)

`spawnChildSession()` already resolves the parent `SessionInfo`
(`child-sessions.ts:169`, `const parent = sessionManager.get(parentSessionId)`).
Compute the root there and thread it through the graduation pipeline — the
linkage is **not** written directly from the spawn service; it flows through
`GraduateSessionOpts` and is persisted inside `graduateSession()`:

```ts
// child-sessions.ts — when building the graduateSession({...}) opts:
const rootSessionId = parent.rootSessionId ?? parent.id;
graduateSession(graduationDeps, {
  // ...existing opts (parentSessionId, spawnedByTurn, ...)...
  ...(rootSessionId ? { rootSessionId } : {}),
});
```

```ts
// graduate-session.ts:64 — GraduateSessionOpts gains the field:
rootSessionId?: string;   // top-level ancestor; paired with parentSessionId

// graduate-session.ts:134 — forward it to the setter:
if (parentSessionId)
  sessionManager.setParentSession(sessionId, parentSessionId, spawnedByTurn, rootSessionId);
```

`setParentSession` (`sessions.ts:631`) — today
`(id, parentSessionId, spawnedByTurn?)` — gains a fourth optional
`rootSessionId?` param and writes the new `root_session_id` column.

### 2. Server filter (`sessions.ts:170-179`)

Build a live-root set instead of (or in addition to) the
`parentsWithLiveChildren` set, and key the exemption off the root:

```ts
const liveIds = new Set<string>();
const liveRoots = new Set<string>();        // ids that are the root of some live brood
for (const s of sessions) {
  if (s.userArchived) continue;
  liveIds.add(s.id);
  if (s.rootSessionId) liveRoots.add(s.rootSessionId);
}
const exemptFromCap = (s: SessionInfo): boolean =>
  liveRoots.has(s.id) ||                                  // a root with any live descendant
  (s.rootSessionId !== undefined && liveIds.has(s.rootSessionId)); // a descendant of a live root
```

This makes the exemption depth-independent: a grandchild is exempt as long as
its **root** is live, regardless of whether the intermediate child merged. The
existing `parentSessionId`-based behavior is fully covered because a direct
child's root *is* its parent.

**Archived root with a still-live descendant.** When the root is user-archived
it drops out of `liveIds`, so its descendants lose the exemption — exactly as
today an archived *parent* stops pinning its children open (see the existing
comment at `sessions.ts:165-169`: "an archived parent shouldn't pin its children
open — the cascade has its own path"). This is intentional and not a regression:
archiving a session **cascades to its brood**, so a live descendant under an
archived root is a transient state the cascade resolves, not a steady state the
filter must special-case. Keying the exemption off the root preserves this
semantics one-for-one at any depth.

### 3. Client render (`SessionSidebar.tsx:896-948`)

Bucket by `rootSessionId` rather than `parentSessionId`, so the whole brood —
children and grandchildren — collects under one top-level session and renders at
a single indent level:

```ts
const broodByRoot = new Map<string, SessionInfo[]>();
const orphaned = new Set<string>();
for (const s of sessions) {
  const root = s.rootSessionId;
  if (!root) continue;                       // top-level session, not in a brood
  if (!sessions.some((p) => p.id === root)) {
    orphaned.add(s.id);                      // root not in this repo group → top-level fallback
    continue;
  }
  (broodByRoot.get(root) ?? broodByRoot.set(root, []).get(root)!).push(s);
}
```

`pushTree` then renders the root followed by its flat brood (still one `indented`
level). Visual depth stays at 1 — the sidebar is narrow and arbitrary-depth
indentation reads as broken; the *grouping* is correct at any depth, which is
what was missing. The brood-collapse state (`collapsedParents`) keys off the
root id. Optionally, a grandchild row can show a secondary "via <middle child>"
provenance hint sourced from `parentSessionId` (deferred; not required for
visibility).

The `getChildren` selector (`session-store.ts:618-619`) keeps its exact-match
semantics for `parentSessionId` (provenance/cards), and gains a sibling
`getBrood(rootId)` selector for the sidebar's grouping query.

### 4. Migration

Add a `root_session_id TEXT` column (nullable) with an `idx_sessions_root` index
for the brood query — **migration 24** in `src/server/shared/database.ts` (latest
is migration 23), mirroring migration 11 which added `parent_session_id` /
`spawned_by_turn`. Forward-only: SQLite can't cheaply drop a column, so a
rollback past 24 leaves the column in place harmlessly (the older code ignores
it).

**Backfill:** existing rows keep `root_session_id = NULL`. For already-spawned
sessions (those with a non-null `parent_session_id`), a one-time backfill can set
`root_session_id` by walking the existing `parent_session_id` chain to its top
**once, in the migration** (the walk is offline and bounded by the per-parent
quota, so it's cheap and runs exactly once). New spawns never walk — they read
the parent's already-resolved root. If we choose to skip the backfill, the only
cost is that *pre-existing* deep broods stay one-level until re-spawned; new
broods are correct immediately. Recommendation: do the one-time backfill so
in-flight nested sessions are fixed on deploy.

## Options considered

### Option A — fully recursive N-deep tree

Make `exemptFromCap` walk the `parentSessionId` chain to the root, and make
`pushTree` recurse (`for (const child of children) pushTree(child, target)`),
replacing the boolean `indented` with a `depth` number.

- **Pros:** models reality exactly; arbitrary nesting depth renders correctly.
- **Cons:** a narrow sidebar runs out of horizontal room past depth ~2 —
  indentation reads as broken. The brood-collapse state and the "keep parent
  Active while children live" logic both have to become recursive and stateful.
  Solves for unbounded depth that, in practice, is rare. **Rejected** as
  over-built for the surface.

### Option B — normalize the tree to two levels (re-parent at spawn)

At spawn, set `parentSessionId` itself to the **root ancestor** instead of the
immediate parent, collapsing every descendant directly under one top-level
session. Zero new field, zero UI change.

- **Pros:** the existing one-level filter and render Just Work; minimal diff.
- **Cons:** **destroys the real lineage** — you can no longer tell a child from a
  grandchild, or which intermediate session spawned what. `spawnedByTurn`
  provenance gets muddier, and the `view`/card "spawned by" link points at the
  wrong session. **Rejected** because it throws away information doc 117
  deliberately persists.

### Option C — root ancestor + immediate parent *(chosen)*

Track both: `parentSessionId` (true immediate lineage, unchanged) and
`rootSessionId` (grouping key, new). Filter and nesting key off the root;
provenance keys off the parent.

- **Pros:** fixes **both** layers; visual depth stays at 1 (what a sidebar
  wants); preserves the real relationship in data; the server exemption becomes a
  single `liveIds.has(s.rootSessionId)` check that is depth-independent — closing
  the insidious "grandchild vanishes when the middle session merges" half.
- **Cons:** one new persisted field + migration; spawn path computes the root
  (one extra field read).

## Key files

| File | Change |
|---|---|
| `src/server/shared/types/domain-types.ts` | Add `rootSessionId?: string` to `SessionInfo`. |
| `src/server/shared/database.ts` | New migration: `root_session_id TEXT` column + `idx_sessions_root` index; one-time backfill walking existing `parent_session_id` chains. |
| `src/server/orchestrator/sessions.ts` | `setParentSession` gains a `rootSessionId` param and writes the column; `fromRow`/`toRow` map it; `filterVisibleInSidebar` keys exemption off the root (`liveRoots` / `liveIds.has(rootSessionId)`); add a `findBrood(rootId)` query. |
| `src/server/orchestrator/services/child-sessions.ts` | `spawnChildSession` computes `rootSessionId = parent.rootSessionId ?? parent.id` (parent already resolved at line 169) and adds it to the `graduateSession({...})` opts. |
| `src/server/orchestrator/services/graduate-session.ts` | Add `rootSessionId?` to `GraduateSessionOpts` (line 64); destructure it (line 120); forward to `setParentSession` (line 134). |
| `src/client/components/SessionSidebar.tsx` | Bucket the brood by `rootSessionId` (whole subtree under the root, one indent level); collapse state keys off root id; orphan fallback keys off root. |
| `src/client/stores/session-store.ts` | Add `getBrood(rootSessionId)`; keep `getChildren(parentSessionId)` for provenance. |
| `src/server/orchestrator/integration_tests/agent-spawned-session.test.ts` | Extend: grandchild spawn stamps the root, grandchild stays visible after the intermediate child is archived, sidebar SSE includes the whole brood. |

## Tests

- **Linkage:** spawning from an already-spawned session stamps
  `rootSessionId = grandparent.id` (not the immediate parent); a child of a
  top-level session stamps `rootSessionId = parent.id`.
- **Filter (the regression that matters):** spawn parent → child → grandchild,
  then archive the **intermediate child**. Assert the grandchild is **still
  present** in `SessionManager.list()` output (today it drops out).
- **Render:** sidebar groups parent + child + grandchild under one top-level
  root at a single indent level; collapsing the root hides the whole brood.
- **Migration round-trip:** a row with `parent_session_id` set and
  `root_session_id` null is backfilled to the correct top ancestor on migrate;
  `append`→`load` preserves `rootSessionId`.
- **Provenance unchanged:** `getChildren(parentId)` still returns only direct
  children; the spawned-session card's "spawned by" still names the immediate
  parent.
- **Archived-root cascade:** archiving a root archives the whole brood (existing
  cascade); assert no live descendant is orphaned visible under an archived root
  after the cascade settles.
- **Migration backfill:** the migration-24 backfill is idempotent (safe to
  re-run) and chases each `parent_session_id` chain to its top exactly once,
  guarding against a cyclic link (same guard the archive cascade already uses).

## Resolved decisions

### D1 — Top-level roots store `rootSessionId` undefined (not self-referencing)

**Decision: undefined.** A top-level session leaves `root_session_id` NULL; only
spawned descendants carry a root. The decider is not "avoid a backfill" — it's
that the two queries the field feeds pull in opposite directions, and the
load-bearing one favors undefined.

**Query 1 — fetch the brood for a root.** Self-ref is tidier here:

```sql
-- undefined: root itself is NULL-tagged, so OR-in its own id (bind ?1 twice)
SELECT * FROM sessions
WHERE (id = ?1 OR root_session_id = ?1) AND user_archived = 0
ORDER BY last_used_at DESC, rowid DESC;

-- self-ref: uniform single-param index range scan on idx_sessions_root
SELECT * FROM sessions
WHERE root_session_id = ?1 AND user_archived = 0
ORDER BY last_used_at DESC, rowid DESC;
```

Self-ref wins Query 1 — one param, one index lookup vs. an index-union with the
PK. At session-table scale the difference is cosmetic.

**Query 2 — the in-memory `filterVisibleInSidebar` exemption.** This is the
load-bearing one, and self-ref *breaks* it. Under self-ref every live session's
root is itself, so `liveIds.has(s.rootSessionId)` is true for every live
session — silently exempting every non-archived resolved session from the
merged-session cap, i.e. the cap stops working. Rescuing it needs a `root === id`
discriminator smeared across every brood check:

```ts
// self-ref — needs the discriminator everywhere "is this a brood?" is asked
const exemptFromCap = (s) =>
  s.rootSessionId === s.id
    ? parentsWithLiveChildren.has(s.id)   // a root: exempt only if it has live brood
    : liveIds.has(s.rootSessionId);       // a descendant: exempt if root is live

// undefined — `rootSessionId == null` is already a crisp "not a descendant"
// signal, so only descendants tag a root and a lone session never self-exempts
const exemptFromCap = (s) =>
  liveRoots.has(s.id) ||                                  // a root WITH live brood
  (s.rootSessionId !== undefined && liveIds.has(s.rootSessionId));
```

Undefined wins Query 2 decisively: `rootSessionId == null` keeps "spawned
descendant" crisp, so the filter's brood detection never sweeps in standalone
sessions. Query 2 is load-bearing and Query 1's edge is cosmetic, so **undefined
is chosen.** It also keeps `!!parentSessionId` as the "am I spawned?" test and
avoids rewriting every existing row.

### D2 — Do the one-time backfill in migration 24

**Decision: yes, backfill.** The migration walks each existing
`parent_session_id` chain to its top once and stamps `root_session_id`, so
in-flight nested sessions become visible on deploy rather than staying
one-level until re-spawned. The walk is offline, bounded by the per-parent
quota, idempotent (re-running sets the same value), and guarded against a cyclic
link by the same visited-set the archive cascade already uses (see Migration).

### D3 — No provenance hint ("via &lt;middle child&gt;") in v1

**Decision: don't render it.** A grandchild row already nests under the correct
root, which is all the visibility fix owes the user. `parentSessionId` is still
persisted, so the hint is a pure presentation add we can ship later without a
data change. Revisit only if telemetry shows users spawning many-deep and losing
track of which intermediate session owns a grandchild.

### D4 — Ship the visibility fix without changing quotas; add a root-wide cap later

**Decision: no quota change in this work.** The per-parent quota
(`MAX_SPAWNED_SESSIONS_PER_PARENT`, default 16) is enforced via
`findChildren(parentId)` (`child-sessions.ts:176-184`), which counts only
immediate children — unchanged by this fix. Depth-independent grouping does
remove the visual ceiling that made deep fan-out self-evident (a brood can grow
16 × 16 × … while every individual parent stays under quota), but coupling a
quota change to a visibility fix conflates two concerns and risks regressing
existing spawn flows. The follow-up, tracked on SHI-132, is a **root-wide active
cap** counted over the whole brood (`findBrood(rootId).length`) — cheap once
`rootSessionId` exists — gated on telemetry showing broods growing past ~one
screen. A spawn-*depth* cap is the weaker alternative (it bounds chain length,
not total fan-out) and is not planned. Doc 117 left a depth cap as a future
item; this supersedes it with the root-wide-cap direction.
