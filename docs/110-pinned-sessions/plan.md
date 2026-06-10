---
description: Let users pin sessions to the top of their repo group, just below the New session button, sticky across reloads and drag-reorderable within the pinned set.
issue: https://linear.app/shipit-ai/issue/SHI-48
---

# 110 — Pinned Sessions

## Summary

Let users pin sessions so they stick to the top of their repo's group in the sidebar — rendered directly **below the "New session" button** and above the regular (recency-sorted) sessions. Pinning is **per repository**: a pin sticks a session to the top of its own repo group, not to a global list. Pinned sessions are sticky across browser reloads and remain pinned until explicitly unpinned. Conductor v0.25.3 has this and it's the most-used QoL of any session-list feature.

A pin is more than an ordering hint — it makes the session **persistent**. A pinned session is exempt from the two ways a quiet session can otherwise disappear or be reclaimed automatically: the sidebar's merged-session view cap (it never silently drops out of the list) and the disk-tier idle ladder (its workspace is never auto-reclaimed). See [Persistence](#persistence-pin--never-auto-reclaimed) below — this is the core guarantee, not a side effect.

## Motivation

The sidebar already groups sessions by repository (`RepoGroup` in `SessionSidebar.tsx`): each repo gets a collapsible header, a "New session" button, then its sessions sorted active-first by `createdAt` descending (with merged/closed sessions demoted into a "Recently resolved" subgroup). For a repo with one or two long-running sessions, the important one keeps a top slot — fine. But once a repo accumulates a half-dozen sessions of varying staleness, an important-but-quiet session ("the staging-env-debug session", "the design system refactor") sinks below scratch ones.

Pinning solves this with a dedicated pinned sub-section at the top of each repo group that ignores the activity sort.

**Visual reference:** [`mockup.html`](./mockup.html) — a self-contained sidebar mock (real dark-theme tokens) showing the pinned sub-section below the New session button, the drag handle + drop indicator, the pin glyph, the "Pin to top" overflow item, and two repos with independent pins.

## Design

### State

- New per-session field: `pinnedAt?: string` (ISO timestamp). Stored on `SessionInfo` (`src/shared/types/domain-types.ts`) and persisted on the session row (`pinned_at` column). **Presence is the pin flag**; the value orders pins (most-recently-pinned first). There is no separate boolean — `pinnedAt != null` means pinned *and* persistent.
- Pinning is **per repo**: a session's pin only affects ordering **within its own repo group** (sessions are associated to a repo by their `remoteUrl` string). There is no global pinned list — the existing per-repo grouping in the sidebar is the structure pins live inside.
- Order **within a repo group**:
  1. Pinned sessions (sorted by `pinnedAt` descending, drag-reorderable).
  2. Unpinned active sessions (existing `createdAt`-descending recency sort).
  3. "Recently resolved" subgroup (existing merged/closed demotion).

Ops sessions keep their existing hardcoded "Host / Ops" group at the very top of the sidebar; pinning does not apply to them.

### UI

All changes live in `SessionSidebar.tsx`, specifically the `RepoGroup` and `SessionItem` components:

- Each session row's overflow menu (`OverflowMenu` / `DropdownMenuItem`) gains a **"Pin" / "Unpin"** item using `PushPinIcon` from Phosphor.
- A pinned session shows a small filled `PushPinIcon` in its row.
- Inside each `RepoGroup`, render a **pinned sub-section directly below the "New session" button** (the `<button>` at the top of the non-collapsed session list) and above the active sessions. When the repo has pins, show a lightweight header — a thin `PushPinIcon` + "Pinned" label (with a pin count) in the same style as the existing "Recently resolved" subheader — followed by the pinned rows. Hidden when the repo has zero pins.
- **Close the section with a divider.** Unlike "Recently resolved", the active group has no header of its own, so the last pinned row and the first active row would otherwise run together. A 1px `--color-border-primary` divider (`data-testid="pinned-divider"`) renders after the pinned rows, but only when active or resolved rows actually follow — matching the divider in `mockup.html`.
- Pinned rows are drag-reorderable within the pinned set (see Drag-and-drop below).

### Drag-and-drop (reorder within the pinned set)

New pins land on top (ordered by `pinnedAt` descending); a user can drag to set an explicit order within a repo's pinned set. This reuses the **native HTML5 drag-and-drop** the sidebar already uses for repo-group reordering — there is **no `@dnd-kit` / `react-aria` dependency** in the tree, and we don't add one.

Implementation (all in `RepoGroup`, local to one repo group):
- Each pinned row's tree is wrapped in a draggable shell, enabled only when the repo has **more than one** pinned session.
- A session-scoped MIME type, `application/x-shipit-pinned-session`, gates the drag so a stray text/file drag can't look like a pin reorder.
- `dragover` computes a before/after slot from the row's bounding-rect midpoint and renders a green drop-indicator line (the same `--color-success` line the repo reorder uses).
- `drop` splices the source id into the target slot and calls `reorderPins(repo.url, ids)`.
- On the server, `SessionManager.reorderPins(remoteUrl, ids)` rewrites `pinned_at` to a strictly-decreasing sequence anchored at `now` (so `ids[0]` sorts on top, and a later-pinned session still floats above the set). Only rows that are currently pinned *and* belong to `remoteUrl` are touched, so a stale/cross-repo id is ignored.

## Persistence (pin = never auto-reclaimed)

The reason a pin is worth more than a sort key: ShipIt automatically reclaims and de-clutters quiet sessions, and a pin opts a session **out of every automatic path that could make it disappear or lose its workspace.** This is the load-bearing part of the feature.

**What auto-reclaim looks like today (docs/161).** ShipIt deliberately decoupled "hide from sidebar" from "reclaim disk" — there is **no automatic *archiving*** (a merge only sets `mergedAt` for sort ranking; `userArchived` is only ever set by an explicit user action). But two automatic mechanisms still act on a quiet session:

1. **Sidebar view cap** (`filterVisibleInSidebar` in `sessions.ts`). Once a repo has more than `MAX_MERGED_SESSIONS_PER_REPO` (3) resolved (merged/closed) sessions, the older ones silently drop out of the sidebar. This is the "visual archive" a user notices — the session is still on disk, just not listed.
2. **Disk-tier idle ladder** (`escalateDiskTiers` → `canAutoDescend` in `disk-janitor.ts`). An idle session is demoted `hot → light` (drops `node_modules`, ~24h idle) → `evicted` (**wipes the entire workspace checkout**, 14d unmerged / 2d merged, or sooner under disk pressure). Eviction discards uncommitted work. The only existing guards skip *running* or *currently-viewed* sessions — a quiet pinned session would be evicted.

**The guarantee.** A pinned session (`pinnedAt` set) is exempt from both:

- **Always visible.** `filterVisibleInSidebar` treats a pin like the existing parent/child exemption: a pinned session is never dropped by the merged view cap. It stays listed (and, per the ordering rule above, pinned-first) regardless of how many resolved sessions its repo accumulates.
- **Never auto-reclaimed.** `canAutoDescend` returns `false` for a pinned session, which is the single chokepoint for *both* the age-based descent and the disk-pressure LRU descent. A pinned session therefore stays at its current tier (normally `hot`) and its workspace is never wiped by the janitor. (Pinning does not retroactively re-clone an already-reclaimed session; the guarantee is forward-looking. Selecting a reclaimed session still restores it the normal way.)
- **Defense-in-depth in the sweeps.** The disk-janitor's one-shot sweeps (orphan volumes/networks, archived-workspace deletion, merged-branch pruning, orphan credential dirs) only ever act on `diskTier === 'evicted'` / archived sessions, so a pinned session is already unreachable by them transitively. We add an explicit `pinnedAt` skip to the archived-workspace and credential sweeps anyway, so the invariant is stated in code rather than relied upon two hops away.

**What a pin deliberately does *not* exempt.** Idle **container** disposal (`idle-enforcer.ts`) still applies to pinned sessions. Stopping an idle container is non-destructive — the workspace stays on disk (the pin already guarantees that), and the container restarts transparently on the next attach. Exempting it would keep a container resident in RAM forever per pin and would override the enforcer's memory-pressure safety valve. "Persistent" here means the session's **data and its place in the list** survive, not that a container is kept hot. (If we later want true always-warm pins, that's a separate, opt-in escalation — noted under Future extensions.)

**Invariant: archive clears the pin.** An explicit user archive (`SessionManager.archive`) sets `pinned_at = NULL` in the same update that sets `user_archived = 1` / `disk_tier = 'evicted'`. A session is never simultaneously *hidden* and *persistent*; this also keeps the sweep guards sound (an evicted session is never pinned).

### Interaction with existing features

- **Status grouping** ([082-session-status-indicators](../082-session-status-indicators/plan.md)): pinned sessions still get the attention border when CI fails or merge conflicts hit. Pinning doesn't suppress signaling.
- **Recently resolved** (docs/161): if a pinned session's PR merges/closes, it stays in the pinned sub-section — an explicit pin outranks the automatic resolved-demotion (see [Persistence](#persistence-pin--never-auto-reclaimed)), the same way a parent with visible children stays Active.
- **Archive**: archiving a pinned session clears `pinnedAt` (see the invariant above). We don't carry the pin into the archived state. (Archive already cascades to spawned children; the pin clear is part of the same metadata update.)
- **Multi-tab**: a pin change re-broadcasts the canonical `session_list` over the per-session WebSocket / global event stream so every viewer re-derives the ordering. (There is no `session_metadata_update` delta message today; `session_list` is the established full-list update used after rename/archive/unarchive, so reuse it rather than inventing a delta type.)

### No limit

There is **no cap** on the number of pins. An earlier draft proposed a soft cap of 10; it's been dropped. Pins are per-repo and the user controls them explicitly, so a cap only adds a failure mode (a toast to dismiss, an edge case to test) without protecting anything — a user who pins everything in a repo has simply chosen a manual order for that group, which is a legitimate use, not a misuse to guard against.

## Server pieces

- Extend `SessionInfo` (`src/shared/types/domain-types.ts`) with `pinnedAt?: string`; add the `pinned_at` column to `SessionRow` + `fromRow` (`sessions.ts`) and a `database.ts` migration (`ALTER TABLE sessions ADD COLUMN pinned_at TEXT`). (Persistence is via direct SQL `UPDATE`s; there is no `toRow`.)
- `SessionManager` (`src/server/orchestrator/sessions.ts`):
  - `setPinned(id, pinnedAt: string | null)` — set or clear `pinned_at`, returning the updated `SessionInfo` (mirrors `rename`). Forward-looking: it does **not** touch `disk_tier` (flipping an evicted session to `hot` without a re-clone would lie about the checkout).
  - `archive(id)` also sets `pinned_at = NULL` (the archive-clears-pin invariant).
  - `filterVisibleInSidebar` exempts pinned sessions from the merged view cap.
- **Persistence guards** (the immunity from [Persistence](#persistence-pin--never-auto-reclaimed)):
  - `disk-janitor.ts` → `canAutoDescend`: `if (s.pinnedAt) return false;` — blocks age-based *and* disk-pressure descent at the single chokepoint.
  - `disk-janitor.ts` sweeps: defensive `pinnedAt` skip in the archived-workspace and orphan-credential sweeps.
  - `SessionManager.reorderPins(remoteUrl, ids)` — rewrite `pinned_at` so the repo's pins match `ids` (top-first), touching only currently-pinned rows in that repo.
- New routes in `api-routes-session.ts`, mirroring rename (`PATCH /api/sessions/:id`) / archive (`DELETE /api/sessions/:id`):
  - `POST /api/sessions/:id/pin` — sets `pinnedAt = now`.
  - `DELETE /api/sessions/:id/pin` — clears `pinnedAt`.
  - `POST /api/sessions/pin-order { remoteUrl, ids }` — reorder a repo's pins.
- Service layer: `services/session.ts` gains `setSessionPinned` and `reorderSessionPins` (pure functions over `SessionManager`, returning the updated `SessionInfo` and/or refreshed list, same shape as `renameSession`).
- After each mutation, broadcast the full `session_list` (route handlers already call `deps.sseBroadcast("session_list", { sessions })` after unarchive/child-archive — follow that).

## Client pieces

- Extend `session-store.ts` with optimistic `setPinned(sessionId, pinned)` (mirrors `setAutoFixCiPaused`) and `reorderPins(remoteUrl, ids)` actions that call the new endpoints; the authoritative `session_list` SSE broadcast reconciles. Session-list ordering is computed inside the `SessionSidebar` memo (not a store selector); the `RepoGroup` partitions pinned rows out of the active list.
- Update `RepoGroup` in `SessionSidebar.tsx` to render the pinned sub-section (header + rows) directly below the "New session" button, add the Pin/Unpin overflow item + pinned glyph (`PushPinIcon`) to `SessionItem`, and wrap pinned rows in draggable shells (native HTML5 DnD) for reordering.

## Tests

`integration_tests/pinned-sessions.test.ts`:

1. Pin a session → `pinnedAt` persists → `GET /api/sessions/all` returns it with `pinnedAt` set; unpin clears it.
2. Archive a pinned session → `pinnedAt` is cleared (the invariant).
3. Pin sessions across two different repos → each pin only affects its own repo's ordering (no global list).
4. `reorderPins` / `POST /api/sessions/pin-order` rewrites `pinned_at` to match the requested order, and ignores stale/cross-repo ids.
5. Multi-tab / multi-viewer: pinning re-broadcasts `session_list` so other viewers re-derive the order.

**Persistence (the core guarantee), in `sessions.test.ts` / `disk-janitor.test.ts`:**

5. **Visibility immunity** — a repo with > `MAX_MERGED_SESSIONS_PER_REPO` merged sessions, one of them pinned: `filterVisibleInSidebar` keeps the pinned one even though it would otherwise fall past the cap.
6. **Eviction immunity** — `escalateDiskTiers` over an ancient, idle, pinned session leaves its `diskTier` untouched (no `hot → light`, no `light → evicted`), including under simulated disk pressure. The same session unpinned *does* descend (proves the guard is what's protecting it).

Component tests for `SessionSidebar` / `RepoGroup`: the pinned sub-section renders below the "New session" button; pinned rows sort ahead of active rows; rows are draggable only with > 1 pin; a simulated drag-drop calls `reorderPins` with the new id order.

## Key files

| File | Change |
|---|---|
| `src/shared/types/domain-types.ts` | `pinnedAt?: string` on `SessionInfo` |
| `src/server/shared/database.ts` | Migration: `ALTER TABLE sessions ADD COLUMN pinned_at TEXT` |
| `src/server/orchestrator/sessions.ts` | `SessionRow.pinned_at` + `fromRow`; `setPinned`; `reorderPins`; `filterVisibleInSidebar` pin exemption; clear `pinned_at` in `archive` |
| `src/server/orchestrator/disk-janitor.ts` | `canAutoDescend` pin guard (eviction immunity); defensive pin skip in archived-workspace + credential sweeps |
| `src/server/orchestrator/services/session.ts` | `setSessionPinned`, `reorderSessionPins` |
| `src/server/orchestrator/api-routes-session.ts` | `POST`/`DELETE /api/sessions/:id/pin`, `POST /api/sessions/pin-order`; `session_list` broadcast |
| `src/client/stores/session-store.ts` | `setPinned` + `reorderPins` optimistic actions |
| `src/client/components/SessionSidebar.tsx` | Pinned sub-section in `RepoGroup` (below New session); Pin/Unpin overflow item + glyph in `SessionItem`; native-DnD reorder of pinned rows |

## Future extensions

- **Always-warm pins** — an opt-in escalation where a pin *also* exempts the session from idle container disposal (`idle-enforcer.ts`), keeping the container resident. Deliberately out of scope for the base feature (RAM cost, memory-pressure safety) — see the "does not exempt" note under Persistence.
- **Pin to the dock** — an OS-level dock badge for sessions awaiting attention, gated by pinned status.
- **Hotkey jump** — `⌘1`–`⌘9` jumps to the Nth pinned session in the active repo group.
