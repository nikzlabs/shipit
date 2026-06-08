---
description: Let users pin sessions to the top of the session list, sticky across reloads and drag-reorderable within the pinned group.
issue: https://linear.app/shipit-ai/issue/SHI-48
---

# 110 — Pinned Sessions

## Summary

Let users pin sessions to the top of the session list. Pinned sessions are sticky across browser reloads, drag-reorderable within their pinned group, and remain pinned until explicitly unpinned. Conductor v0.25.3 has this and it's the most-used QoL of any session-list feature.

## Motivation

ShipIt session lists today are sorted by recent activity (last message timestamp). For users with one or two long-running sessions ("the staging-env-debug session", "the design system refactor"), the session keeps its top slot — fine. But power users juggle a half-dozen workspaces of varying staleness, and important-but-quiet sessions get pushed below archived or scratch ones.

Pinning solves this with a dedicated top section that ignores activity sort.

## Design

### State

- New per-session field: `pinnedAt?: ISO timestamp`. Stored on `SessionMetadata`.
- Sort order in the sidebar:
  1. Pinned section (sorted by `pinnedAt` descending, drag-reorderable).
  2. Unpinned active sessions (existing recency sort).
  3. Archived sessions (collapsed group, existing).

### UI

In `SessionList.tsx` (or wherever the sidebar lives — likely `Sidebar.tsx`):

- Each session row gets a pin glyph in its action menu (`PushPinIcon` from Phosphor).
- Pinned sessions show a small filled pin in the row header.
- Pinned section header: "Pinned (3)" with a horizontal rule below. Hidden when zero pins.
- Drag handle on the left edge of pinned rows to reorder within the pinned group.
- Right-click / overflow menu has "Pin" / "Unpin" / "Move to top of pins."

### Interaction with existing features

- **Status grouping** ([082-session-status-indicators](../082-session-status-indicators/plan.md)): pinned sessions still get the attention border when CI fails or merge conflicts hit. Pinning doesn't suppress signaling.
- **Archive**: archiving a pinned session unpins it. We don't carry the pin into the archived state.
- **Multi-tab**: pin updates broadcast over the global SSE channel (`/api/events`) so all tabs reorder.

### Limit

Soft cap of 10 pins. Past 10, attempting to pin shows a toast: "Limit reached — unpin a session first." The cap exists to keep the pinned section from becoming a second sort-by-recency list.

## Server pieces

- Extend `SessionMetadata` (`src/shared/types/domain-types.ts`) with `pinnedAt?: string`.
- New endpoints in `api-routes-session.ts`:
  - `POST /api/sessions/:id/pin` — sets `pinnedAt = now`.
  - `DELETE /api/sessions/:id/pin` — clears.
  - `POST /api/sessions/pin-order { ids: string[] }` — bulk reorder.
- Service: `services/session.ts` gains `pinSession`, `unpinSession`, `reorderPins`.
- Broadcast `session_metadata_update` (existing message type if available, or new) over global SSE.

## Client pieces

- Extend `session-store.ts`: actions `pinSession`, `unpinSession`, `reorderPins`. Memoized selector `getOrderedSessions(state)` that returns the canonical pinned-first ordering.
- Update sidebar component to render the pinned section header and the divider.
- Drag-and-drop with `@dnd-kit/core` (already in tree if used elsewhere; otherwise `react-aria` drag).

## Tests

`integration_tests/pinned-sessions.test.ts`:

1. Pin a session → metadata persists → bootstrap GET /sessions returns it pinned.
2. Pin two sessions, reorder → bulk endpoint returns the new order.
3. Archive a pinned session → `pinnedAt` cleared.
4. Pin a 11th session → 400 with "limit reached."
5. Multi-tab: pin in tab A → tab B's session list reorders via SSE.

Component test for the sidebar covering pinned section rendering and drag reorder.

## Key files

| File | Change |
|---|---|
| `src/shared/types/domain-types.ts` | `pinnedAt?: string` on `SessionMetadata` |
| `src/server/orchestrator/services/session.ts` | Pin/unpin/reorder |
| `src/server/orchestrator/api-routes-session.ts` | Pin routes |
| `src/server/orchestrator/sessions.ts` | Persist; broadcast on change |
| `src/shared/types/ws-server-messages.ts` | `session_metadata_update` if not present |
| `src/client/stores/session-store.ts` | Actions + ordered selector |
| `src/client/components/Sidebar.tsx` (or session list) | Pinned section, drag handle |

## Future extensions

- **Pin to the dock** — a OS-level dock badge for sessions awaiting attention, gated by pinned status.
- **Cross-repo pins** — pinned sessions from different repos appear together at the top of the global session list.
- **Hotkey jump** — `⌘1`–`⌘9` jumps to the Nth pinned session.
