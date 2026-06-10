---
description: Let users pin sessions to the top of their repo group, just below the New session button, sticky across reloads and drag-reorderable within the pinned set.
issue: https://linear.app/shipit-ai/issue/SHI-48
---

# 110 — Pinned Sessions

## Summary

Let users pin sessions so they stick to the top of their repo's group in the sidebar — rendered directly **below the "New session" button** and above the regular (recency-sorted) sessions. Pinning is **per repository**: a pin sticks a session to the top of its own repo group, not to a global list. Pinned sessions are sticky across browser reloads, drag-reorderable within their pinned set, and remain pinned until explicitly unpinned. Conductor v0.25.3 has this and it's the most-used QoL of any session-list feature.

## Motivation

The sidebar already groups sessions by repository (`RepoGroup` in `SessionSidebar.tsx`): each repo gets a collapsible header, a "New session" button, then its sessions sorted active-first by `createdAt` descending (with merged/closed sessions demoted into a "Recently resolved" subgroup). For a repo with one or two long-running sessions, the important one keeps a top slot — fine. But once a repo accumulates a half-dozen sessions of varying staleness, an important-but-quiet session ("the staging-env-debug session", "the design system refactor") sinks below scratch ones.

Pinning solves this with a dedicated pinned sub-section at the top of each repo group that ignores the activity sort.

## Design

### State

- New per-session field: `pinnedAt?: string` (ISO timestamp). Stored on `SessionInfo` (`src/shared/types/domain-types.ts`) and persisted on the session row.
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
- Inside each `RepoGroup`, render a **pinned sub-section directly below the "New session" button** (the `<button>` at the top of the non-collapsed session list) and above the active sessions. When the repo has pins, show a lightweight header — a thin `PushPinIcon` + "Pinned" label in the same style as the existing "Recently resolved" subheader — followed by the pinned rows. Hidden when the repo has zero pins.
- Pinned rows are drag-reorderable within the pinned set (see Drag-and-drop below).

### Drag-and-drop

The sidebar already implements **native HTML5 drag-and-drop** for reordering repo groups (custom MIME type `application/x-shipit-repo`, drop-position indicator line, `reorderRepos()` → `PUT /api/repos`). There is **no `@dnd-kit` / `react-aria` dependency** in the tree, and we should not add one.

Reuse the native-DnD pattern already in `SessionSidebar.tsx` for reordering pinned rows: a session-scoped MIME type (e.g. `application/x-shipit-pinned-session`) gates the drag, a drop indicator line marks the target slot, and dropping calls a new reorder action that persists the new pinned order. Keep drag enabled only when a repo has more than one pinned session.

### Interaction with existing features

- **Status grouping** ([082-session-status-indicators](../082-session-status-indicators/plan.md)): pinned sessions still get the attention border when CI fails or merge conflicts hit. Pinning doesn't suppress signaling.
- **Recently resolved** (docs/161): if a pinned session's PR merges/closes, it stays in the pinned sub-section — an explicit pin outranks the automatic resolved-demotion, the same way a parent with visible children stays Active.
- **Archive**: archiving a pinned session clears `pinnedAt`. We don't carry the pin into the archived state. (Archive already cascades to spawned children; the pin clear is part of the same metadata update.)
- **Multi-tab**: a pin change re-broadcasts the canonical `session_list` over the per-session WebSocket / global event stream so every viewer re-derives the ordering. (There is no `session_metadata_update` delta message today; `session_list` is the established full-list update used after rename/archive/unarchive, so reuse it rather than inventing a delta type.)

### No limit

There is **no cap** on the number of pins. An earlier draft proposed a soft cap of 10; it's been dropped. Pins are per-repo and the user controls them explicitly, so a cap only adds a failure mode (a toast to dismiss, an edge case to test) without protecting anything — a user who pins everything in a repo has simply chosen a manual order for that group, which is a legitimate use, not a misuse to guard against.

## Server pieces

- Extend `SessionInfo` (`src/shared/types/domain-types.ts`) with `pinnedAt?: string`, and add the corresponding column to the session row in `sessions.ts` (`SessionRow` + `toRow`/`fromRow`).
- `SessionManager` (`src/server/orchestrator/sessions.ts`) gains setters following the existing `rename`/`archive` shape:
  - `setPinned(id, pinnedAt: string | null)` — set or clear `pinnedAt`.
  - `reorderPins(remoteUrl, ids: string[])` — rewrite `pinnedAt` for the given sessions so their relative order matches `ids` (scoped to one repo).
- New routes in `api-routes-session.ts`, mirroring the rename (`PATCH /api/sessions/:id`) / archive (`DELETE /api/sessions/:id`) patterns:
  - `POST /api/sessions/:id/pin` — sets `pinnedAt = now`.
  - `DELETE /api/sessions/:id/pin` — clears `pinnedAt`.
  - `POST /api/sessions/pin-order { remoteUrl, ids: string[] }` — reorder a repo's pins.
- Service layer: `services/session.ts` gains `pinSession`, `unpinSession`, `reorderPins` (pure functions over `SessionManager`, returning the updated `SessionInfo`/list, same as `renameSession`).
- After each mutation, broadcast the full `session_list` (the route handlers already call `deps.sseBroadcast("session_list", { sessions })` after unarchive/child-archive — follow that). `archiveSession` must clear `pinnedAt` as part of its existing metadata update.

## Client pieces

- Extend `session-store.ts` with actions `pinSession`, `unpinSession`, `reorderPins` that call the new endpoints. Session-list ordering is currently computed inside the `SessionSidebar` memo (not a store selector); keep it there and fold the pinned-first ordering into that per-repo computation.
- Update `RepoGroup` in `SessionSidebar.tsx` to render the pinned sub-section (header + rows) directly below the "New session" button, and add the Pin/Unpin overflow item + pinned glyph to `SessionItem`.
- Reuse the existing native HTML5 drag-and-drop pattern (no new dependency) to reorder pinned rows within a repo group.

## Tests

`integration_tests/pinned-sessions.test.ts`:

1. Pin a session → `pinnedAt` persists → `GET /api/sessions/all` returns it with `pinnedAt` set.
2. Pin two sessions in the same repo, reorder via `POST /api/sessions/pin-order` → the reorder endpoint rewrites their `pinnedAt` to the requested order.
3. Archive a pinned session → `pinnedAt` is cleared.
4. Pin sessions across two different repos → each pin only affects its own repo's ordering (no global list).
5. Multi-tab / multi-viewer: pinning re-broadcasts `session_list` so other viewers re-derive the order.

Component test for `SessionSidebar` / `RepoGroup` covering: the pinned sub-section renders below the "New session" button, pinned rows sort ahead of active rows within a repo group, and the pinned set drag-reorders.

## Key files

| File | Change |
|---|---|
| `src/shared/types/domain-types.ts` | `pinnedAt?: string` on `SessionInfo` |
| `src/server/orchestrator/sessions.ts` | `SessionRow` column + `setPinned`/`reorderPins`; clear `pinnedAt` on archive |
| `src/server/orchestrator/services/session.ts` | `pinSession`/`unpinSession`/`reorderPins` |
| `src/server/orchestrator/api-routes-session.ts` | Pin / unpin / pin-order routes; `session_list` broadcast |
| `src/client/stores/session-store.ts` | `pinSession`/`unpinSession`/`reorderPins` actions |
| `src/client/components/SessionSidebar.tsx` | Pinned sub-section in `RepoGroup` (below New session); Pin/Unpin overflow item + glyph in `SessionItem`; reuse native DnD for pin reorder |

## Future extensions

- **Pin to the dock** — an OS-level dock badge for sessions awaiting attention, gated by pinned status.
- **Hotkey jump** — `⌘1`–`⌘9` jumps to the Nth pinned session in the active repo group.
