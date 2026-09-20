---
issue: planning#602
title: Foreground grace window — requirements
description: A brief switch away from the app must not present as a disconnection, and must not leave the composer unable to send.
---

# 311 — Foreground grace window: requirements

The design that implements these requirements is in [`plan.md`](./plan.md).

## Where these come from

Nik, in his words: *"if I briefly switch the page, briefly switch the active tab, then I see the
reconnect banner … on mobile it's even worse. If I am attaching a file, then this triggers, and
when I go back I sometimes cannot send the message because WebSocket is not connected, especially
on cellular connection. So let's maybe set some timeout, let's say one minute. After one minute, we
drop the connection. But quick switches between tabs or windows should not look as bad as they are
now."*

Requirements 1–3 restate that. Requirement 4 is the reading of "after one minute we drop the
connection" he chose. Requirement 5 is carried from `docs/278-conditional-history-refetch` req 5,
whose subject this feature changes. Requirement 6 is the adjacent defect he asked to have fixed
here.

## Requirements

1. Returning to the app after a brief absence — another browser tab, another window, the OS file
   picker — must not show the connection banner, and must not otherwise present as a
   disconnection.

2. A message composed after such a return must be sendable immediately. A brief absence must never
   leave the composer refusing to send.

3. A return after roughly a minute or more away re-establishes the connection.

4. The connection is never closed because the page is hidden. A hidden tab keeps its connection for
   as long as it stays open.

5. A connection that is kept rather than re-established must be proven alive, not assumed alive.
   The user must never be shown a working composer over a dead socket.

6. Re-establishing a connection must not abandon a handshake that is already in flight.

## Open questions

*(none)*

## Resolved questions

- **2026-09-20 — "After one minute we drop the connection": close the socket while the page is
  still hidden, or keep it open and force a fresh one only on return?**

  **Keep it open; the one-minute rule governs the return only** (req 3, 4).

  Nik weighed it against phone battery and server memory, and both arguments came out weaker than
  they look. **Battery is a wash**: an idle session socket carries no application traffic, so the
  energy cost is the 30-second protocol ping (`keepalive.ts`) pulling the cellular radio out of
  idle — and the global SSE stream is never closed on hidden and keeps the identical 30-second
  cadence (`route-registry.ts`, `startSseKeepalive`). Closing one of the two changes the radio wake
  pattern by nothing. **The container argument is smaller than it appears**: an attached viewer is
  what blocks idle reclamation (`idle-enforcer.ts`, `viewerCount > 0`), but one tab holds exactly
  one session socket, for the session on screen (`useSessionWebSocket.ts`). Every other session is
  already a reclamation candidate, so closing this one surrenders precisely the container the user
  is about to return to, for a saving the enforcer did not need.

- **2026-09-20 — Fix the foreground retry burst in this change, or file it separately?** Nik:
  **fix it here** (req 6). The client fires extra reconnects at 0.3 s, 1.2 s and 3 s after a
  foreground, each of which tears down the handshake already in flight — on a slow cellular link
  that restarts the connection three times, which is the "reconnection takes a while" he reported
  as a separate issue.
