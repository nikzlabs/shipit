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

Requirements 1–4 restate that, one minute being his number. Requirement 5 is carried from
`docs/278-conditional-history-refetch` req 5, whose subject this feature changes. Requirement 6 is
the adjacent defect he asked to have fixed here.

## Requirements

1. Returning to the app after a brief absence — another browser tab, another window, the OS file
   picker — must not show the connection banner, and must not otherwise present as a
   disconnection.

2. A message composed after such a return must be sendable immediately. A brief absence must never
   leave the composer refusing to send.

3. A return after roughly a minute or more away re-establishes the connection.

4. A page that stays hidden for roughly a minute releases its connection, and takes a new one when
   the user returns. The same number governs requirements 3 and 4.

5. A connection that is kept rather than re-established must be proven alive, not assumed alive.
   The user must never be shown a working composer over a dead socket.

6. Re-establishing a connection must not abandon a handshake that is already in flight.

## Open questions

*(none)*

## Resolved questions

- **2026-09-20 — "After one minute we drop the connection": close the socket while the page is
  still hidden, or keep it open and force a fresh one only on return?**

  **Close it, at the same one minute** (req 3, 4). Nik asked why one number could not do both jobs,
  and it can.

  Three arguments were raised against closing and none survived. **Battery is a wash**: an idle
  session socket carries no application traffic, so its energy cost is the 30-second protocol ping
  (`keepalive.ts`) pulling the cellular radio out of idle — and the global SSE stream stays open
  either way on the identical cadence (`startSseKeepalive`), because that is what notifies a hidden
  tab. Closing one of the two does not change the wake pattern. **An extra reconnect on return is
  not a cost of closing**: req 3 already re-establishes the connection for any absence past a
  minute, so the handshake is paid at that threshold whether or not the socket was already shut.
  **The container is not the on-screen session's privilege**: one tab holds one session socket, for
  the session on screen (`useSessionWebSocket.ts`), and Nik moves between sessions — so protecting
  that one container from reclamation defends nothing the next switch would not surrender anyway.

  What closing does cost, once: while the socket is shut nothing pins the container, so the idle
  enforcer may reclaim it — and only when the host is over its memory budget (`idle-enforcer.ts`).
  A return then pays a container start rather than a reconnect. A plain viewer detach does not stop
  preview services (`container-session-runner.ts`, `detachViewer`); only reclamation does. Accepted
  as the price of one threshold instead of two.

  What closing buys is the polling gate: a single attached viewer anywhere keeps PR and CI polling
  running for every tracked session (`polling-global-gate.ts`), so a tab left open and hidden defeats
  a gate whose purpose is to quiesce when nobody is watching.

- **2026-09-20 — Fix the foreground retry burst in this change, or file it separately?** Nik:
  **fix it here** (req 6). The client fires extra reconnects at 0.3 s, 1.2 s and 3 s after a
  foreground, each of which tears down the handshake already in flight — on a slow cellular link
  that restarts the connection three times, which is the "reconnection takes a while" he reported
  as a separate issue.
