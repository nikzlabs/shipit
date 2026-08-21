---
issue: planning#461
title: Mute a session — design
description: How a mute is stored, what it suppresses, who may set it, and what clears it.
---

# 277 — Mute a session: design

**Requirements:** [`requirements.md`](./requirements.md) — human-owned, the
source of truth for what this does. Numbers like (req 4) point there.

## Shape of the change

"Needs attention" has exactly one definition in this product:
`computeAttentionReason()` (`src/client/hooks/useAttentionInfo.ts`), which the
row marker, the row tooltip, the docs/260 "Needs you" view and its count, and
the notification watcher all call (docs/260 req 9). So a mute is **one more
input to that one function**, returning `null` before every other branch.

Nothing else has to learn about muting: the amber row marker, the "Needs you"
count and list, the browser notification and the voice note all go quiet
together (req 2), because all five read the same result. That is also why req 8
("no mute mark on the row") costs nothing — a muted row is, to every one of
those surfaces, a row with nothing pending.

## Where the mute lives

A `muted_at` column on `sessions` (ISO instant, `NULL` = not muted), surfaced as
`SessionInfo.mutedAt` (req 7). Presence is the flag; the value is kept because
it is free and answers "since when" if a later surface wants it — the same shape
as `pinned_at` (docs/110).

`setMuted()` compares the flag's **presence**, not the stored instant, so
re-muting an already-muted session is a genuine no-op. Comparing values instead
rewrites the timestamp on every call and reports a change nobody asked for —
which also makes the "nothing changed" path pass or fail on whether two calls
land in the same millisecond.

Server-side storage is what makes the mute survive a reload and match on a
phone and a laptop. It also puts the flag where the *turn* can clear it: the
clearing event happens on the server, in a turn that may have been started by
something other than a browser.

## What clears it

`executeAgentTurn()` (`turn-executor.ts`) already calls
`sessionManager.track(sessionId)` on **every started turn** — the WS path and
the dispatched path (`shipit session message`, the CI-fix loop, a merge-wake, a
queue drain) both funnel through it. The mute is cleared on the same line
(req 4), then `session_list` is broadcast so every attached sidebar drops the
mute at once.

The broadcast is conditional on the session actually being muted, so the
ordinary turn adds no SSE traffic. Clearing at turn *start* rather than turn
*end* is req 4's plain reading and also the useful one: a session that has begun
working again is no longer the "work I'm not going to pick up" the mute
describes.

## Who may set it

Req 6 has two halves, and they are enforced in different places because only one
of them is a server-side fact:

- **"its agent is not working"** — the server owns this and refuses (409) a mute
  on a session whose runner is running, is holding a permission prompt
  (`awaitingPermissionIds`, where the agent *is* running, held inside the gated
  tool call) or is holding background work. A client that asks anyway is wrong,
  and this is the half that could otherwise race a turn that started a
  millisecond ago.
- **"is asking for the user's attention"** — attention is derived in the browser
  from PR/CI state the server does not hold in that form, so the **menu item's
  presence** is the enforcement: `SessionItem` offers "Mute" only when
  `useAttentionInfo` returns a reason, and "Unmute" only when the session is
  muted. The server does not re-derive attention; duplicating that derivation
  server-side would create the second definition docs/260 req 9 exists to
  prevent.

The menu item flips to "Unmute" on a muted row (req 5). It has to: muting makes
the session stop needing attention, so a control gated *only* on "needs
attention" would vanish at the moment it was used and leave no way back.

## Key files

| File | Change |
|---|---|
| `src/server/shared/database.ts` | Migration: `sessions.muted_at TEXT`. |
| `src/server/orchestrator/sessions.ts` | `muted_at` on `SessionRow`, row→`mutedAt` mapping, `setMuted()`. |
| `src/server/shared/types/domain-types/session.ts` | `SessionInfo.mutedAt`. |
| `src/server/orchestrator/services/session.ts` | `setSessionMuted()` — the agent-not-working gate. |
| `src/server/orchestrator/api-routes-session-crud.ts` | `PUT /api/sessions/:id/muted`. |
| `src/server/orchestrator/turn-executor.ts` | Clear the mute at turn start + broadcast. |
| `src/client/stores/session-store.ts` | `setMuted()` action, optimistic with rollback. |
| `src/client/hooks/useAttentionInfo.ts` | `muted` input; `return null` first. |
| `src/client/hooks/useAttentionSessions.ts`, `useAttentionNotifications.ts` | Pass `muted` through. |
| `src/client/components/SessionSidebar/SessionItem.tsx` | The Mute / Unmute menu item. |

## Design choices the requirements do not settle

- **No expiry.** A mute ends at the next turn (req 4) or by hand (req 5) and
  never on a timer. "Work I don't plan to do in the near future" has no duration
  the product could guess.
- **Archiving clears nothing.** Archive already removes the row from attention
  (`useAttentionSessions` skips archived sessions), so a stale `muted_at` on an
  archived session is invisible; restoring it and taking a turn clears it.
- **The mute is not a sidebar group.** It changes no ordering and no grouping —
  req 3 says a muted session is otherwise unchanged.
