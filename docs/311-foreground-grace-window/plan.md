---
issue: planning#602
title: Foreground grace window — design
description: Keep a foregrounded socket that answers a ping, force a fresh one only after a minute away, and stop the retry burst killing handshakes in flight.
---

# 311 — Foreground grace window: design

Implements [`requirements.md`](./requirements.md). Requirements are cited as `(req N)`.

## The path being fixed

`useForegroundSignal` fires on every resume — `visibilitychange` → visible, `pageshow`, `online`,
and a `focus` classified as external. `useWebSocket.reconnectForForeground` answers it by throwing
the current socket away and opening a fresh one, **unconditionally and however brief the absence**.
The fresh socket drives `status` through `connecting`, which is what raises the banner 1.5 s later
(`ConnectionBanner.tsx`) and what makes `send()` return `false` — the mobile file-picker failure,
since the picker backgrounds the page and the return lands the user on a socket that is still
connecting (req 1, req 2).

That teardown is not gratuitous. A mobile OS kills a backgrounded TCP connection without telling
the JS layer, so `readyState` keeps reading `OPEN` over a socket that will never deliver another
byte. Waiting for a `close` that never fires strands the UI on stale data until a page reload,
which is why the recovery was driven by page-lifecycle events rather than by the connection looking
unhealthy.

So the fix cannot be "skip the reconnect when the socket looks open": that is exactly the answer
that lies. It has to **stop trusting `readyState` and start proving liveness** (req 5).

## The design

### An application-level probe, because the transport-level one is not ours

On a resume, the client sends `{ type: "ping", id }` on the existing socket and waits
`PROBE_TIMEOUT_MS` (2 s) for evidence of life. Protocol-level WebSocket pings cannot serve here —
they are server-initiated and the browser answers them beneath JS, so a page has no way to send one
or observe one.

**Any inbound frame settles the probe alive**, not only the matching pong: bytes arriving from the
server prove the path works, whatever they say. The pong exists so that a server with nothing to
say still produces one. The pong frame is consumed inside `useWebSocket` and never reaches
`dispatchMessage`, because it is transport bookkeeping and not a message the app has any business
seeing.

- Probe answers within the window → **keep the socket**. `status` never leaves `open`, so there is
  no banner, no `historyLoaded` reset, no refetch, no attach burst, and `send()` keeps working
  throughout (req 1, req 2).
- Probe times out → **force a fresh socket**, which is exactly today's behaviour, delayed by up to
  2 s.

**`send()` refuses while a probe is pending**, because req 5 is about the composer and not only
about the transcript. The probe runs on the existing socket while it still reads `OPEN`, so without
this a message sent in that window is written to a socket that may already be dead — and its
`true` return is exactly what a caller shows a confirmation on, so the composer would clear the
text and leave an optimistic bubble over a message that never went anywhere. Refusing keeps the
existing honest failure: `MessageInput` returns early on a refused send and keeps the text and
attachments (docs/293 req 4), and the user retries into a socket that has since answered.

The wait that costs is one round trip, not the probe's timeout, and the resume fires the moment the
tab is shown — before a hand can reach the send button. Against what this replaces it is strictly
shorter: the socket used to be thrown away on every return, so the same send was refused for a
whole handshake.

### One minute, applied in the two places the page can be away

`AWAY_LIMIT_MS` is a single number doing one job — "this absence was long enough that the socket is
no longer worth keeping" — in the two shapes an absence takes.

**Visible but unfocused** (another application on the desktop; the page never hides) — the number
is the *trust cap*. Under it, probe and keep; over it, force a fresh socket without probing, which
is cheaper than probing and then replacing it anyway (req 3). Away time is measured from the
evidence that the page left — `visibilitychange` → hidden, `pagehide`, `freeze`, or a `blur`
classified as external — and `useForegroundSignal` hands it over as `onForeground({ awayMs })`. An
absence it could not measure (`awayMs` `undefined` — a `pageshow` or `online` with nothing before
it) probes rather than forces: the probe is the cheaper answer and it is correct either way.

**Hidden** — the number is the *release timer* (req 4). `useForegroundSignal` gains an `onAway`
callback, fired from the same evidence that already marked the page backgrounded, so there is still
one listener set rather than a second hand-rolled one. `useWebSocket` arms the timer there and
disarms it on resume; the callback re-checks `document.hidden` at fire time, so evidence that
turned out not to mean "hidden" releases nothing.

The release closes the socket without scheduling backoff — a socket given up on purpose must not
reconnect itself behind a hidden page — and the resume then finds nothing to keep, so req 3's fresh
connection falls out of req 4 rather than being a second rule.

A socket **opened while the page is already hidden** gets no `onAway` of its own: nothing hid, it
was born hidden. So the connect effect arms the release itself when `document.hidden`, which covers
both a session loaded into a background tab and a session switched to while hidden — the latter
otherwise cancelling the previous socket's timer and arming nothing. Without it those sockets hold
the viewer and the polling gate for the life of the tab, which is the whole thing req 4 is for.

**SSE is not released.** It is what tells a hidden tab that the agent finished or wants permission:
`activeRunnerSessions` and `awaitingPermissionSessions` are both SSE-fed (`useServerEvents.ts`), and
`useNotification` only fires while `document.hidden`. Releasing it would mute exactly the case it
exists for — and it is also why the battery argument cannot be won by closing the WebSocket: the
30-second keepalive cadence continues on the stream that stays.

### The retry burst only fires at a handshake old enough to be stalled

`reconnectForForeground` schedules extra reconnects at 300 ms, 1200 ms and 3000 ms, each of which
calls `openFreshSocket()` whenever the socket is not yet `OPEN`. A socket still `CONNECTING` is not
`OPEN`, and `openFreshSocket` re-runs the connect effect, whose cleanup closes the current socket —
so on any link where a handshake takes longer than 300 ms, which is every cellular link, the burst
**destroys the handshake it is waiting for**, three times, before backoff gets its own attempt
(req 6).

The burst exists for one case the backoff loop genuinely cannot cover: a socket that sits in
`CONNECTING` forever and never fires `close`, which is what a mobile radio that has not finished
waking produces. Everything else already reconnects through `onclose` → backoff. So the rule
becomes: **retry only against a handshake that has been in flight long enough to be considered
stalled.** The socket records `connectStartedAt` when it is created; a retry fires only if the
socket is not `OPEN` *and* the current attempt is at least `STALLED_HANDSHAKE_MS` (3 s) old, and
the delays move to 3 s / 9 s.

### SSE keeps reconnecting unconditionally

`useServerEvents` shares the same foreground signal and is deliberately left alone. `EventSource`
is unidirectional, so there is no probe to send; and its keepalive is an SSE comment, which the
browser never surfaces to JS, so the client cannot observe liveness at all. Its reconnect also
costs the user nothing visible — no banner, no composer gating. The two connections still listen
to the same signal set on the same terms; only the WebSocket can answer "are you alive", so only it
acts on the answer.

## Key files

| File | Change |
|---|---|
| `src/client/hooks/useForegroundSignal.ts` | Track away-since; hand `{ awayMs }` to `onForeground`; `onAway`. |
| `src/client/hooks/useWebSocket.ts` | Probe, grace decision, hidden release, `connectStartedAt`, stalled-handshake retry rule. |
| `src/server/shared/types/ws-client-messages.ts` | `WsPing`. |
| `src/server/shared/types/ws-server-messages/misc.ts` | `WsPong`. |
| `src/server/orchestrator/route-registry.ts` | `ping` → `pong`, answered before any session work. |
| `docs/278-conditional-history-refetch/requirements.md` | Req 5 no longer holds; restated. |

## What this does not change

- A resume that finds the socket already `closed` or in backoff reconnects immediately, as today —
  there is nothing to probe.
- A detached viewer never stops the session's worker resources or its preview services
  (`detachViewer`). A released socket only makes the container *eligible* for reclamation, which
  still happens solely under memory pressure and never while the agent is busy.
- The history refetch path (`docs/278`) is untouched. A kept socket never resets `historyLoaded`,
  so the conditional refetch simply stops being reached on short switches.
